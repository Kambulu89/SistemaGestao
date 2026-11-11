import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { permissionScope } from '#modules/rbac/index'
import { readableWarehouseIds } from '#modules/inventory/application/warehouse_service'
import { quantityText } from '#modules/inventory/domain/stock'
import { costText, moneyText, parseScaled, unitCostOf } from '#modules/inventory/domain/valuation'
import {
  CONSUMPTION_CLASSES,
  expiryStatus,
  LOSS_CLASSES,
  movementClass,
  periodDays,
  replenishment,
  turnover,
  type MovementClass,
  type ReplenishmentStatus,
} from '#modules/inventory/domain/reports'

/*
 * Alertas e relatórios do inventário (8.11). Só leitura, calculados na hora a partir dos saldos, dos movimentos e do
 * livro de custo — não guardam nada, por isso estão sempre de acordo com o stock.
 *
 * Acesso: quantidades pelos armazéns que o membro pode consultar (a mesma regra dos saldos). Valores: só quando o
 * membro tem `inventory.valuation.read` em todas as entidades legais dos armazéns do relatório (senão vêm a `null`);
 * o inventário valorizado exige essa permissão na entidade.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ROWS = 1000
const VALUED = `('UNRESTRICTED','BLOCKED','QUARANTINE','IN_TRANSIT')`
const NO_CLASS = 'SEM_CLASSE'

const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6, true) ?? 0n
const c2 = (v: unknown) => parseScaled(String(v ?? '0'), 2, true) ?? 0n
const abs = (v: bigint) => (v < 0n ? -v : v)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}

interface Period {
  from: string
  to: string
}
function period(f: { from?: string; to?: string }): Period & { days: number } {
  const issues: ErrorDetail[] = []
  for (const k of ['from', 'to'] as const)
    if (!f[k] || !DATE.test(f[k]!) || Number.isNaN(Date.parse(`${f[k]}T00:00:00Z`)))
      issues.push({ path: k, code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  fail(issues)
  if (f.from! > f.to!)
    fail([{ path: 'to', code: 'INVALID', message: 'O fim é anterior ao início.' }])
  const days = periodDays(f.from!, f.to!)
  if (days > 1100) fail([{ path: 'to', code: 'TOO_LONG', message: 'Período máximo de três anos.' }])
  return { from: f.from!, to: f.to!, days }
}

interface Reach {
  warehouseIds: string[]
  /** O membro vê valores em todas as entidades destes armazéns. */
  values: boolean
}
/** Armazéns do relatório (os consultáveis, ou o pedido — 404 se não o vê) e se os valores podem ser mostrados. */
async function reach(scope: TenantScope, warehouseId?: string): Promise<Reach> {
  const readable = await readableWarehouseIds(scope)
  if (warehouseId && !readable.includes(warehouseId)) throw ApiError.notFound()
  const warehouseIds = warehouseId ? [warehouseId] : readable
  if (!warehouseIds.length) return { warehouseIds, values: false }
  const s = await permissionScope(scope, 'inventory.valuation.read')
  if (s.tenant) return { warehouseIds, values: true }
  const les = await scope.trx.rawQuery(
    'select distinct legal_entity_id from warehouses where tenant_id = ? and id = any(?::uuid[])',
    [scope.context.tenantId, warehouseIds] as never[]
  )
  const allowed = new Set(s.legalEntityIds)
  return {
    warehouseIds,
    values: (les.rows as any[]).every((r) => allowed.has(r.legal_entity_id as string)),
  }
}

const productOf = (r: any) => ({
  id: r.product_id as string,
  sku: r.sku as string,
  name: r.product_name as string,
})
const variantOf = (r: any) =>
  r.variant_id ? { id: r.variant_id as string, sku: (r.variant_sku as string) ?? null } : null

interface Replenishment {
  product: { id: string; sku: string; name: string }
  uom: string
  min: string | null
  max: string | null
  onHand: string
  available: string
  reserved: string
  incoming: string
  suggested: string
  status: ReplenishmentStatus
}
/** Produtos de stock activos com saldo nos armazéns (ou com mínimo e nunca stockados), com o estado de reposição. */
async function replenishmentRows(scope: TenantScope, r: Reach, q?: string) {
  if (!r.warehouseIds.length) return [] as Replenishment[]
  const where = [
    'p.tenant_id = ?',
    `p.product_type = 'STOCKABLE'`,
    `p.status = 'ACTIVE'`,
    // Com saldo nos armazéns do relatório, ou com mínimo e sem stock em lado nenhum (o que só existe noutros
    // armazéns não é ruptura aqui).
    `(b.product_id is not null or (p.min_stock is not null and not exists (
        select 1 from stock_balances x where x.tenant_id = p.tenant_id and x.product_id = p.id)))`,
  ]
  const params: unknown[] = [scope.context.tenantId, r.warehouseIds, scope.context.tenantId]
  if (q) {
    const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push('(lower(p.sku) like ? or lower(p.name) like ?)')
    params.push(like, like)
  }
  const rows = await scope.trx.rawQuery(
    `select p.id as product_id, p.sku, p.name as product_name, u.code as uom_code, p.min_stock, p.max_stock,
        coalesce(b.physical, 0) as physical, coalesce(b.unrestricted, 0) as unrestricted,
        coalesce(b.reserved, 0) as reserved, coalesce(b.incoming, 0) as incoming
       from products p
       join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
       left join (select product_id, sum(qty_unrestricted + qty_blocked + qty_quarantine) as physical,
            sum(qty_unrestricted) as unrestricted, sum(qty_reserved) as reserved,
            sum(qty_in_transit + qty_expected) as incoming
           from stock_balances where tenant_id = ? and warehouse_id = any(?::uuid[]) group by product_id) b
         on b.product_id = p.id
      where ${where.join(' and ')} order by p.sku`,
    params as never[]
  )
  return (rows.rows as any[]).map((x): Replenishment => {
    const available = q6(x.unrestricted) - q6(x.reserved)
    const min = x.min_stock === null ? null : q6(x.min_stock)
    const max = x.max_stock === null ? null : q6(x.max_stock)
    const s = replenishment({ available, incoming: q6(x.incoming), min, max })
    return {
      product: productOf(x),
      uom: x.uom_code as string,
      min: min === null ? null : quantityText(min),
      max: max === null ? null : quantityText(max),
      onHand: quantityText(q6(x.physical)),
      available: quantityText(available),
      reserved: quantityText(q6(x.reserved)),
      incoming: quantityText(q6(x.incoming)),
      suggested: quantityText(s.suggested),
      status: s.status,
    }
  })
}

/** Lotes com stock físico e validade até `days` dias (ou já expirados), por armazém. */
async function expiryRows(scope: TenantScope, r: Reach, days: number) {
  if (!r.warehouseIds.length) return []
  const rows = await scope.trx.rawQuery(
    `select b.warehouse_id, w.code as warehouse_code, b.product_id, p.sku, p.name as product_name,
        b.variant_id, v.sku as variant_sku, u.code as uom_code, l.id as lot_id, l.code as lot_code,
        l.status as lot_status, l.expiry_date::text as expiry, (l.expiry_date - current_date) as days_left,
        sum(b.qty_unrestricted + b.qty_blocked + b.qty_quarantine) as quantity
       from stock_balances b
       join stock_lots l on l.tenant_id = b.tenant_id and l.id = b.lot_id
       join products p on p.tenant_id = b.tenant_id and p.id = b.product_id
       join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
       join warehouses w on w.tenant_id = b.tenant_id and w.id = b.warehouse_id
       left join product_variants v on v.tenant_id = b.tenant_id and v.id = b.variant_id
      where b.tenant_id = ? and b.warehouse_id = any(?::uuid[]) and l.expiry_date is not null
        and l.expiry_date <= current_date + ?::int
      group by b.warehouse_id, w.code, b.product_id, p.sku, p.name, b.variant_id, v.sku, u.code, l.id, l.code,
        l.status, l.expiry_date
     having sum(b.qty_unrestricted + b.qty_blocked + b.qty_quarantine) > 0
      order by l.expiry_date, p.sku, l.code, w.code limit ${MAX_ROWS}`,
    [scope.context.tenantId, r.warehouseIds, days] as never[]
  )
  return (rows.rows as any[]).map((x) => ({
    warehouse: { id: x.warehouse_id as string, code: x.warehouse_code as string },
    product: productOf(x),
    variant: variantOf(x),
    uom: x.uom_code as string,
    lot: { id: x.lot_id as string, code: x.lot_code as string, status: x.lot_status as string },
    expiryDate: x.expiry as string,
    daysLeft: Number(x.days_left),
    status: expiryStatus(Number(x.days_left)),
    quantity: quantityText(q6(x.quantity)),
  }))
}

interface Flow {
  productId: string
  sku: string
  name: string
  uom: string
  class: MovementClass
  costCenterId: string | null
  /** Quantidade com sinal (entradas positivas) e valor do livro de custo, já líquidos de estornos. */
  quantity: bigint
  value: bigint
}
/**
 * Movimentos do período por produto e classe. Cada lançamento conta pelo efeito líquido no stock valorizado de cada
 * armazém (uma mudança de estado ou uma recepção de transferência no mesmo armazém dá zero); o estorno entra na classe
 * do original com o sinal contrário.
 */
async function flows(scope: TenantScope, r: Reach, p: Period, productId?: string): Promise<Flow[]> {
  if (!r.warehouseIds.length) return []
  const t = scope.context.tenantId
  const rows = await scope.trx.rawQuery(
    `with agg as (
       select m.posting_id, m.warehouse_id, m.product_id, m.variant_id, sum(m.quantity) as net
         from stock_movements m
        where m.tenant_id = ? and m.warehouse_id = any(?::uuid[]) and m.bucket in ${VALUED}
          and m.occurred_at >= ?::date and m.occurred_at < (?::date + 1)
          ${productId ? 'and m.product_id = ?' : ''}
        group by m.posting_id, m.warehouse_id, m.product_id, m.variant_id
       having sum(m.quantity) <> 0)
     select a.product_id, pr.sku, pr.name as product_name, u.code as uom_code, o.posting_type as otype,
        o.source_type, d.origin, (te.posting_id is not null) as transfer_loss, rq.cost_center_id,
        case when (a.net > 0) <> (p.posting_type = 'REVERSAL') then 'IN' else 'OUT' end as dir,
        sum(a.net) as quantity, sum(coalesce(ve.value, 0)) as value
       from agg a
       join stock_postings p on p.tenant_id = ? and p.id = a.posting_id
       join stock_postings o on o.tenant_id = p.tenant_id and o.id = coalesce(p.reversal_of_id, p.id)
       join warehouses w on w.tenant_id = p.tenant_id and w.id = a.warehouse_id
       join products pr on pr.tenant_id = p.tenant_id and pr.id = a.product_id
       join uoms u on u.tenant_id = pr.tenant_id and u.id = pr.base_uom_id
       left join stock_documents d on d.tenant_id = o.tenant_id and o.source_type = 'STOCK_DOCUMENT'
         and d.id = o.source_id
       left join stock_requisitions rq on rq.tenant_id = o.tenant_id
         and o.source_type = 'INTERNAL_REQUISITION' and rq.id = o.source_id
       left join (select distinct posting_id from stock_transfer_events where tenant_id = ? and kind = 'LOSS') te
         on te.posting_id = o.id
       left join lateral (select sum(e.value) as value from stock_valuation_entries e
          where e.tenant_id = p.tenant_id and e.posting_id = a.posting_id and e.product_id = a.product_id
            and e.variant_id is not distinct from a.variant_id and e.legal_entity_id = w.legal_entity_id) ve on true
      group by a.product_id, pr.sku, pr.name, u.code, o.posting_type, o.source_type, d.origin,
        (te.posting_id is not null), rq.cost_center_id,
        case when (a.net > 0) <> (p.posting_type = 'REVERSAL') then 'IN' else 'OUT' end`,
    [t, r.warehouseIds, p.from, p.to, ...(productId ? [productId] : []), t, t] as never[]
  )
  const out = new Map<string, Flow>()
  for (const x of rows.rows as any[]) {
    const cls = movementClass({
      type: x.otype as string,
      sourceType: (x.source_type as string) ?? null,
      documentOrigin: (x.origin as string) ?? null,
      transferLoss: x.transfer_loss === true,
      direction: x.dir as 'IN' | 'OUT',
    })
    const cc = (x.cost_center_id as string) ?? null
    const key = `${x.product_id}|${cls}|${cc ?? ''}`
    const f = out.get(key) ?? {
      productId: x.product_id as string,
      sku: x.sku as string,
      name: x.product_name as string,
      uom: x.uom_code as string,
      class: cls,
      costCenterId: cc,
      quantity: 0n,
      value: 0n,
    }
    f.quantity += q6(x.quantity)
    f.value += c2(x.value)
    out.set(key, f)
  }
  return [...out.values()].filter((f) => f.quantity !== 0n || f.value !== 0n)
}

const bySku = (a: { sku: string }, b: { sku: string }) => a.sku.localeCompare(b.sku)

export class InventoryReportService {
  /** Contadores para o painel de alertas: ruptura, reposição, a expirar e expirados. */
  alerts(context: TenantContext, f: { warehouseId?: string; days: number }) {
    return runInTenant(context, async (scope) => {
      const r = await reach(scope, f.warehouseId)
      const rep = await replenishmentRows(scope, r)
      const exp = await expiryRows(scope, r, f.days)
      const count = (s: ReplenishmentStatus) => rep.filter((x) => x.status === s).length
      return {
        days: f.days,
        stockout: count('STOCKOUT'),
        reorder: count('REORDER'),
        incoming: count('INCOMING'),
        expired: exp.filter((x) => x.status === 'EXPIRED').length,
        expiring: exp.filter((x) => x.status === 'EXPIRING').length,
      }
    })
  }

  /** Reposição e ruptura: por produto, o disponível contra o mínimo e a sugestão até ao máximo. */
  replenishment(
    context: TenantContext,
    f: { warehouseId?: string; status?: ReplenishmentStatus; q?: string }
  ) {
    return runInTenant(context, async (scope) => {
      const r = await reach(scope, f.warehouseId)
      const all = await replenishmentRows(scope, r, f.q)
      const rows = all.filter((x) => (f.status ? x.status === f.status : x.status !== 'OK'))
      return { rows: rows.slice(0, MAX_ROWS), total: rows.length }
    })
  }

  expiry(context: TenantContext, f: { warehouseId?: string; days: number }) {
    return runInTenant(context, async (scope) => {
      const rows = await expiryRows(scope, await reach(scope, f.warehouseId), f.days)
      return { days: f.days, rows, total: rows.length }
    })
  }

  /** Rotação e cobertura: consumo do período, stock médio (abertura e fecho), vezes rodado e dias de cobertura. */
  turnover(context: TenantContext, f: { warehouseId?: string; from?: string; to?: string }) {
    const p = period(f)
    return runInTenant(context, async (scope) => {
      const r = await reach(scope, f.warehouseId)
      if (!r.warehouseIds.length) return { ...p, rows: [], total: 0 }
      const t = scope.context.tenantId
      const consumed = new Map<string, bigint>()
      for (const x of await flows(scope, r, p))
        if (CONSUMPTION_CLASSES.includes(x.class))
          consumed.set(x.productId, (consumed.get(x.productId) ?? 0n) - x.quantity)
      const rows = await scope.trx.rawQuery(
        `select p.id as product_id, p.sku, p.name as product_name, u.code as uom_code,
            coalesce(b.valued, 0) as valued, coalesce(b.available, 0) as available,
            coalesce(m.since_from, 0) as since_from, coalesce(m.after_to, 0) as after_to
           from products p
           join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
           left join (select product_id,
                sum(qty_unrestricted + qty_blocked + qty_quarantine + qty_in_transit) as valued,
                sum(qty_unrestricted - qty_reserved) as available
               from stock_balances where tenant_id = ? and warehouse_id = any(?::uuid[]) group by product_id) b
             on b.product_id = p.id
           left join (select product_id,
                sum(quantity) filter (where occurred_at >= ?::date) as since_from,
                sum(quantity) filter (where occurred_at >= (?::date + 1)) as after_to
               from stock_movements where tenant_id = ? and warehouse_id = any(?::uuid[])
                and bucket in ${VALUED} and occurred_at >= ?::date group by product_id) m
             on m.product_id = p.id
          where p.tenant_id = ? and p.product_type = 'STOCKABLE'
            and (b.product_id is not null or m.product_id is not null) order by p.sku`,
        [t, r.warehouseIds, p.from, p.to, t, r.warehouseIds, p.from, t] as never[]
      )
      const out = (rows.rows as any[])
        .map((x) => {
          const now = q6(x.valued)
          const opening = now - q6(x.since_from)
          const closing = now - q6(x.after_to)
          const consumption = consumed.get(x.product_id as string) ?? 0n
          const k = turnover({
            consumption,
            opening,
            closing,
            available: q6(x.available),
            days: p.days,
          })
          return {
            product: productOf(x),
            uom: x.uom_code as string,
            opening: quantityText(opening),
            closing: quantityText(closing),
            average: quantityText(k.average),
            consumption: quantityText(consumption),
            dailyConsumption: quantityText(k.daily),
            turnover: k.turnover,
            available: quantityText(q6(x.available)),
            coverageDays: k.coverageDays,
          }
        })
        .filter((x) => x.opening !== '0.000000' || x.closing !== '0.000000' || x.turnover !== null)
      return { ...p, rows: out.slice(0, MAX_ROWS), total: out.length }
    })
  }

  /** Movimentos do período por produto e classe (entradas, saídas e valor), com totais por classe. */
  movements(
    context: TenantContext,
    f: { warehouseId?: string; productId?: string; from?: string; to?: string }
  ) {
    const p = period(f)
    return runInTenant(context, async (scope) => {
      const r = await reach(scope, f.warehouseId)
      const all = (await flows(scope, r, p, f.productId)).sort(
        (a, b) => bySku(a, b) || a.class.localeCompare(b.class)
      )
      // O centro de custo não interessa aqui: junta-se por produto e classe.
      const merged = new Map<string, Flow>()
      for (const x of all) {
        const k = `${x.productId}|${x.class}`
        const m = merged.get(k)
        if (m) {
          m.quantity += x.quantity
          m.value += x.value
        } else merged.set(k, { ...x, costCenterId: null })
      }
      const list = [...merged.values()]
      const totals = new Map<MovementClass, { in: bigint; out: bigint; value: bigint }>()
      for (const x of list) {
        const tt = totals.get(x.class) ?? { in: 0n, out: 0n, value: 0n }
        if (x.quantity > 0n) tt.in += x.quantity
        else tt.out -= x.quantity
        tt.value += x.value
        totals.set(x.class, tt)
      }
      return {
        ...p,
        values: r.values,
        rows: list.slice(0, MAX_ROWS).map((x) => ({
          product: { id: x.productId, sku: x.sku, name: x.name },
          uom: x.uom,
          class: x.class,
          quantityIn: quantityText(x.quantity > 0n ? x.quantity : 0n),
          quantityOut: quantityText(x.quantity < 0n ? -x.quantity : 0n),
          value: r.values ? moneyText(abs(x.value)) : null,
        })),
        total: list.length,
        // Sem unidade comum entre produtos, o total por classe só soma valores.
        totals: [...totals.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([cls, v]) => ({
            class: cls,
            direction: v.in >= v.out ? 'IN' : 'OUT',
            value: r.values ? moneyText(abs(v.value)) : null,
          })),
      }
    })
  }

  /** Perdas (quebras, perdas em trânsito, faltas de contagem) e sobras de contagem, por produto. */
  losses(context: TenantContext, f: { warehouseId?: string; from?: string; to?: string }) {
    const p = period(f)
    return runInTenant(context, async (scope) => {
      const r = await reach(scope, f.warehouseId)
      const merged = new Map<string, Flow>()
      for (const x of await flows(scope, r, p)) {
        if (!LOSS_CLASSES.includes(x.class) && x.class !== 'ADJUSTMENT_GAIN') continue
        const k = `${x.productId}|${x.class}`
        const m = merged.get(k)
        if (m) {
          m.quantity += x.quantity
          m.value += x.value
        } else merged.set(k, { ...x })
      }
      const list = [...merged.values()].sort(
        (a, b) => bySku(a, b) || a.class.localeCompare(b.class)
      )
      let lost = 0n
      let gained = 0n
      for (const x of list)
        if (x.class === 'ADJUSTMENT_GAIN') gained += abs(x.value)
        else lost += abs(x.value)
      return {
        ...p,
        values: r.values,
        rows: list.slice(0, MAX_ROWS).map((x) => ({
          product: { id: x.productId, sku: x.sku, name: x.name },
          uom: x.uom,
          class: x.class,
          quantity: quantityText(abs(x.quantity)),
          value: r.values ? moneyText(abs(x.value)) : null,
        })),
        total: list.length,
        totals: r.values
          ? { losses: moneyText(lost), gains: moneyText(gained), net: moneyText(lost - gained) }
          : null,
      }
    })
  }

  /** Consumo por centro de custo: o que as requisições internas entregaram (líquido de estornos), por produto. */
  consumption(context: TenantContext, f: { warehouseId?: string; from?: string; to?: string }) {
    const p = period(f)
    return runInTenant(context, async (scope) => {
      const r = await reach(scope, f.warehouseId)
      const list = (await flows(scope, r, p)).filter(
        (x) => x.class === 'CONSUMPTION' && x.costCenterId
      )
      const ids = [...new Set(list.map((x) => x.costCenterId!))]
      const names = new Map<string, { code: string; name: string }>()
      if (ids.length) {
        const cc = await scope.trx.rawQuery(
          'select id, code, name from cost_centers where tenant_id = ? and id = any(?::uuid[])',
          [scope.context.tenantId, ids] as never[]
        )
        for (const c of cc.rows as any[])
          names.set(c.id as string, { code: c.code as string, name: c.name as string })
      }
      const centers = new Map<string, bigint>()
      for (const x of list)
        centers.set(x.costCenterId!, (centers.get(x.costCenterId!) ?? 0n) + abs(x.value))
      const code = (id: string) => names.get(id)?.code ?? ''
      list.sort((a, b) => code(a.costCenterId!).localeCompare(code(b.costCenterId!)) || bySku(a, b))
      return {
        ...p,
        values: r.values,
        rows: list.slice(0, MAX_ROWS).map((x) => ({
          costCenter: {
            id: x.costCenterId!,
            ...(names.get(x.costCenterId!) ?? { code: '', name: '' }),
          },
          product: { id: x.productId, sku: x.sku, name: x.name },
          uom: x.uom,
          quantity: quantityText(abs(x.quantity)),
          value: r.values ? moneyText(abs(x.value)) : null,
        })),
        total: list.length,
        totals: [...centers.entries()]
          .map(([id, v]) => ({
            costCenter: { id, ...(names.get(id) ?? { code: '', name: '' }) },
            value: r.values ? moneyText(v) : null,
          }))
          .sort((a, b) => a.costCenter.code.localeCompare(b.costCenter.code)),
      }
    })
  }

  /** Inventário valorizado à data: quantidade, valor e custo unitário por produto, com totais por classe. */
  valued(context: TenantContext, f: { legalEntityId: string; date?: string }) {
    if (
      f.date !== undefined &&
      (!DATE.test(f.date) || Number.isNaN(Date.parse(`${f.date}T00:00:00Z`)))
    )
      fail([{ path: 'date', code: 'INVALID', message: 'Data AAAA-MM-DD.' }])
    return runInTenant(context, async (scope) => {
      const t = scope.context.tenantId
      const le = await scope.trx.rawQuery(
        'select id, code, functional_currency from legal_entities where tenant_id = ? and id = ?',
        [t, f.legalEntityId]
      )
      if (!le.rows.length) throw ApiError.notFound()
      const s = await permissionScope(scope, 'inventory.valuation.read')
      if (!s.tenant && !s.legalEntityIds.has(f.legalEntityId))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não tem acesso ao valor do stock desta entidade.')
      const date = f.date ?? new Date().toISOString().slice(0, 10)
      const rows = await scope.trx.rawQuery(
        `select e.product_id, p.sku, p.name as product_name, e.variant_id, v.sku as variant_sku, u.code as uom_code,
            p.valuation_method, coalesce(p.accounting_class, c.accounting_class, '${NO_CLASS}') as class,
            sum(e.quantity) as quantity, sum(e.value) as value
           from stock_valuation_entries e
           join products p on p.tenant_id = e.tenant_id and p.id = e.product_id
           join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
           left join product_categories c on c.tenant_id = p.tenant_id and c.id = p.category_id
           left join product_variants v on v.tenant_id = e.tenant_id and v.id = e.variant_id
          where e.tenant_id = ? and e.legal_entity_id = ? and e.occurred_at < (?::date + 1)
          group by e.product_id, p.sku, p.name, e.variant_id, v.sku, u.code, p.valuation_method,
            coalesce(p.accounting_class, c.accounting_class, '${NO_CLASS}')
         having sum(e.quantity) <> 0 or sum(e.value) <> 0
          order by p.sku, v.sku nulls first`,
        [t, f.legalEntityId, date] as never[]
      )
      const classes = new Map<string, bigint>()
      let total = 0n
      const list = (rows.rows as any[]).map((x) => {
        const q = q6(x.quantity)
        const v = c2(x.value)
        classes.set(x.class as string, (classes.get(x.class as string) ?? 0n) + v)
        total += v
        return {
          product: productOf(x),
          variant: variantOf(x),
          uom: x.uom_code as string,
          method: x.valuation_method as string,
          class: x.class as string,
          quantity: quantityText(q),
          unitCost: costText(unitCostOf(v, q)),
          value: moneyText(v),
        }
      })
      const e = le.rows[0] as any
      return {
        legalEntity: { id: e.id as string, code: e.code as string },
        currency: (e.functional_currency as string) ?? null,
        date,
        rows: list.slice(0, MAX_ROWS),
        total: list.length,
        totals: {
          value: moneyText(total),
          classes: [...classes.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([cls, v]) => ({ class: cls, value: moneyText(v) })),
        },
      }
    })
  }
}
