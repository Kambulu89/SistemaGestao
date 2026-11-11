import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope } from '#modules/rbac/index'
import { accountBalancesAt, accountsOfLegalEntity } from '#modules/accounting/index'
import {
  costText,
  moneyText,
  parseScaled,
  unitCostOf,
  type ValuationMethod,
} from '#modules/inventory/domain/valuation'
import { quantityText } from '#modules/inventory/domain/stock'

/*
 * Valorização (8.9): consulta do valor do stock por entidade legal (custo médio, camadas FIFO/lote, livro de custo),
 * ajustes de custo sobre o stock existente (sem tocar no passado) e reconciliação — interna (livro = saldos de custo =
 * camadas; quantidade valorizada = stock físico) e com a contabilidade (valor por classe contabilística à data contra o
 * saldo da conta configurada). Ver: `inventory.valuation.read`; ajustar e configurar: `inventory.valuation.manage`;
 * ambos no âmbito da entidade legal.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
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
/** Saldo do razão (numérico com mais casas) arredondado ao cêntimo. */
const glCents = (v: string) => {
  const neg = v.startsWith('-')
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.')
  const raw = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  const c = (raw + 5_000n) / 10_000n
  return neg ? -c : c
}
const DATE = /^\d{4}-\d{2}-\d{2}$/
const KEY = /^[A-Za-z0-9:._-]{8,80}$/
const NO_CLASS = 'SEM_CLASSE'

/** Entidades legais em que o membro tem a permissão (todas, se no âmbito da empresa). */
async function entities(scope: TenantScope, perm: string): Promise<string[] | 'ALL'> {
  const s = await permissionScope(scope, perm)
  if (s.tenant) return 'ALL'
  return [...s.legalEntityIds]
}
/** A entidade tem de existir nesta empresa e estar no âmbito da permissão. */
async function allowed(scope: TenantScope, perm: string, legalEntityId: string) {
  if (!isUuid(legalEntityId)) return false
  const r = await scope.trx.rawQuery(
    'select 1 from legal_entities where tenant_id = ? and id = ?',
    [scope.context.tenantId, legalEntityId]
  )
  if (!r.rows.length) return false
  const e = await entities(scope, perm)
  return e === 'ALL' || e.includes(legalEntityId)
}
async function leFilter(scope: TenantScope, perm: string, legalEntityId?: string) {
  const e = await entities(scope, perm)
  if (legalEntityId) return (await allowed(scope, perm, legalEntityId)) ? [legalEntityId] : null
  if (e === 'ALL') {
    const r = await scope.trx.rawQuery('select id from legal_entities where tenant_id = ?', [
      scope.context.tenantId,
    ])
    return (r.rows as any[]).map((x) => x.id as string)
  }
  return e.length ? e : null
}

const poolView = (r: any) => {
  const q = big(r.quantity)
  const v = cents(r.value)
  return {
    legalEntity: { id: r.legal_entity_id as string, code: r.le_code as string },
    product: { id: r.product_id as string, sku: r.sku as string, name: r.product_name as string },
    variant: r.variant_id ? { id: r.variant_id as string, sku: r.variant_sku as string } : null,
    method: r.valuation_method as ValuationMethod,
    uom: r.uom_code as string,
    currency: (r.currency as string) ?? null,
    quantity: quantityText(q),
    value: moneyText(v),
    unitCost: costText(unitCostOf(v, q)),
  }
}

export class ValuationService {
  /** Valor do stock: um saldo de custo por entidade legal, produto e variante. */
  list(
    context: TenantContext,
    f: { legalEntityId?: string; productId?: string; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const les = await leFilter(scope, 'inventory.valuation.read', f.legalEntityId)
      if (!les)
        return { items: [], total: 0, totals: [] as { legalEntityId: string; value: string }[] }
      const where = ['c.tenant_id = ?', 'c.legal_entity_id = any(?::uuid[])', 'c.quantity <> 0']
      const params: unknown[] = [context.tenantId, les]
      if (f.productId) {
        where.push('c.product_id = ?')
        params.push(f.productId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          "(lower(p.sku) like ? or lower(p.name) like ? or lower(coalesce(v.sku, '')) like ?)"
        )
        params.push(like, like, like)
      }
      const from = `from stock_cost_pools c
        join products p on p.tenant_id = c.tenant_id and p.id = c.product_id
        join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
        join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id
        left join product_variants v on v.tenant_id = c.tenant_id and v.id = c.variant_id
        where ${where.join(' and ')}`
      const rows = await scope.trx.rawQuery(
        `select c.*, p.sku, p.name as product_name, p.valuation_method, v.sku as variant_sku, u.code as uom_code,
            le.code as le_code, le.functional_currency as currency
         ${from} order by le.code, p.sku, v.sku nulls first limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[])
      const tot = await scope.trx.rawQuery(
        `select c.legal_entity_id, sum(c.value)::text as value ${from} group by c.legal_entity_id`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map(poolView),
        total: (count.rows[0] as { n: number }).n,
        totals: (tot.rows as any[]).map((x) => ({
          legalEntityId: x.legal_entity_id as string,
          value: moneyText(cents(x.value)),
        })),
      }
    })
  }

  /** Um produto numa entidade: saldo de custo, camadas e o livro (as últimas 200 entradas). */
  product(context: TenantContext, productId: string, legalEntityId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(productId) || !isUuid(legalEntityId)) throw ApiError.notFound()
      if (!(await allowed(scope, 'inventory.valuation.read', legalEntityId)))
        throw ApiError.notFound()
      const t = context.tenantId
      const p = await scope.trx.rawQuery(
        `select p.id, p.sku, p.name, p.valuation_method, u.code as uom_code from products p
           join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id where p.tenant_id = ? and p.id = ?`,
        [t, productId]
      )
      const prod = p.rows[0] as any
      if (!prod) throw ApiError.notFound()
      const pools = await scope.trx.rawQuery(
        `select c.*, p.sku, p.name as product_name, p.valuation_method, v.sku as variant_sku, u.code as uom_code,
            le.code as le_code, le.functional_currency as currency
           from stock_cost_pools c join products p on p.tenant_id = c.tenant_id and p.id = c.product_id
           join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
           join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id
           left join product_variants v on v.tenant_id = c.tenant_id and v.id = c.variant_id
          where c.tenant_id = ? and c.product_id = ? and c.legal_entity_id = ? order by v.sku nulls first`,
        [t, productId, legalEntityId]
      )
      const layers = await scope.trx.rawQuery(
        `select l.*, lt.code as lot_code, s.source_type, s.source_ref from stock_cost_layers l
           left join stock_lots lt on lt.tenant_id = l.tenant_id and lt.id = l.lot_id
           left join stock_postings s on s.tenant_id = l.tenant_id and s.id = l.posting_id
          where l.tenant_id = ? and l.product_id = ? and l.legal_entity_id = ?
          order by (l.remaining_quantity > 0) desc, l.received_at, l.created_at limit 200`,
        [t, productId, legalEntityId]
      )
      const ledger = await scope.trx.rawQuery(
        `select e.*, s.posting_type, s.source_type, s.source_id, s.source_ref, lt.code as lot_code,
            a.reason as adj_reason, u.full_name as user_name
           from stock_valuation_entries e
           left join stock_postings s on s.tenant_id = e.tenant_id and s.id = e.posting_id
           left join stock_cost_adjustments a on a.tenant_id = e.tenant_id and a.id = e.adjustment_id
           left join stock_lots lt on lt.tenant_id = e.tenant_id and lt.id = e.lot_id
           left join users u on u.id = e.created_by
          where e.tenant_id = ? and e.product_id = ? and e.legal_entity_id = ?
          order by e.occurred_at desc, e.created_at desc limit 200`,
        [t, productId, legalEntityId]
      )
      return {
        product: { id: prod.id as string, sku: prod.sku as string, name: prod.name as string },
        method: prod.valuation_method as ValuationMethod,
        uom: prod.uom_code as string,
        pools: (pools.rows as any[]).map(poolView),
        layers: (layers.rows as any[]).map((l) => ({
          id: l.id as string,
          variantId: (l.variant_id as string) ?? null,
          lot: l.lot_id ? { id: l.lot_id as string, code: l.lot_code as string } : null,
          receivedAt: l.received_at,
          source: {
            type: (l.source_type as string) ?? null,
            ref: (l.source_ref as string) ?? null,
          },
          quantityIn: quantityText(big(l.quantity_in)),
          valueIn: moneyText(cents(l.value_in)),
          unitCost: costText(unitCostOf(cents(l.value_in), big(l.quantity_in))),
          remainingQuantity: quantityText(big(l.remaining_quantity)),
          remainingValue: moneyText(cents(l.remaining_value)),
        })),
        ledger: (ledger.rows as any[]).map((e) => ({
          id: e.id as string,
          occurredAt: e.occurred_at,
          variantId: (e.variant_id as string) ?? null,
          lot: (e.lot_code as string) ?? null,
          layerId: (e.layer_id as string) ?? null,
          source: e.source as string,
          postingType: (e.posting_type as string) ?? null,
          origin: e.posting_id
            ? {
                type: e.source_type as string,
                id: (e.source_id as string) ?? null,
                ref: (e.source_ref as string) ?? null,
              }
            : null,
          reason: (e.adj_reason as string) ?? null,
          quantity: quantityText(big(e.quantity)),
          value: moneyText(cents(e.value)),
          user: (e.user_name as string) ?? null,
        })),
      }
    })
  }

  /**
   * Ajuste de custo (preço definitivo, custos de aquisição, correcção): soma ao valor do stock que ainda existe — no
   * custo médio, ao saldo; no FIFO/específico, à camada indicada. O que já saiu não muda.
   */
  adjust(context: TenantContext, raw: any) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      const issues: ErrorDetail[] = []
      const key = raw?.idempotencyKey
      if (typeof key !== 'string' || !KEY.test(key))
        issues.push({
          path: 'idempotencyKey',
          code: 'INVALID',
          message: 'Chave de idempotência inválida.',
        })
      const amount = parseScaled(raw?.amount, 2, true)
      if (amount === null || amount === 0n)
        issues.push({
          path: 'amount',
          code: 'INVALID',
          message: 'Valor diferente de zero, até 2 casas.',
        })
      const reason =
        typeof raw?.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim().slice(0, 300)
          : null
      if (!reason) issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' })
      if (!isUuid(raw?.legalEntityId))
        issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade legal.' })
      if (!isUuid(raw?.productId))
        issues.push({ path: 'productId', code: 'REQUIRED', message: 'Produto.' })
      fail(issues)
      if (!(await allowed(scope, 'inventory.valuation.read', raw.legalEntityId)))
        throw ApiError.notFound()
      if (!(await allowed(scope, 'inventory.valuation.manage', raw.legalEntityId)))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a valorização desta entidade legal.')
      const done = await scope.trx.rawQuery(
        'select id from stock_cost_adjustments where tenant_id = ? and idempotency_key = ?',
        [t, key]
      )
      if (done.rows.length) return this.product(context, raw.productId, raw.legalEntityId)
      const variantId = isUuid(raw?.variantId) ? raw.variantId : null
      const pr = await scope.trx.rawQuery(
        'select valuation_method from products where tenant_id = ? and id = ?',
        [t, raw.productId]
      )
      const method = (pr.rows[0] as any)?.valuation_method as ValuationMethod | undefined
      if (!method) throw ApiError.notFound()
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `cost:${t}:${raw.legalEntityId}|${raw.productId}|${variantId ?? ''}`,
      ])
      const pool = await scope.trx.rawQuery(
        `select quantity, value from stock_cost_pools where tenant_id = ? and legal_entity_id = ? and product_id = ?
           and variant_id is not distinct from ? for update`,
        [t, raw.legalEntityId, raw.productId, variantId] as never[]
      )
      const pq = big((pool.rows[0] as any)?.quantity)
      const pv = cents((pool.rows[0] as any)?.value)
      if (pq <= 0n)
        throw ApiError.conflict(
          'NO_STOCK',
          'Não há stock deste produto na entidade: o custo já não se ajusta aqui.'
        )
      let layerId: string | null = null
      let lotId: string | null = null
      if (method !== 'AVERAGE') {
        if (!isUuid(raw?.layerId))
          fail([
            {
              path: 'layerId',
              code: 'REQUIRED',
              message: 'No FIFO e no custo específico, escolha a camada.',
            },
          ])
        const l = await scope.trx.rawQuery(
          `select id, lot_id, remaining_quantity, remaining_value from stock_cost_layers
            where tenant_id = ? and id = ? and legal_entity_id = ? and product_id = ? and variant_id is not distinct from ?
            for update`,
          [t, raw.layerId, raw.legalEntityId, raw.productId, variantId] as never[]
        )
        const x = l.rows[0] as any
        if (!x)
          fail([
            {
              path: 'layerId',
              code: 'NOT_FOUND',
              message: 'A camada não é deste produto/entidade.',
            },
          ])
        if (big(x.remaining_quantity) <= 0n)
          throw ApiError.conflict(
            'NO_STOCK',
            'Esta camada já saiu toda: o custo já não se ajusta aqui.'
          )
        if (cents(x.remaining_value) + amount! < 0n)
          fail([
            {
              path: 'amount',
              code: 'NEGATIVE_VALUE',
              message: 'O valor da camada ficaria negativo.',
            },
          ])
        layerId = x.id
        lotId = x.lot_id ?? null
      } else if (pv + amount! < 0n)
        fail([
          { path: 'amount', code: 'NEGATIVE_VALUE', message: 'O valor do stock ficaria negativo.' },
        ])
      const a = await scope.trx.rawQuery(
        `insert into stock_cost_adjustments (tenant_id, legal_entity_id, product_id, variant_id, layer_id, amount,
            reason, idempotency_key, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          t,
          raw.legalEntityId,
          raw.productId,
          variantId,
          layerId,
          moneyText(amount!),
          reason,
          key,
          context.userId,
          context.userId,
        ] as never[]
      )
      const adjustmentId = (a.rows[0] as { id: string }).id
      await scope.trx.rawQuery(
        `insert into stock_valuation_entries (tenant_id, adjustment_id, legal_entity_id, product_id, variant_id, lot_id,
            layer_id, method, source, quantity, value, occurred_at, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'ADJUSTMENT', 0, ?, now(), ?, ?)`,
        [
          t,
          adjustmentId,
          raw.legalEntityId,
          raw.productId,
          variantId,
          lotId,
          layerId,
          method,
          moneyText(amount!),
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'inventory.valuation.adjusted',
        entityType: 'stock_cost_adjustment',
        entityId: adjustmentId,
        metadata: {
          legalEntityId: raw.legalEntityId,
          productId: raw.productId,
          layerId,
          amount: moneyText(amount!),
          reason,
        },
      })
      return this.product(context, raw.productId, raw.legalEntityId)
    })
  }

  /** Contas do razão por classe contabilística (para a reconciliação) e as contas disponíveis. */
  accounts(context: TenantContext, legalEntityId: string) {
    return runInTenant(context, async (scope) => {
      if (
        !isUuid(legalEntityId) ||
        !(await allowed(scope, 'inventory.valuation.read', legalEntityId))
      )
        throw ApiError.notFound()
      const t = context.tenantId
      const m = await scope.trx.rawQuery(
        `select m.accounting_class, m.account_id, a.code, a.name from inventory_valuation_accounts m
           join accounts a on a.tenant_id = m.tenant_id and a.id = m.account_id
          where m.tenant_id = ? and m.legal_entity_id = ? order by m.accounting_class`,
        [t, legalEntityId]
      )
      const classes = await scope.trx.rawQuery(
        `select distinct accounting_class from product_categories where tenant_id = ? and accounting_class is not null
          order by 1`,
        [t]
      )
      return {
        mappings: (m.rows as any[]).map((x) => ({
          accountingClass: x.accounting_class as string,
          account: { id: x.account_id as string, code: x.code as string, name: x.name as string },
        })),
        classes: (classes.rows as any[]).map((x) => x.accounting_class as string),
        accounts: await accountsOfLegalEntity(scope, legalEntityId),
      }
    })
  }

  setAccounts(context: TenantContext, legalEntityId: string, raw: any) {
    return runInTenant(context, async (scope) => {
      if (!(await allowed(scope, 'inventory.valuation.read', legalEntityId)))
        throw ApiError.notFound()
      if (!(await allowed(scope, 'inventory.valuation.manage', legalEntityId)))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a valorização desta entidade legal.')
      const t = context.tenantId
      const list = Array.isArray(raw?.mappings) ? raw.mappings : []
      const valid = new Set((await accountsOfLegalEntity(scope, legalEntityId)).map((a) => a.id))
      const issues: ErrorDetail[] = []
      const seen = new Set<string>()
      list.forEach((x: any, i: number) => {
        if (
          typeof x?.accountingClass !== 'string' ||
          !/^[A-Z][A-Z0-9_]{1,29}$/.test(x.accountingClass)
        )
          issues.push({
            path: `mappings.${i}.accountingClass`,
            code: 'INVALID',
            message: 'Classe inválida.',
          })
        else if (seen.has(x.accountingClass))
          issues.push({
            path: `mappings.${i}.accountingClass`,
            code: 'DUPLICATE',
            message: 'Classe repetida.',
          })
        seen.add(x?.accountingClass)
        if (!valid.has(x?.accountId))
          issues.push({
            path: `mappings.${i}.accountId`,
            code: 'NOT_FOUND',
            message: 'Conta do plano desta entidade.',
          })
      })
      fail(issues)
      await scope.trx.rawQuery(
        'delete from inventory_valuation_accounts where tenant_id = ? and legal_entity_id = ?',
        [t, legalEntityId]
      )
      for (const x of list)
        await scope.trx.rawQuery(
          `insert into inventory_valuation_accounts (tenant_id, legal_entity_id, accounting_class, account_id,
              created_by, updated_by) values (?, ?, ?, ?, ?, ?)`,
          [
            t,
            legalEntityId,
            x.accountingClass,
            x.accountId,
            context.userId,
            context.userId,
          ] as never[]
        )
      await audit(scope, {
        action: 'inventory.valuation.accounts_set',
        entityType: 'legal_entity',
        entityId: legalEntityId,
        metadata: { mappings: list.map((x: any) => ({ c: x.accountingClass, a: x.accountId })) },
      })
      return this.accounts(context, legalEntityId)
    })
  }

  /**
   * Reconciliação de uma entidade à data: valor do inventário por classe contabilística (do livro, até à data)
   * contra o saldo da conta configurada; e a coerência interna — livro = saldos de custo = camadas, e a quantidade
   * valorizada = stock físico e em trânsito dos armazéns da entidade.
   */
  reconciliation(context: TenantContext, legalEntityId: string, date?: string) {
    return runInTenant(context, async (scope) => {
      if (
        !isUuid(legalEntityId) ||
        !(await allowed(scope, 'inventory.valuation.read', legalEntityId))
      )
        throw ApiError.notFound()
      const t = context.tenantId
      const day = date ?? new Date().toISOString().slice(0, 10)
      if (!DATE.test(day) || Number.isNaN(Date.parse(day)))
        fail([{ path: 'date', code: 'INVALID', message: 'Data inválida.' }])
      const byClass = await scope.trx.rawQuery(
        `select coalesce(p.accounting_class, cat.accounting_class, ?) as cls, coalesce(sum(e.value), 0)::text as value
           from stock_valuation_entries e
           join products p on p.tenant_id = e.tenant_id and p.id = e.product_id
           left join product_categories cat on cat.tenant_id = p.tenant_id and cat.id = p.category_id
          where e.tenant_id = ? and e.legal_entity_id = ? and e.occurred_at < (?::date + 1)
          group by 1 order by 1`,
        [NO_CLASS, t, legalEntityId, day] as never[]
      )
      const maps = await scope.trx.rawQuery(
        `select m.accounting_class, m.account_id, a.code, a.name from inventory_valuation_accounts m
           join accounts a on a.tenant_id = m.tenant_id and a.id = m.account_id
          where m.tenant_id = ? and m.legal_entity_id = ?`,
        [t, legalEntityId]
      )
      const mapOf = new Map((maps.rows as any[]).map((m) => [m.accounting_class as string, m]))
      const gl = await accountBalancesAt(
        scope,
        legalEntityId,
        [...new Set((maps.rows as any[]).map((m) => m.account_id as string))],
        day
      )
      const classes = new Set([
        ...(byClass.rows as any[]).map((x) => x.cls as string),
        ...mapOf.keys(),
      ])
      const inv = new Map((byClass.rows as any[]).map((x) => [x.cls as string, cents(x.value)]))
      // Contas partilhadas por várias classes comparam-se com a soma dessas classes.
      const lines = [...classes].sort().map((cls) => {
        const m = mapOf.get(cls)
        const value = inv.get(cls) ?? 0n
        return {
          accountingClass: cls,
          inventoryValue: moneyText(value),
          account: m
            ? { id: m.account_id as string, code: m.code as string, name: m.name as string }
            : null,
        }
      })
      const byAccount = new Map<string, { classes: string[]; inventory: bigint; gl: bigint }>()
      for (const l of lines)
        if (l.account) {
          const x = byAccount.get(l.account.id) ?? {
            classes: [],
            inventory: 0n,
            gl: glCents(gl.get(l.account.id) ?? '0'),
          }
          x.classes.push(l.accountingClass)
          x.inventory += cents(l.inventoryValue)
          byAccount.set(l.account.id, x)
        }
      const accountsView = [...byAccount].map(([id, x]) => ({
        accountId: id,
        account: lines.find((l) => l.account?.id === id)!.account,
        classes: x.classes,
        inventoryValue: moneyText(x.inventory),
        ledgerBalance: moneyText(x.gl),
        difference: moneyText(x.inventory - x.gl),
      }))
      // Coerência interna (hoje): livro × saldos × camadas; quantidade valorizada × stock.
      const internal = await scope.trx.rawQuery(
        `with e as (select product_id, variant_id, sum(quantity) as q, sum(value) as v from stock_valuation_entries
                     where tenant_id = ? and legal_entity_id = ? group by product_id, variant_id),
              c as (select product_id, variant_id, quantity as q, value as v from stock_cost_pools
                     where tenant_id = ? and legal_entity_id = ?),
              l as (select product_id, variant_id, sum(remaining_quantity) as q, sum(remaining_value) as v
                      from stock_cost_layers where tenant_id = ? and legal_entity_id = ? group by product_id, variant_id),
              s as (select b.product_id, b.variant_id,
                           sum(b.qty_unrestricted + b.qty_blocked + b.qty_quarantine + b.qty_in_transit) as q
                      from stock_balances b join warehouses w on w.tenant_id = b.tenant_id and w.id = b.warehouse_id
                     where b.tenant_id = ? and w.legal_entity_id = ? group by b.product_id, b.variant_id)
         select coalesce(e.product_id, c.product_id, s.product_id) as product_id,
                coalesce(e.variant_id, c.variant_id, s.variant_id) as variant_id, p.sku, p.valuation_method,
                coalesce(e.q, 0)::text as eq, coalesce(e.v, 0)::text as ev, coalesce(c.q, 0)::text as cq,
                coalesce(c.v, 0)::text as cv, l.q::text as lq, l.v::text as lv, coalesce(s.q, 0)::text as sq
           from e full join c on c.product_id = e.product_id and c.variant_id is not distinct from e.variant_id
           full join s on s.product_id = coalesce(e.product_id, c.product_id)
             and s.variant_id is not distinct from coalesce(e.variant_id, c.variant_id)
           left join l on l.product_id = coalesce(e.product_id, c.product_id, s.product_id)
             and l.variant_id is not distinct from coalesce(e.variant_id, c.variant_id, s.variant_id)
           join products p on p.tenant_id = ? and p.id = coalesce(e.product_id, c.product_id, s.product_id)`,
        [t, legalEntityId, t, legalEntityId, t, legalEntityId, t, legalEntityId, t] as never[]
      )
      const differences = (internal.rows as any[])
        .map((x) => {
          const problems: string[] = []
          if (big(x.eq) !== big(x.cq) || cents(x.ev) !== cents(x.cv)) problems.push('LEDGER_POOL')
          if (
            x.valuation_method !== 'AVERAGE' &&
            (big(x.lq ?? '0') !== big(x.cq) || cents(x.lv ?? '0') !== cents(x.cv))
          )
            problems.push('POOL_LAYERS')
          if (big(x.cq) !== big(x.sq)) problems.push('QUANTITY_STOCK')
          return {
            productId: x.product_id as string,
            variantId: (x.variant_id as string) ?? null,
            sku: x.sku as string,
            problems,
            ledger: { quantity: quantityText(big(x.eq)), value: moneyText(cents(x.ev)) },
            pool: { quantity: quantityText(big(x.cq)), value: moneyText(cents(x.cv)) },
            stockQuantity: quantityText(big(x.sq)),
          }
        })
        .filter((x) => x.problems.length)
      const zero = await scope.trx.rawQuery(
        `select count(distinct (product_id, variant_id))::int as n from stock_valuation_entries
          where tenant_id = ? and legal_entity_id = ? and source in ('ZERO', 'OPENING') and quantity > 0`,
        [t, legalEntityId]
      )
      return {
        legalEntityId,
        date: day,
        classes: lines,
        accounts: accountsView,
        unmappedClasses: lines
          .filter((l) => !l.account && cents(l.inventoryValue) !== 0n)
          .map((l) => l.accountingClass),
        internal: { checked: internal.rows.length, differences },
        productsWithoutCost: (zero.rows[0] as { n: number }).n,
      }
    })
  }
}
