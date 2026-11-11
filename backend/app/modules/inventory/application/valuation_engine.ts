import { ApiError } from '#shared/http/api_error'
import type { TenantScope } from '#modules/tenancy/index'
import type { PostingLine, PostingType } from '#modules/inventory/domain/stock'
import {
  averageOut,
  consumeLayers,
  divRound,
  lineValue,
  moneyText,
  ValueQueue,
  VALUED_BUCKETS,
  type LayerState,
  type ValuationMethod,
} from '#modules/inventory/domain/valuation'
import { quantityText } from '#modules/inventory/domain/stock'

/*
 * Motor de valorização (8.9). Corre dentro do lançamento de stock, depois dos movimentos: para cada entidade legal,
 * produto e variante (e lote, no custo específico), a variação de quantidade valorizada (livre, bloqueado,
 * quarentena, trânsito) gera entradas no livro de custo. Saídas: ao custo médio, consumindo camadas FIFO ou as do
 * lote. Entradas: custo indicado; o valor que saiu no mesmo lançamento (transferência entre entidades); o custo do
 * documento original (devolução); o custo actual; zero. Um estorno anula exactamente as entradas do original. O livro é
 * só de acréscimo e os saldos de custo e as camadas derivam dele (gatilho): nada do passado é recalculado.
 */

const big = (v: unknown) => {
  const s = String(v ?? '0')
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  return neg ? -n : n
}
const cents = (v: unknown) => {
  const s = String(v ?? '0')
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2))
  return neg ? -n : n
}

interface Entry {
  le: string
  productId: string
  variantId: string | null
  lotId: string | null
  layerId: string | null
  method: ValuationMethod
  source: string
  quantity: bigint
  value: bigint
}

export interface ValuationContext {
  postingId: string
  type: PostingType
  occurredAt: Date
  lines: PostingLine[]
  reversalOf?: string | null
  /** Devolução: lançamentos do documento original (a saída/entrada é ao custo de então). */
  returnOfPostingIds?: string[]
}

async function insertEntries(scope: TenantScope, postingId: string, at: Date, entries: Entry[]) {
  const { tenantId, userId } = scope.context
  for (const e of entries) {
    if (e.quantity === 0n && e.value === 0n) continue
    try {
      await scope.trx.rawQuery(
        `insert into stock_valuation_entries (tenant_id, posting_id, legal_entity_id, product_id, variant_id, lot_id,
            layer_id, method, source, quantity, value, occurred_at, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          postingId,
          e.le,
          e.productId,
          e.variantId,
          e.lotId,
          e.layerId,
          e.method,
          e.source,
          quantityText(e.quantity),
          moneyText(e.value),
          at,
          userId,
          userId,
        ] as never[]
      )
    } catch (error) {
      if (/stock_cost_(pools|layers)_/.test(String((error as Error).message)))
        throw ApiError.conflict(
          'VALUATION_INCONSISTENT',
          'O custo do stock não acompanha a quantidade (stock sem valor no livro): corrija com um ajuste de custo.'
        )
      throw error
    }
  }
}

async function newLayer(
  scope: TenantScope,
  e: Omit<Entry, 'layerId' | 'source' | 'method'>,
  postingId: string,
  at: Date
) {
  const r = await scope.trx.rawQuery(
    `insert into stock_cost_layers (tenant_id, legal_entity_id, product_id, variant_id, lot_id, posting_id, received_at,
        quantity_in, value_in, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    [
      scope.context.tenantId,
      e.le,
      e.productId,
      e.variantId,
      e.lotId,
      postingId,
      at,
      quantityText(e.quantity),
      moneyText(e.value),
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  return (r.rows[0] as { id: string }).id
}

async function pool(scope: TenantScope, le: string, productId: string, variantId: string | null) {
  const r = await scope.trx.rawQuery(
    `select quantity, value from stock_cost_pools where tenant_id = ? and legal_entity_id = ? and product_id = ?
       and variant_id is not distinct from ?`,
    [scope.context.tenantId, le, productId, variantId] as never[]
  )
  const x = r.rows[0] as any
  return { quantity: x ? big(x.quantity) : 0n, value: x ? cents(x.value) : 0n }
}

async function openLayers(
  scope: TenantScope,
  k: { le: string; productId: string; variantId: string | null; lotId: string | null },
  method: ValuationMethod,
  onlyPostings?: string[]
): Promise<LayerState[]> {
  const params: unknown[] = [scope.context.tenantId, k.le, k.productId, k.variantId]
  let extra = ''
  if (method === 'SPECIFIC') {
    extra += ' and lot_id is not distinct from ?'
    params.push(k.lotId)
  }
  if (onlyPostings) {
    extra += ' and posting_id = any(?::uuid[])'
    params.push(onlyPostings)
  }
  const r = await scope.trx.rawQuery(
    `select id, remaining_quantity, remaining_value from stock_cost_layers
      where tenant_id = ? and legal_entity_id = ? and product_id = ? and variant_id is not distinct from ?
        and remaining_quantity > 0${extra}
      order by received_at, created_at, id for update`,
    params as never[]
  )
  return (r.rows as any[]).map((l) => ({
    id: l.id,
    remainingQuantity: big(l.remaining_quantity),
    remainingValue: cents(l.remaining_value),
  }))
}

/** Custo actual de uma unidade: médio do saldo; senão o da última entrada no livro; senão nada. */
async function currentUnitValue(
  scope: TenantScope,
  le: string,
  productId: string,
  variantId: string | null,
  quantity: bigint
): Promise<bigint | null> {
  const p = await pool(scope, le, productId, variantId)
  if (p.quantity > 0n && p.value > 0n) return divRound(p.value * quantity, p.quantity)
  const r = await scope.trx.rawQuery(
    `select quantity, value from stock_valuation_entries where tenant_id = ? and legal_entity_id = ?
       and product_id = ? and variant_id is not distinct from ? and quantity > 0 and value > 0
     order by occurred_at desc, created_at desc limit 1`,
    [scope.context.tenantId, le, productId, variantId] as never[]
  )
  const x = r.rows[0] as any
  return x ? divRound(cents(x.value) * quantity, big(x.quantity)) : null
}

/** Valoriza um lançamento de stock (chamado por `postStock` e pelo estorno, na mesma transacção). */
export async function valuePosting(scope: TenantScope, ctx: ValuationContext) {
  const t = scope.context.tenantId
  const valued = ctx.lines.filter((l) => (VALUED_BUCKETS as readonly string[]).includes(l.bucket))
  if (!valued.length) return
  const wr = await scope.trx.rawQuery(
    'select id, legal_entity_id from warehouses where tenant_id = ? and id = any(?::uuid[])',
    [t, [...new Set(valued.map((l) => l.warehouseId))]] as never[]
  )
  const leOf = new Map((wr.rows as any[]).map((w) => [w.id as string, w.legal_entity_id as string]))
  const pr = await scope.trx.rawQuery(
    'select id, valuation_method from products where tenant_id = ? and id = any(?::uuid[])',
    [t, [...new Set(valued.map((l) => l.productId))]] as never[]
  )
  const methodOf = new Map(
    (pr.rows as any[]).map((p) => [p.id as string, p.valuation_method as ValuationMethod])
  )
  // Bloqueio do saldo de custo de cada entidade/produto/variante tocado (mesma ordem em todos os pedidos).
  const groups = [
    ...new Set(valued.map((l) => `${leOf.get(l.warehouseId)}|${l.productId}|${l.variantId ?? ''}`)),
  ].sort()
  for (const g of groups)
    await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `cost:${t}:${g}`,
    ])

  const entries: Entry[] = []
  if (ctx.reversalOf) {
    // Estorno: as entradas do original ao contrário (a mesma camada, o mesmo valor), sem recalcular.
    const orig = await scope.trx.rawQuery(
      'select * from stock_valuation_entries where tenant_id = ? and posting_id = ? order by created_at, id',
      [t, ctx.reversalOf]
    )
    for (const o of orig.rows as any[]) {
      const q = big(o.quantity)
      const v = cents(o.value)
      const base = {
        le: o.legal_entity_id as string,
        productId: o.product_id as string,
        variantId: (o.variant_id as string) ?? null,
        lotId: (o.lot_id as string) ?? null,
        method: o.method as ValuationMethod,
        source: 'REVERSAL',
      }
      if (q < 0n) {
        entries.push({ ...base, layerId: o.layer_id ?? null, quantity: -q, value: -v })
        continue
      }
      // Anular uma entrada: sai da sua camada (ou do saldo médio) até onde ainda lá está.
      if (o.layer_id) {
        const l = await scope.trx.rawQuery(
          'select remaining_quantity, remaining_value from stock_cost_layers where tenant_id = ? and id = ? for update',
          [t, o.layer_id]
        )
        const rq = big((l.rows[0] as any).remaining_quantity)
        const rv = cents((l.rows[0] as any).remaining_value)
        const take = rq < q ? rq : q
        if (take > 0n) {
          const value = take === rq ? rv : divRound(v * take, q) < rv ? divRound(v * take, q) : rv
          entries.push({ ...base, layerId: o.layer_id, quantity: -take, value: -value })
        }
        if (q > take) {
          // O que já saiu dessa camada sai agora pelo método do produto.
          const k = { ...base }
          const layers = await openLayers(scope, k, base.method)
          const c = consumeLayers(
            q - take,
            layers.filter((x) => x.id !== o.layer_id)
          )
          for (const part of c.parts)
            entries.push({
              ...base,
              layerId: part.layerId,
              quantity: -part.quantity,
              value: -part.value,
            })
          if (c.short > 0n) entries.push({ ...base, layerId: null, quantity: -c.short, value: 0n })
        }
      } else {
        const p = await pool(scope, base.le, base.productId, base.variantId)
        const value = q >= p.quantity ? p.value : v < p.value ? v : p.value
        entries.push({ ...base, layerId: null, quantity: -q, value: -value })
      }
    }
    await insertEntries(scope, ctx.postingId, ctx.occurredAt, entries)
    return
  }

  // Variação líquida por chave (o que entra e sai na mesma entidade — transferência interna, mudança de estado —
  // anula-se e não mexe no valor).
  interface Net {
    le: string
    productId: string
    variantId: string | null
    lotId: string | null
    method: ValuationMethod
    quantity: bigint
    givenQ: bigint
    givenV: bigint
  }
  const nets = new Map<string, Net>()
  for (const l of valued) {
    const le = leOf.get(l.warehouseId)!
    const method = methodOf.get(l.productId) ?? 'AVERAGE'
    const lotId = method === 'SPECIFIC' ? (l.lotId ?? null) : null
    const k = `${le}|${l.productId}|${l.variantId ?? ''}|${lotId ?? ''}`
    const n =
      nets.get(k) ??
      ({
        le,
        productId: l.productId,
        variantId: l.variantId,
        lotId,
        method,
        quantity: 0n,
        givenQ: 0n,
        givenV: 0n,
      } as Net)
    n.quantity += l.quantity
    if (l.quantity > 0n && ((l.value ?? null) !== null || (l.unitCost ?? null) !== null)) {
      n.givenQ += l.quantity
      n.givenV += l.value ?? lineValue(l.quantity, l.unitCost!)
    }
    nets.set(k, n)
  }
  const queue = new ValueQueue()
  const pairKey = (n: Net) => `${n.productId}|${n.variantId ?? ''}`
  const returns = ctx.returnOfPostingIds?.length ? ctx.returnOfPostingIds : null

  // 1) Saídas.
  for (const n of [...nets.values()].filter((x) => x.quantity < 0n)) {
    const q = -n.quantity
    const base = {
      le: n.le,
      productId: n.productId,
      variantId: n.variantId,
      lotId: n.lotId,
      method: n.method,
    }
    let left = q
    if (n.method !== 'AVERAGE') {
      // Devolução ao fornecedor: primeiro as camadas que esse documento criou.
      if (returns) {
        const c = consumeLayers(left, await openLayers(scope, n, n.method, returns))
        for (const part of c.parts) {
          entries.push({
            ...base,
            layerId: part.layerId,
            source: 'RETURN',
            quantity: -part.quantity,
            value: -part.value,
          })
          queue.push(pairKey(n), part.quantity, part.value)
        }
        left = c.short
      }
      if (left > 0n) {
        const c = consumeLayers(left, await openLayers(scope, n, n.method))
        for (const part of c.parts) {
          entries.push({
            ...base,
            layerId: part.layerId,
            source: 'LAYER',
            quantity: -part.quantity,
            value: -part.value,
          })
          queue.push(pairKey(n), part.quantity, part.value)
        }
        if (c.short > 0n) {
          // Stock sem camada (anterior ao 8.9): sai sem valor.
          entries.push({ ...base, layerId: null, source: 'ZERO', quantity: -c.short, value: 0n })
          queue.push(pairKey(n), c.short, 0n)
        }
      }
      continue
    }
    const p = await pool(scope, n.le, n.productId, n.variantId)
    let value: bigint
    let source = 'AVERAGE'
    if (returns) {
      const o = await scope.trx.rawQuery(
        `select coalesce(sum(quantity), 0) as q, coalesce(sum(value), 0) as v from stock_valuation_entries
          where tenant_id = ? and posting_id = any(?::uuid[]) and legal_entity_id = ? and product_id = ?
            and variant_id is not distinct from ? and quantity > 0`,
        [t, returns, n.le, n.productId, n.variantId] as never[]
      )
      const oq = big((o.rows[0] as any).q)
      if (oq > 0n) {
        source = 'RETURN'
        value = q >= p.quantity ? p.value : divRound(cents((o.rows[0] as any).v) * q, oq)
        if (value > p.value) value = p.value
      } else value = averageOut(q, p)
    } else value = averageOut(q, p)
    entries.push({ ...base, layerId: null, source, quantity: -q, value: -value })
    queue.push(pairKey(n), q, value)
  }
  await insertEntries(scope, ctx.postingId, ctx.occurredAt, entries.splice(0))

  // 2) Entradas.
  for (const n of [...nets.values()].filter((x) => x.quantity > 0n)) {
    const q = n.quantity
    let value: bigint | null = null
    let source = 'GIVEN'
    if (n.givenQ > 0n) value = n.givenQ === q ? n.givenV : divRound(n.givenV * q, n.givenQ)
    if (value === null) {
      const paired = queue.take(pairKey(n), q)
      if (paired.short < q) {
        source = 'PAIRED'
        value =
          paired.value +
          (paired.short > 0n
            ? ((await currentUnitValue(scope, n.le, n.productId, n.variantId, paired.short)) ?? 0n)
            : 0n)
      }
    }
    if (value === null && returns) {
      // Devolução de cliente: ao custo a que saiu.
      const o = await scope.trx.rawQuery(
        `select coalesce(sum(-quantity), 0) as q, coalesce(sum(-value), 0) as v from stock_valuation_entries
          where tenant_id = ? and posting_id = any(?::uuid[]) and product_id = ? and variant_id is not distinct from ?
            and quantity < 0`,
        [t, returns, n.productId, n.variantId] as never[]
      )
      const oq = big((o.rows[0] as any).q)
      if (oq > 0n) {
        source = 'RETURN'
        value = divRound(cents((o.rows[0] as any).v) * q, oq)
      }
    }
    if (value === null) {
      const cur = await currentUnitValue(scope, n.le, n.productId, n.variantId, q)
      source = cur === null ? 'ZERO' : 'CURRENT'
      value = cur ?? 0n
    }
    const e = {
      le: n.le,
      productId: n.productId,
      variantId: n.variantId,
      lotId: n.lotId,
      quantity: q,
      value,
    }
    const layerId =
      n.method === 'AVERAGE' ? null : await newLayer(scope, e, ctx.postingId, ctx.occurredAt)
    entries.push({ ...e, layerId, method: n.method, source })
  }
  await insertEntries(scope, ctx.postingId, ctx.occurredAt, entries)
}
