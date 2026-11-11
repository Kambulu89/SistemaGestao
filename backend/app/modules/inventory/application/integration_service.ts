import { createHash } from 'node:crypto'
import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope } from '#modules/rbac/index'
import { scaled, scaledText } from '#modules/inventory/domain/catalog'
import {
  INTEGRATION_KINDS,
  INTEGRATION_SOURCE,
  type IntegrationKind,
} from '#modules/inventory/domain/integrations'
import {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'
import { postStock, type PostStockLineInput } from '#modules/inventory/application/stock_service'

/*
 * Integrações do inventário com Compras e Vendas (8.10). O inventário é o dono dos movimentos: os outros módulos (e
 * sistemas externos, pela API) pedem operações com uma **chave de idempotência** e as **referências** do documento de
 * origem (encomenda, recepção, guia). Repetir o mesmo pedido devolve o resultado já registado; a mesma chave com outro
 * pedido é recusada. Cada pedido fica registado (só acréscimo) com o lançamento de stock que produziu:
 *
 *  - recepção de compra → entrada ao custo da compra (com lote/validade/séries);
 *  - reserva de venda → reservado do armazém (baixa o disponível); libertação → liberta o que está em aberto;
 *  - entrega de venda → sai do stock (FEFO) e consome a reserva da encomenda; devolução → entra ao custo a que saiu.
 *
 * As funções exportadas correm na transacção de quem chama e não autorizam (o módulo que chama já o fez); a API
 * (`IntegrationService`) exige `inventory.integrations.post` no âmbito do armazém.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const SCALE = 6
const dec = (v: unknown) => {
  const s = String(v ?? '0')
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  return neg ? -n : n
}
const txt = (v: bigint) => scaledText(v, SCALE)
const KEY = /^[A-Za-z0-9:._-]{8,100}$/
const REF = /^[\p{L}\p{N} ._/:#-]{1,80}$/u
const MODULES = ['PURCHASES', 'SALES', 'API'] as const
export type IntegrationModule = (typeof MODULES)[number]

export interface IntegrationLineInput {
  productId: string
  variantId?: string | null
  locationId?: string | null
  quantity: string
  unitCost?: string | null
  lotId?: string | null
  lotCode?: string | null
  expiryDate?: string | null
  serials?: string[] | null
}

export interface IntegrationInput {
  idempotencyKey: string
  warehouseId: string
  /** Encomenda de compra ou de venda. */
  orderRef: string
  /** Recepção, guia de entrega ou devolução. */
  documentRef?: string | null
  /** Fornecedor ou cliente (referência no módulo de origem). */
  counterpartyRef?: string | null
  lines?: IntegrationLineInput[]
}

interface Normal {
  key: string
  warehouseId: string
  orderRef: string
  documentRef: string | null
  counterpartyRef: string | null
  lines: {
    productId: string
    variantId: string | null
    locationId: string | null
    quantity: bigint
    unitCost: string | null
    lotId: string | null
    lotCode: string | null
    expiryDate: string | null
    serials: string[]
  }[]
}

function normalize(kind: IntegrationKind, raw: any): Normal {
  const issues: ErrorDetail[] = []
  if (typeof raw?.idempotencyKey !== 'string' || !KEY.test(raw.idempotencyKey))
    issues.push({
      path: 'idempotencyKey',
      code: 'INVALID',
      message: 'Chave de idempotência inválida.',
    })
  if (!isUuid(raw?.warehouseId))
    issues.push({ path: 'warehouseId', code: 'REQUIRED', message: 'Armazém.' })
  const ref = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const orderRef = ref(raw?.orderRef)
  if (!orderRef || !REF.test(orderRef))
    issues.push({
      path: 'orderRef',
      code: 'REQUIRED',
      message: 'Referência da encomenda (até 80).',
    })
  const documentRef = ref(raw?.documentRef)
  if (documentRef && !REF.test(documentRef))
    issues.push({
      path: 'documentRef',
      code: 'INVALID',
      message: 'Referência do documento (até 80).',
    })
  if (['PURCHASE_RECEIPT', 'SALE_DELIVERY', 'SALE_RETURN'].includes(kind) && !documentRef)
    issues.push({
      path: 'documentRef',
      code: 'REQUIRED',
      message: 'Referência do documento (recepção, guia ou devolução).',
    })
  const counterpartyRef = ref(raw?.counterpartyRef)?.slice(0, 80) ?? null
  const lines: Normal['lines'] = []
  const optional = kind === 'SALE_RELEASE'
  // Libertação sem linhas = libertar tudo o que a encomenda tem reservado.
  const list = optional && (raw?.lines === undefined || raw?.lines === null) ? [] : raw?.lines
  if (!Array.isArray(list) || (!optional && !list.length))
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique as linhas.' })
  else if (list.length > 200)
    issues.push({ path: 'lines', code: 'LENGTH', message: 'No máximo 200 linhas.' })
  else
    list.forEach((l: any, i: number) => {
      const at = (path: string, code: string, message: string) =>
        issues.push({ path: `lines.${i}.${path}`, code, message })
      if (!isUuid(l?.productId)) at('productId', 'REQUIRED', 'Produto.')
      const q = scaled(l?.quantity, SCALE)
      if (q === null || q === 0n) at('quantity', 'INVALID', 'Quantidade positiva, até 6 casas.')
      if (
        kind === 'PURCHASE_RECEIPT' &&
        (l?.unitCost === undefined || l?.unitCost === null || l?.unitCost === '')
      )
        at('unitCost', 'REQUIRED', 'A recepção de compra traz o custo unitário.')
      lines.push({
        productId: l?.productId,
        variantId: isUuid(l?.variantId) ? l.variantId : null,
        locationId: isUuid(l?.locationId) ? l.locationId : null,
        quantity: q ?? 0n,
        unitCost: l?.unitCost === undefined || l?.unitCost === null ? null : String(l.unitCost),
        lotId: isUuid(l?.lotId) ? l.lotId : null,
        lotCode: typeof l?.lotCode === 'string' && l.lotCode.trim() ? l.lotCode.trim() : null,
        expiryDate: typeof l?.expiryDate === 'string' && l.expiryDate ? l.expiryDate : null,
        serials: Array.isArray(l?.serials) ? l.serials.map((s: unknown) => String(s).trim()) : [],
      })
    })
  fail(issues)
  return {
    key: raw.idempotencyKey,
    warehouseId: raw.warehouseId,
    orderRef: orderRef!,
    documentRef,
    counterpartyRef,
    lines,
  }
}

const hashOf = (kind: string, n: Normal) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        kind,
        w: n.warehouseId,
        o: n.orderRef,
        d: n.documentRef,
        c: n.counterpartyRef,
        l: n.lines.map((l) => ({ ...l, quantity: txt(l.quantity) })),
      })
    )
    .digest('hex')

async function eventView(scope: TenantScope, id: string, replayed: boolean) {
  const r = await scope.trx.rawQuery(
    `select e.*, w.code as wh_code, s.source_ref as posting_ref from inventory_integration_events e
       join warehouses w on w.tenant_id = e.tenant_id and w.id = e.warehouse_id
       left join stock_postings s on s.tenant_id = e.tenant_id and s.id = e.posting_id
      where e.tenant_id = ? and e.id = ?`,
    [scope.context.tenantId, id]
  )
  const e = r.rows[0] as any
  return {
    id: e.id as string,
    kind: e.kind as IntegrationKind,
    sourceModule: e.source_module as string,
    warehouse: { id: e.warehouse_id as string, code: e.wh_code as string },
    legalEntityId: e.legal_entity_id as string,
    orderRef: e.order_ref as string,
    documentRef: (e.document_ref as string) ?? null,
    counterpartyRef: (e.counterparty_ref as string) ?? null,
    postingId: (e.posting_id as string) ?? null,
    summary: e.summary as Record<string, unknown>,
    createdAt: e.created_at,
    replayed,
  }
}

/** Por produto/variante, o que a encomenda tem: reservado em aberto, entregue e devolvido. */
async function orderState(scope: TenantScope, warehouseId: string, orderRef: string) {
  const r = await scope.trx.rawQuery(
    `select m.product_id, m.variant_id,
            coalesce(sum(m.quantity) filter (where m.bucket = 'RESERVED'), 0)::text as reserved,
            coalesce(-sum(m.quantity) filter (where e.kind = 'SALE_DELIVERY' and m.bucket in ('UNRESTRICTED','BLOCKED','QUARANTINE')), 0)::text as delivered,
            coalesce(sum(m.quantity) filter (where e.kind = 'SALE_RETURN' and m.bucket in ('UNRESTRICTED','BLOCKED','QUARANTINE')), 0)::text as returned
       from inventory_integration_events e
       join stock_movements m on m.tenant_id = e.tenant_id and m.posting_id = e.posting_id
      where e.tenant_id = ? and e.warehouse_id = ? and e.order_ref = ?
        and e.kind in ('SALE_RESERVATION','SALE_RELEASE','SALE_DELIVERY','SALE_RETURN')
      group by m.product_id, m.variant_id`,
    [scope.context.tenantId, warehouseId, orderRef]
  )
  const out = new Map<string, { reserved: bigint; delivered: bigint; returned: bigint }>()
  for (const x of r.rows as any[])
    out.set(`${x.product_id}|${x.variant_id ?? ''}`, {
      reserved: dec(x.reserved),
      delivered: dec(x.delivered),
      returned: dec(x.returned),
    })
  return out
}
const keyOf = (l: { productId: string; variantId: string | null }) =>
  `${l.productId}|${l.variantId ?? ''}`

/** Executa um pedido de integração (idempotente) na transacção de quem chama. */
async function run(
  scope: TenantScope,
  kind: IntegrationKind,
  raw: any,
  sourceModule: IntegrationModule,
  checkAccess: boolean
) {
  const n = normalize(kind, raw)
  const t = scope.context.tenantId
  const hash = hashOf(kind, n)
  await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `integration:${t}:${n.key}`,
  ])
  const prev = (
    await scope.trx.rawQuery(
      'select id, request_hash from inventory_integration_events where tenant_id = ? and idempotency_key = ?',
      [t, n.key]
    )
  ).rows[0] as { id: string; request_hash: string } | undefined
  if (prev) {
    if (prev.request_hash !== hash)
      throw ApiError.conflict(
        'IDEMPOTENCY_MISMATCH',
        'Esta chave de idempotência já foi usada num pedido diferente.'
      )
    return eventView(scope, prev.id, true)
  }
  const w = (
    await scope.trx.rawQuery(
      'select id, legal_entity_id, status from warehouses where tenant_id = ? and id = ?',
      [t, n.warehouseId]
    )
  ).rows[0] as any
  if (!w) throw ApiError.notFound()
  // Por encomenda, uma operação de cada vez (o reservado em aberto e o entregue não mudam por baixo).
  await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `order:${t}:${n.warehouseId}:${n.orderRef}`,
  ])
  const base = (l: Normal['lines'][number]) => ({
    warehouseId: n.warehouseId,
    productId: l.productId,
    variantId: l.variantId,
  })
  const state = kind.startsWith('SALE_')
    ? await orderState(scope, n.warehouseId, n.orderRef)
    : new Map<string, { reserved: bigint; delivered: bigint; returned: bigint }>()
  let type: 'RECEIPT' | 'RESERVATION' | 'RELEASE' | 'ISSUE'
  let lines: PostStockLineInput[] = []
  let returnOf: string[] | undefined
  const summary: {
    lines: {
      productId: string
      variantId: string | null
      quantity: string
      reservedUsed?: string
    }[]
  } = { lines: [] }
  if (kind === 'PURCHASE_RECEIPT') {
    type = 'RECEIPT'
    lines = n.lines.map((l) => ({
      ...base(l),
      locationId: l.locationId,
      bucket: 'UNRESTRICTED' as const,
      quantity: txt(l.quantity),
      unitCost: l.unitCost,
      lotId: l.lotId,
      lotCode: l.lotCode,
      expiryDate: l.expiryDate,
      serials: l.serials,
    }))
  } else if (kind === 'SALE_RESERVATION') {
    type = 'RESERVATION'
    lines = n.lines.map((l) => ({
      ...base(l),
      bucket: 'RESERVED' as const,
      quantity: txt(l.quantity),
    }))
  } else if (kind === 'SALE_RELEASE') {
    type = 'RELEASE'
    const wanted = n.lines.length
      ? n.lines
      : [...state]
          .filter(([, s]) => s.reserved > 0n)
          .map(([k, s]) => {
            const [productId, variantId] = k.split('|')
            return {
              productId,
              variantId: variantId || null,
              quantity: s.reserved,
            } as Normal['lines'][number]
          })
    const issues: ErrorDetail[] = []
    wanted.forEach((l, i) => {
      const open = state.get(keyOf(l))?.reserved ?? 0n
      if (l.quantity > open)
        issues.push({
          path: `lines.${i}.quantity`,
          code: 'OVER_RELEASE',
          message: `A encomenda só tem ${txt(open)} reservado deste produto.`,
        })
    })
    fail(issues)
    if (!wanted.length)
      throw ApiError.conflict(
        'NOTHING_RESERVED',
        'A encomenda não tem nada reservado neste armazém.'
      )
    lines = wanted.map((l) => ({
      ...base(l),
      bucket: 'RESERVED' as const,
      quantity: `-${txt(l.quantity)}`,
    }))
    n.lines = wanted
  } else if (kind === 'SALE_DELIVERY') {
    type = 'ISSUE'
    const used = new Map<string, bigint>()
    for (const l of n.lines) {
      const k = keyOf(l)
      const open = (state.get(k)?.reserved ?? 0n) - (used.get(k) ?? 0n)
      const consume = open > 0n ? (open < l.quantity ? open : l.quantity) : 0n
      used.set(k, (used.get(k) ?? 0n) + consume)
      lines.push({
        ...base(l),
        locationId: l.locationId,
        bucket: 'UNRESTRICTED',
        quantity: `-${txt(l.quantity)}`,
        lotId: l.lotId,
        serials: l.serials,
      })
      if (consume > 0n) lines.push({ ...base(l), bucket: 'RESERVED', quantity: `-${txt(consume)}` })
      summary.lines.push({ ...base(l), quantity: txt(l.quantity), reservedUsed: txt(consume) })
    }
  } else {
    type = 'RECEIPT'
    const issues: ErrorDetail[] = []
    const back = new Map<string, bigint>()
    n.lines.forEach((l, i) => {
      const s = state.get(keyOf(l))
      const k = keyOf(l)
      back.set(k, (back.get(k) ?? 0n) + l.quantity)
      const can = (s?.delivered ?? 0n) - (s?.returned ?? 0n)
      if (back.get(k)! > can)
        issues.push({
          path: `lines.${i}.quantity`,
          code: 'OVER_RETURN',
          message: `Da encomenda só saíram ${txt(can)} por devolver deste produto.`,
        })
    })
    fail(issues)
    returnOf = (
      (
        await scope.trx.rawQuery(
          `select posting_id from inventory_integration_events where tenant_id = ? and warehouse_id = ? and order_ref = ?
              and kind = 'SALE_DELIVERY' and posting_id is not null`,
          [t, n.warehouseId, n.orderRef]
        )
      ).rows as any[]
    ).map((x) => x.posting_id as string)
    lines = n.lines.map((l) => ({
      ...base(l),
      locationId: l.locationId,
      bucket: 'UNRESTRICTED' as const,
      quantity: txt(l.quantity),
      lotId: l.lotId,
      lotCode: l.lotCode,
      expiryDate: l.expiryDate,
      serials: l.serials,
    }))
  }
  if (!summary.lines.length)
    summary.lines = n.lines.map((l) => ({ ...base(l), quantity: txt(l.quantity) }))
  const posted = await postStock(scope, {
    type,
    idempotencyKey: `int-${n.key}`.slice(0, 100),
    sourceType: INTEGRATION_SOURCE[kind],
    sourceRef: (n.documentRef ?? n.orderRef).slice(0, 60),
    reason: `${n.orderRef}${n.counterpartyRef ? ' · ' + n.counterpartyRef : ''}`,
    lines,
    returnOfPostingIds: returnOf,
    checkAccess,
  })
  const ins = await scope.trx.rawQuery(
    `insert into inventory_integration_events (tenant_id, kind, source_module, warehouse_id, legal_entity_id, order_ref,
        document_ref, counterparty_ref, idempotency_key, request_hash, posting_id, summary, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) returning id`,
    [
      t,
      kind,
      sourceModule,
      n.warehouseId,
      w.legal_entity_id,
      n.orderRef,
      n.documentRef,
      n.counterpartyRef,
      n.key,
      hash,
      posted.posting.id,
      JSON.stringify(summary),
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  const id = (ins.rows[0] as { id: string }).id
  await audit(scope, {
    action: `inventory.integration.${kind.toLowerCase()}`,
    entityType: 'inventory_integration_event',
    entityId: id,
    metadata: {
      sourceModule,
      orderRef: n.orderRef,
      documentRef: n.documentRef,
      postingId: posted.posting.id,
    },
  })
  return eventView(scope, id, false)
}

/** Contrato para Compras: recepção de uma compra (entra ao custo da compra). */
export const receivePurchase = (scope: TenantScope, input: IntegrationInput) =>
  run(scope, 'PURCHASE_RECEIPT', input, 'PURCHASES', false)
/** Contratos para Vendas: reserva, libertação, entrega (consome a reserva) e devolução (ao custo a que saiu). */
export const reserveForSale = (scope: TenantScope, input: IntegrationInput) =>
  run(scope, 'SALE_RESERVATION', input, 'SALES', false)
export const releaseSaleReservation = (scope: TenantScope, input: IntegrationInput) =>
  run(scope, 'SALE_RELEASE', input, 'SALES', false)
export const deliverSale = (scope: TenantScope, input: IntegrationInput) =>
  run(scope, 'SALE_DELIVERY', input, 'SALES', false)
export const returnFromSale = (scope: TenantScope, input: IntegrationInput) =>
  run(scope, 'SALE_RETURN', input, 'SALES', false)

/** Integrar no armazém: `inventory.integrations.post` no âmbito da entidade legal ou filial do armazém. */
async function integrationRight(scope: TenantScope, warehouseId: string) {
  if (!isUuid(warehouseId)) return false
  const a = await warehouseAccessFor(scope, warehouseId)
  if (!a) return false
  const s = await permissionScope(scope, 'inventory.integrations.post')
  return (
    s.tenant ||
    s.legalEntityIds.has(a.legalEntityId) ||
    (!!a.branchId && s.branchIds.has(a.branchId))
  )
}

export class IntegrationService {
  /** Um pedido pela API (sistema externo ou módulo remoto): autoriza no armazém e executa. */
  post(context: TenantContext, kind: IntegrationKind, raw: any) {
    return runInTenant(context, async (scope) => {
      if (!(INTEGRATION_KINDS as readonly string[]).includes(kind)) throw ApiError.notFound()
      if (!isUuid(raw?.warehouseId))
        fail([{ path: 'warehouseId', code: 'REQUIRED', message: 'Armazém.' }])
      const a = await warehouseAccessFor(scope, raw.warehouseId)
      if (!a) throw ApiError.notFound()
      if (!(await integrationRight(scope, raw.warehouseId)))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não integra operações neste armazém.')
      return run(scope, kind, raw, 'API', false)
    })
  }

  /** Registo dos pedidos (dos armazéns que o membro consulta). */
  list(
    context: TenantContext,
    f: { kind?: string; warehouseId?: string; orderRef?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const ids = await readableWarehouseIds(scope)
      if (!ids.length) return { items: [], total: 0 }
      const where = ['e.tenant_id = ?', 'e.warehouse_id = any(?::uuid[])']
      const params: unknown[] = [context.tenantId, ids]
      for (const [k, col] of [
        ['kind', 'e.kind'],
        ['warehouseId', 'e.warehouse_id'],
        ['orderRef', 'e.order_ref'],
      ] as const)
        if (f[k]) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      const cl = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select e.id from inventory_integration_events e where ${cl} order by e.created_at desc limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from inventory_integration_events e where ${cl}`,
        params as never[]
      )
      const items = []
      for (const r of rows.rows as { id: string }[]) items.push(await eventView(scope, r.id, false))
      return { items, total: (count.rows[0] as { n: number }).n }
    })
  }

  /** Estado de uma encomenda de venda num armazém: reservado em aberto, entregue e devolvido por produto. */
  order(context: TenantContext, warehouseId: string, orderRef: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(warehouseId) || !(await readableWarehouseIds(scope)).includes(warehouseId))
        throw ApiError.notFound()
      const state = await orderState(scope, warehouseId, orderRef)
      if (!state.size) throw ApiError.notFound()
      const pr = await scope.trx.rawQuery(
        'select id, sku from products where tenant_id = ? and id = any(?::uuid[])',
        [context.tenantId, [...new Set([...state.keys()].map((k) => k.split('|')[0]))]] as never[]
      )
      const sku = new Map((pr.rows as any[]).map((p) => [p.id as string, p.sku as string]))
      return {
        warehouseId,
        orderRef,
        lines: [...state].map(([k, s]) => {
          const [productId, variantId] = k.split('|')
          return {
            product: { id: productId, sku: sku.get(productId) ?? '' },
            variantId: variantId || null,
            reserved: txt(s.reserved),
            delivered: txt(s.delivered),
            returned: txt(s.returned),
          }
        }),
      }
    })
  }
}
