import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts } from '#modules/organization/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import { supplierStanding } from '#modules/procurement/application/supplier_service'
import { isDate, money, parseScaled, scaledText } from '#modules/procurement/domain/requisitions'
import {
  addMonths,
  CONTRACT_EDITABLE,
  CONTRACT_SERIES_TYPE,
  CONTRACT_STATUSES,
  type ContractStatus,
  contractFitIssues,
  effectiveStatus,
  normalizeContractHeader,
  normalizePrices,
  normalizeSlas,
  renewalDue,
} from '#modules/procurement/domain/contracts'

/*
 * Contratos de fornecedor (9.6). Permissões no âmbito da entidade legal: `procurement.contracts.read`, `.manage`
 * (criar, alterar o rascunho, pedir aprovação, propor adendas e renovações, suspender, reactivar, terminar, anular) e
 * `.approve` (aprovar contratos e adendas — nunca os que a própria pessoa submeteu ou propôs). O consumo pelas ordens
 * de compra passa por `consumeContract` (idempotente, com o contrato bloqueado, nunca acima do máximo).
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const c2 = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const r3 = (v: unknown) => parseScaled(String(v ?? '0'), 3) ?? 0n
const today = () => new Date().toISOString().slice(0, 10)
const isoDate = (v: unknown) => {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v as Date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Scopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    read: await permissionScope(scope, 'procurement.contracts.read'),
    manage: await permissionScope(scope, 'procurement.contracts.manage'),
    approve: await permissionScope(scope, 'procurement.contracts.approve'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
const rights = (s: Scopes, le: string) => {
  const manage = covers(s.manage, le)
  const approve = covers(s.approve, le)
  return { read: manage || approve || covers(s.read, le), manage, approve }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const c = (
    await scope.trx.rawQuery(
      `select * from purchase_contracts where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) throw ApiError.notFound()
  return c
}

async function authorized(
  scope: TenantScope,
  id: string,
  need: 'read' | 'manage' | 'approve',
  lock = false
) {
  const c = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), c.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (need === 'manage' && !g.manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere contratos desta entidade.')
  if (need === 'approve' && !g.approve)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova contratos desta entidade.')
  return { c, g }
}

const versionCheck = (c: any, expected: unknown) => {
  if (Number(c.version) !== Number(expected)) throw ApiError.versionConflict(Number(c.version))
}
const reasonOf = (v: unknown) => {
  const r = text(v)
  if (!r) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}
const stateCheck = (c: any, allowed: readonly string[], message: string) => {
  if (!allowed.includes(c.status)) throw ApiError.conflict('INVALID_STATE', message)
}

async function event(
  scope: TenantScope,
  id: string,
  kind: string,
  e: { reason?: string | null; details?: Record<string, unknown> } = {}
) {
  await scope.trx.rawQuery(
    `insert into purchase_contract_events (tenant_id, contract_id, kind, reason, details, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      id,
      kind,
      e.reason ?? null,
      e.details ? JSON.stringify(e.details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function setContract(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update purchase_contracts set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** Preços: produto activo (não kit) ou descrição; unidade activa. */
async function pricesOf(scope: TenantScope, raw: unknown) {
  const t = scope.context.tenantId
  const { prices, issues } = normalizePrices(raw)
  const out: any[] = []
  for (const [i, p] of prices.entries()) {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `prices.${i}.${f}`, code, message })
    let { description, uomId } = p
    if (p.productId) {
      const r = (
        await scope.trx.rawQuery(
          `select name, status, product_type, base_uom_id, purchase_uom_id from products where tenant_id = ? and id = ?`,
          [t, p.productId]
        )
      ).rows[0] as any
      if (!r || r.status !== 'ACTIVE' || r.product_type === 'KIT')
        at('productId', 'NOT_FOUND', 'Produto inexistente, inactivo ou kit.')
      else {
        description ||= r.name
        uomId ||= r.purchase_uom_id ?? r.base_uom_id
      }
    }
    if (description.length < 3)
      at('description', 'REQUIRED', 'Produto do catálogo ou descrição (3 a 300 caracteres).')
    let uomCode: string | null = null
    if (uomId) {
      const u = (
        await scope.trx.rawQuery(`select code, status from uoms where tenant_id = ? and id = ?`, [
          t,
          uomId,
        ])
      ).rows[0] as any
      if (!u || u.status !== 'ACTIVE') at('uomId', 'NOT_FOUND', 'Unidade inexistente ou inactiva.')
      else uomCode = u.code
    }
    out.push({ ...p, description, uomId, uomCode })
  }
  return { prices: out, issues }
}

async function writePricesAndSlas(
  scope: TenantScope,
  id: string,
  prices: any[] | null,
  slas: any[] | null
) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  if (prices) {
    await scope.trx.rawQuery(
      `delete from purchase_contract_prices where tenant_id = ? and contract_id = ?`,
      [t, id]
    )
    for (const [i, p] of prices.entries())
      await scope.trx.rawQuery(
        `insert into purchase_contract_prices (tenant_id, contract_id, line_no, product_id, variant_id, description,
            uom_id, uom_code, unit_price, notes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t,
          id,
          i + 1,
          p.productId,
          p.variantId,
          p.description,
          p.uomId,
          p.uomCode,
          scaledText(p.unitPrice, 6),
          p.notes,
          u,
          u,
        ] as never[]
      )
  }
  if (slas) {
    await scope.trx.rawQuery(
      `delete from purchase_contract_slas where tenant_id = ? and contract_id = ?`,
      [t, id]
    )
    for (const [i, s] of slas.entries())
      await scope.trx.rawQuery(
        `insert into purchase_contract_slas (tenant_id, contract_id, line_no, metric, target, description, penalty,
            created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t, id, i + 1, s.metric, scaledText(s.target, 3), s.description, s.penalty, u, u] as never[]
      )
  }
}

const headerColumns = (v: ReturnType<typeof normalizeContractHeader>['values']) => ({
  title: v.title,
  object: v.object,
  start_date: v.startDate,
  end_date: v.endDate,
  max_amount: money(v.maxAmount),
  payment_terms_days: v.paymentTermsDays,
  auto_renew: v.autoRenew,
  renewal_notice_days: v.renewalNoticeDays,
  renewal_months: v.renewalMonths,
  notes: v.notes,
})

async function rowsOf(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const prices = (
    await scope.trx.rawQuery(
      `select p.*, pr.sku from purchase_contract_prices p left join products pr on pr.tenant_id = p.tenant_id
          and pr.id = p.product_id where p.tenant_id = ? and p.contract_id = ? order by p.line_no`,
      [t, id]
    )
  ).rows as any[]
  const slas = (
    await scope.trx.rawQuery(
      `select * from purchase_contract_slas where tenant_id = ? and contract_id = ? order by line_no`,
      [t, id]
    )
  ).rows as any[]
  return { prices, slas }
}
const priceView = (p: any) => ({
  id: p.id as string,
  lineNo: Number(p.line_no),
  product: p.product_id ? { id: p.product_id as string, sku: p.sku as string } : null,
  variantId: (p.variant_id as string) ?? null,
  description: p.description as string,
  uom: p.uom_id ? { id: p.uom_id as string, code: p.uom_code as string } : null,
  unitPrice: scaledText(q6(p.unit_price), 6),
  notes: (p.notes as string) ?? null,
})
const slaView = (s: any) => ({
  lineNo: Number(s.line_no),
  metric: s.metric as string,
  target: scaledText(r3(s.target), 3),
  description: (s.description as string) ?? null,
  penalty: (s.penalty as string) ?? null,
})

async function detail(scope: TenantScope, id: string) {
  const { c, g } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const info = (
    await scope.trx.rawQuery(
      `select le.code as le_code, bp.code as sup_code, bp.name as sup_name, us.full_name as submitted_name,
          ua.full_name as approved_name
         from purchase_contracts c join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id
         join suppliers s on s.tenant_id = c.tenant_id and s.id = c.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         left join users us on us.id = c.submitted_by left join users ua on ua.id = c.approved_by
        where c.tenant_id = ? and c.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const { prices, slas } = await rowsOf(scope, id)
  const amendments = (
    await scope.trx.rawQuery(
      `select a.*, ur.full_name as requested_name, ud.full_name as decided_name from purchase_contract_amendments a
         left join users ur on ur.id = a.requested_by left join users ud on ud.id = a.decided_by
        where a.tenant_id = ? and a.contract_id = ? order by a.amendment_no desc`,
      [t, id]
    )
  ).rows as any[]
  const orders = (
    await scope.trx.rawQuery(
      `select o.id, o.number, o.approval_status, o.currency, o.total_net, coalesce(sum(cc.amount), 0) as consumed
         from purchase_orders o left join purchase_contract_consumptions cc on cc.tenant_id = o.tenant_id
          and cc.order_id = o.id and cc.contract_id = o.contract_id
        where o.tenant_id = ? and o.contract_id = ? group by o.id order by o.created_at desc limit 200`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from purchase_contract_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.contract_id = ? order by e.created_at desc, e.id`,
      [t, id]
    )
  ).rows as any[]
  const status = c.status as ContractStatus
  const start = isoDate(c.start_date)!
  const end = isoDate(c.end_date)!
  const eff = effectiveStatus({ status, startDate: start, endDate: end }, today())
  const max = c2(c.max_amount)
  const consumed = c2(c.consumed_amount)
  const pending = amendments.find((a) => a.status === 'PENDING')
  const me = scope.context.userId
  return {
    id: c.id as string,
    version: Number(c.version),
    number: (c.number as string) ?? null,
    status,
    effectiveStatus: eff,
    legalEntity: { id: c.legal_entity_id as string, code: info.le_code as string },
    supplier: {
      id: c.supplier_id as string,
      code: info.sup_code as string,
      name: info.sup_name as string,
    },
    title: c.title as string,
    object: c.object as string,
    currency: c.currency as string,
    startDate: start,
    endDate: end,
    maxAmount: money(max),
    consumedAmount: money(consumed),
    remainingAmount: money(max - consumed),
    paymentTermsDays: c.payment_terms_days ?? null,
    autoRenew: c.auto_renew as boolean,
    renewalNoticeDays: Number(c.renewal_notice_days),
    renewalMonths: c.renewal_months ?? null,
    renewalDue: renewalDue(
      { status, endDate: end, renewalNoticeDays: Number(c.renewal_notice_days) },
      today()
    ),
    notes: (c.notes as string) ?? null,
    amendmentCount: Number(c.amendment_count),
    submittedAt: c.submitted_at ? new Date(c.submitted_at).toISOString() : null,
    submittedBy: (info.submitted_name as string) ?? null,
    approvedAt: c.approved_at ? new Date(c.approved_at).toISOString() : null,
    approvedBy: (info.approved_name as string) ?? null,
    rejectReason: (c.reject_reason as string) ?? null,
    suspendReason: (c.suspend_reason as string) ?? null,
    terminationReason: (c.termination_reason as string) ?? null,
    cancelReason: (c.cancel_reason as string) ?? null,
    prices: prices.map(priceView),
    slas: slas.map(slaView),
    amendments: amendments.map((a) => ({
      id: a.id as string,
      version: Number(a.version),
      amendmentNo: Number(a.amendment_no),
      kind: a.kind as 'CHANGE' | 'RENEWAL',
      reason: a.reason as string,
      effectiveDate: isoDate(a.effective_date)!,
      status: a.status as string,
      proposed: a.proposed,
      previous: a.previous ?? null,
      requestedBy: (a.requested_name as string) ?? null,
      decidedBy: (a.decided_name as string) ?? null,
      decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null,
      decisionReason: (a.decision_reason as string) ?? null,
      canDecide: g.approve && a.status === 'PENDING' && a.requested_by !== me,
      decideBlockedBy:
        g.approve && a.status === 'PENDING' && a.requested_by === me ? 'SELF_APPROVAL' : null,
      canCancel: g.manage && a.status === 'PENDING',
    })),
    orders: orders.map((o) => ({
      id: o.id as string,
      number: (o.number as string) ?? null,
      approvalStatus: o.approval_status as string,
      totalNet: money(c2(o.total_net)),
      consumed: money(c2(o.consumed)),
    })),
    history: events.map((e) => ({
      kind: e.kind as string,
      reason: (e.reason as string) ?? null,
      details: e.details ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: {
      edit: g.manage && CONTRACT_EDITABLE.includes(status),
      submit: g.manage && CONTRACT_EDITABLE.includes(status),
      decide: g.approve && status === 'PENDING_APPROVAL' && c.submitted_by !== me,
      decideBlockedBy:
        g.approve && status === 'PENDING_APPROVAL' && c.submitted_by === me
          ? 'SELF_APPROVAL'
          : null,
      amend: g.manage && (status === 'ACTIVE' || status === 'SUSPENDED') && !pending,
      suspend: g.manage && status === 'ACTIVE',
      reactivate: g.manage && status === 'SUSPENDED',
      terminate: g.manage && (status === 'ACTIVE' || status === 'SUSPENDED'),
      cancel: g.manage && ['DRAFT', 'REJECTED', 'PENDING_APPROVAL'].includes(status),
    },
  }
}

export type ContractDetail = Awaited<ReturnType<typeof detail>>

/** Valida o pedido de criação/alteração (cabeçalho, entidade, fornecedor homologado, moeda, preços e SLA). */
async function prepare(
  scope: TenantScope,
  s: Scopes,
  input: Record<string, unknown>,
  current: any | null
) {
  const h = normalizeContractHeader(input)
  const issues = [...h.issues]
  let leId: string = current?.legal_entity_id ?? ''
  if (!current) {
    const le = isUuid(input.legalEntityId)
      ? await legalEntityFacts(scope, input.legalEntityId)
      : null
    if (!le) issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade legal.' })
    else if (!covers(s.manage, le.id))
      throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere contratos desta entidade.')
    else leId = le.id
  }
  let supplierCurrency: string | null = null
  if (!isUuid(input.supplierId))
    issues.push({ path: 'supplierId', code: 'REQUIRED', message: 'Fornecedor.' })
  else {
    const st = await supplierStanding(scope, input.supplierId)
    if (!st)
      issues.push({ path: 'supplierId', code: 'NOT_FOUND', message: 'Fornecedor inexistente.' })
    else if (!st.canOrder)
      issues.push({
        path: 'supplierId',
        code: 'NOT_QUALIFIED',
        message: 'Fornecedor não homologado ou com documentos obrigatórios fora de validade.',
      })
    supplierCurrency =
      (
        (
          await scope.trx.rawQuery(
            `select currency from suppliers where tenant_id = ? and id = ?`,
            [scope.context.tenantId, input.supplierId]
          )
        ).rows[0] as any
      )?.currency ?? null
  }
  const le = leId ? await legalEntityFacts(scope, leId) : null
  const currency =
    text(input.currency).toUpperCase() ||
    current?.currency ||
    supplierCurrency ||
    le?.functionalCurrency ||
    ''
  if (!/^[A-Z]{3}$/.test(currency))
    issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: 3 letras.' })
  const p = await pricesOf(scope, input.prices)
  const sl = normalizeSlas(input.slas)
  fail([...issues, ...p.issues, ...sl.issues])
  return {
    h: h.values,
    leId,
    supplierId: input.supplierId as string,
    currency,
    prices: p.prices,
    slas: sl.slas,
  }
}

export class ContractService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      supplierId?: string
      renewalDue?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = s.read.tenant || s.manage.tenant || s.approve.tenant
      const les = [
        ...new Set([
          ...s.read.legalEntityIds,
          ...s.manage.legalEntityIds,
          ...s.approve.legalEntityIds,
        ]),
      ]
      if (!all && !les.length) return { items: [], total: 0 }
      const where = ['c.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all) {
        where.push('c.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      if (f.status === 'EXPIRED') where.push(`c.status = 'ACTIVE' and c.end_date < current_date`)
      else if (f.status && (CONTRACT_STATUSES as readonly string[]).includes(f.status)) {
        where.push('c.status = ?')
        params.push(f.status)
      }
      if (f.supplierId && isUuid(f.supplierId)) {
        where.push('c.supplier_id = ?')
        params.push(f.supplierId)
      }
      if (f.renewalDue)
        where.push(
          `c.status = 'ACTIVE' and c.end_date >= current_date and c.end_date <= current_date + c.renewal_notice_days`
        )
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(c.number, '')) like ? or lower(c.title) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like)
      }
      const from = `from purchase_contracts c join suppliers s on s.tenant_id = c.tenant_id and s.id = c.supplier_id
        join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select c.*, bp.code as sup_code, bp.name as sup_name, le.code as le_code ${from}
            order by c.created_at desc, c.id limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      const now = today()
      return {
        items: rows.map((c) => {
          const start = isoDate(c.start_date)!
          const end = isoDate(c.end_date)!
          return {
            id: c.id as string,
            version: Number(c.version),
            number: (c.number as string) ?? null,
            title: c.title as string,
            status: c.status as ContractStatus,
            effectiveStatus: effectiveStatus(
              { status: c.status, startDate: start, endDate: end },
              now
            ),
            legalEntity: { id: c.legal_entity_id as string, code: c.le_code as string },
            supplier: {
              id: c.supplier_id as string,
              code: c.sup_code as string,
              name: c.sup_name as string,
            },
            startDate: start,
            endDate: end,
            currency: c.currency as string,
            maxAmount: money(c2(c.max_amount)),
            consumedAmount: money(c2(c.consumed_amount)),
            renewalDue: renewalDue(
              { status: c.status, endDate: end, renewalNoticeDays: Number(c.renewal_notice_days) },
              now
            ),
          }
        }),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!s.manage.tenant && !s.manage.legalEntityIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere contratos.')
      const t = context.tenantId
      const q = (sql: string) => scope.trx.rawQuery(sql, [t]).then((r) => r.rows as any[])
      const suppliers: any[] = []
      for (const x of await q(
        `select s.id, s.currency, s.payment_terms_days, p.code, p.name from suppliers s join business_partners p
           on p.tenant_id = s.tenant_id and p.id = s.partner_id where s.tenant_id = ? and s.status = 'APPROVED' order by p.code`
      ))
        if ((await supplierStanding(scope, x.id))?.canOrder)
          suppliers.push({
            id: x.id,
            code: x.code,
            name: x.name,
            currency: x.currency,
            paymentTermsDays: x.payment_terms_days ?? null,
          })
      return {
        legalEntities: (
          await q(
            `select id, code, functional_currency from legal_entities where tenant_id = ? order by code`
          )
        )
          .filter((l) => covers(s.manage, l.id))
          .map((l) => ({ id: l.id, code: l.code, currency: l.functional_currency })),
        suppliers,
        uoms: await q(
          `select id, code, name from uoms where tenant_id = ? and status = 'ACTIVE' order by code`
        ),
        products: (
          await q(
            `select id, sku, name, coalesce(purchase_uom_id, base_uom_id) as uom_id from products
              where tenant_id = ? and status = 'ACTIVE' and product_type <> 'KIT' order by sku limit 1000`
          )
        ).map((p) => ({ id: p.id, sku: p.sku, name: p.name, uomId: p.uom_id })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!s.manage.tenant && !s.manage.legalEntityIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere contratos.')
      const p = await prepare(scope, s, input, null)
      const cols = {
        legal_entity_id: p.leId,
        supplier_id: p.supplierId,
        currency: p.currency,
        ...headerColumns(p.h),
      }
      const ins = await scope.trx.rawQuery(
        `insert into purchase_contracts (tenant_id, ${Object.keys(cols).join(', ')}, created_by, updated_by)
         values (?, ${Object.keys(cols)
           .map(() => '?')
           .join(', ')}, ?, ?) returning id`,
        [context.tenantId, ...Object.values(cols), context.userId, context.userId] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await writePricesAndSlas(scope, id, p.prices, p.slas)
      await event(scope, id, 'CREATED')
      await audit(scope, {
        action: 'purchase_contract.created',
        entityType: 'purchase_contract',
        entityId: id,
        changes: { maxAmount: { from: null, to: money(p.h.maxAmount) } },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      stateCheck(c, CONTRACT_EDITABLE, 'Só se altera em rascunho ou recusado (depois, por adenda).')
      const p = await prepare(scope, await scopesOf(scope), input, c)
      await setContract(scope, id, {
        supplier_id: p.supplierId,
        currency: p.currency,
        ...headerColumns(p.h),
        status: 'DRAFT',
        reject_reason: null,
      })
      await writePricesAndSlas(scope, id, p.prices, p.slas)
      await event(scope, id, 'UPDATED')
      await audit(scope, {
        action: 'purchase_contract.updated',
        entityType: 'purchase_contract',
        entityId: id,
        changes: { maxAmount: { from: money(c2(c.max_amount)), to: money(p.h.maxAmount) } },
      })
      return detail(scope, id)
    })
  }

  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      stateCheck(c, CONTRACT_EDITABLE, 'Só se pede aprovação de um rascunho ou recusado.')
      if (!(await supplierStanding(scope, c.supplier_id))?.canOrder)
        throw ApiError.conflict('NOT_QUALIFIED', 'O fornecedor deixou de estar homologado.')
      await setContract(scope, id, {
        status: 'PENDING_APPROVAL',
        submitted_at: new Date(),
        submitted_by: context.userId,
        reject_reason: null,
      })
      await event(scope, id, 'SUBMITTED')
      await audit(scope, {
        action: 'purchase_contract.submitted',
        entityType: 'purchase_contract',
        entityId: id,
        changes: { status: { from: c.status, to: 'PENDING_APPROVAL' } },
      })
      return detail(scope, id)
    })
  }

  /** Aprovar (número da série da entidade) ou recusar; nunca quem submeteu. */
  decide(
    context: TenantContext,
    id: string,
    decision: 'approve' | 'reject',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'approve', true)
      versionCheck(c, input.expectedVersion)
      stateCheck(c, ['PENDING_APPROVAL'], 'O contrato não está em aprovação.')
      if (c.submitted_by === context.userId)
        throw ApiError.forbidden('SELF_APPROVAL', 'Submeteu este contrato: não o pode decidir.')
      if (decision === 'reject') {
        const reason = reasonOf(input.reason)
        await setContract(scope, id, { status: 'REJECTED', reject_reason: reason })
        await event(scope, id, 'REJECTED', { reason })
        await audit(scope, {
          action: 'purchase_contract.rejected',
          entityType: 'purchase_contract',
          entityId: id,
          changes: { status: { from: 'PENDING_APPROVAL', to: 'REJECTED' } },
        })
        return detail(scope, id)
      }
      let number = c.number as string | null
      let seriesId = c.series_id as string | null
      if (!number) {
        const ser = await scope.trx.rawQuery(
          `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
              and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
              and branch_id is null order by code limit 1`,
          [context.tenantId, c.legal_entity_id, CONTRACT_SERIES_TYPE, today(), today()]
        )
        const series = ser.rows[0] as { id: string } | undefined
        if (!series)
          throw ApiError.conflict(
            'NO_SERIES',
            `Sem série documental ${CONTRACT_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
          )
        seriesId = series.id
        number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      }
      await setContract(scope, id, {
        status: 'ACTIVE',
        series_id: seriesId,
        number,
        approved_at: new Date(),
        approved_by: context.userId,
      })
      await event(scope, id, 'APPROVED', { details: { number } })
      await audit(scope, {
        action: 'purchase_contract.approved',
        entityType: 'purchase_contract',
        entityId: id,
        changes: {
          status: { from: 'PENDING_APPROVAL', to: 'ACTIVE' },
          number: { from: null, to: number },
        },
      })
      return detail(scope, id)
    })
  }

  /** Suspender, reactivar, terminar ou anular (com motivo, salvo reactivar). */
  transition(
    context: TenantContext,
    id: string,
    action: 'suspend' | 'reactivate' | 'terminate' | 'cancel',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      const rules = {
        suspend: { from: ['ACTIVE'], to: 'SUSPENDED', kind: 'SUSPENDED' },
        reactivate: { from: ['SUSPENDED'], to: 'ACTIVE', kind: 'REACTIVATED' },
        terminate: { from: ['ACTIVE', 'SUSPENDED'], to: 'TERMINATED', kind: 'TERMINATED' },
        cancel: {
          from: ['DRAFT', 'REJECTED', 'PENDING_APPROVAL'],
          to: 'CANCELLED',
          kind: 'CANCELLED',
        },
      }[action]
      stateCheck(c, rules.from, `Não é possível nesta fase (${c.status}).`)
      const reason = action === 'reactivate' ? text(input.reason) || null : reasonOf(input.reason)
      if (action === 'terminate' || action === 'cancel') {
        const pend = await scope.trx.rawQuery(
          `select 1 from purchase_contract_amendments where tenant_id = ? and contract_id = ? and status = 'PENDING'`,
          [context.tenantId, id]
        )
        if (pend.rows.length)
          throw ApiError.conflict(
            'AMENDMENT_PENDING',
            'Há uma adenda pendente: decida-a ou anule-a primeiro.'
          )
      }
      const set: Record<string, unknown> = { status: rules.to }
      if (action === 'suspend') set.suspend_reason = reason
      if (action === 'reactivate') set.suspend_reason = null
      if (action === 'terminate')
        Object.assign(set, { terminated_at: new Date(), termination_reason: reason })
      if (action === 'cancel') set.cancel_reason = reason
      await setContract(scope, id, set)
      await event(scope, id, rules.kind, { reason })
      await audit(scope, {
        action: `purchase_contract.${action === 'reactivate' ? 'reactivated' : action === 'suspend' ? 'suspended' : action === 'terminate' ? 'terminated' : 'cancelled'}`,
        entityType: 'purchase_contract',
        entityId: id,
        changes: { status: { from: c.status, to: rules.to } },
      })
      return detail(scope, id)
    })
  }

  /**
   * Propor uma adenda (alteração) ou renovação: o cabeçalho proposto inteiro e, se indicados, a nova tabela de preços e
   * os novos SLA. O máximo nunca abaixo do consumido; a renovação estende o fim (por omissão, fim + meses de renovação).
   */
  propose(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      stateCheck(
        c,
        ['ACTIVE', 'SUSPENDED'],
        'Só se altera por adenda um contrato activo ou suspenso.'
      )
      const kind = input.kind === 'RENEWAL' ? 'RENEWAL' : 'CHANGE'
      const reason = reasonOf(input.reason)
      const end = isoDate(c.end_date)!
      const current: Record<string, unknown> = {
        title: c.title,
        object: c.object,
        startDate: isoDate(c.start_date),
        endDate: end,
        maxAmount: money(c2(c.max_amount)),
        paymentTermsDays: c.payment_terms_days,
        autoRenew: c.auto_renew,
        renewalNoticeDays: c.renewal_notice_days,
        renewalMonths: c.renewal_months,
        notes: c.notes,
      }
      const EDITABLE_KEYS = [
        'title',
        'object',
        'endDate',
        'maxAmount',
        'paymentTermsDays',
        'autoRenew',
        'renewalNoticeDays',
        'renewalMonths',
        'notes',
      ]
      const merged: Record<string, unknown> = {
        ...current,
        ...(kind === 'RENEWAL' && !input.endDate && c.renewal_months
          ? { endDate: addMonths(end, Number(c.renewal_months)) }
          : {}),
        ...Object.fromEntries(
          Object.entries(input).filter(([k, v]) => EDITABLE_KEYS.includes(k) && v !== undefined)
        ),
      }
      const h = normalizeContractHeader(merged)
      const issues = [...h.issues]
      if (h.values.maxAmount < c2(c.consumed_amount))
        issues.push({
          path: 'maxAmount',
          code: 'BELOW_CONSUMED',
          message: `Já foram consumidos ${money(c2(c.consumed_amount))}: o máximo não pode ser menor.`,
        })
      if (kind === 'RENEWAL' && !(h.values.endDate > end))
        issues.push({
          path: 'endDate',
          code: 'NOT_EXTENDED',
          message: 'A renovação tem de estender o fim do contrato.',
        })
      const effective = input.effectiveDate ? input.effectiveDate : today()
      if (!isDate(effective))
        issues.push({ path: 'effectiveDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
      const p = input.prices !== undefined ? await pricesOf(scope, input.prices) : null
      const sl = input.slas !== undefined ? normalizeSlas(input.slas) : null
      fail([...issues, ...(p?.issues ?? []), ...(sl?.issues ?? [])])
      const changed =
        JSON.stringify(headerColumns(h.values)) !==
          JSON.stringify(headerColumns(normalizeContractHeader(current).values)) ||
        p !== null ||
        sl !== null
      if (!changed)
        fail([{ path: 'reason', code: 'NOTHING', message: 'A adenda não altera nada.' }])
      const proposed = {
        header: { ...h.values, maxAmount: money(h.values.maxAmount) },
        prices: p ? p.prices.map((x) => ({ ...x, unitPrice: scaledText(x.unitPrice, 6) })) : null,
        slas: sl ? sl.slas.map((x) => ({ ...x, target: scaledText(x.target, 3) })) : null,
      }
      const no =
        Number(
          (
            (
              await scope.trx.rawQuery(
                `select coalesce(max(amendment_no), 0)::int as n from purchase_contract_amendments where tenant_id = ? and contract_id = ?`,
                [context.tenantId, id]
              )
            ).rows[0] as any
          ).n
        ) + 1
      try {
        await scope.trx.rawQuery(
          `insert into purchase_contract_amendments (tenant_id, contract_id, amendment_no, kind, reason, effective_date,
              proposed, requested_by, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            id,
            no,
            kind,
            reason,
            effective,
            JSON.stringify(proposed),
            context.userId,
            context.userId,
            context.userId,
          ] as never[]
        )
      } catch (e: any) {
        if (e?.code === '23505')
          throw ApiError.conflict('AMENDMENT_PENDING', 'Já há uma adenda pendente neste contrato.')
        throw e
      }
      await setContract(scope, id, {})
      await event(scope, id, kind === 'RENEWAL' ? 'RENEWAL_PROPOSED' : 'AMENDMENT_PROPOSED', {
        reason,
        details: { amendmentNo: no },
      })
      await audit(scope, {
        action: 'purchase_contract.amendment_proposed',
        entityType: 'purchase_contract',
        entityId: id,
        changes: { amendmentNo: { from: null, to: no }, kind: { from: null, to: kind } },
      })
      return detail(scope, id)
    })
  }

  /** Decidir uma adenda: aprovada, aplica-se ao contrato (com a fotografia do anterior); nunca quem a propôs. */
  decideAmendment(
    context: TenantContext,
    amendmentId: string,
    decision: 'approve' | 'reject' | 'cancel',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(amendmentId)) throw ApiError.notFound()
      const t = context.tenantId
      const a = (
        await scope.trx.rawQuery(
          `select * from purchase_contract_amendments where tenant_id = ? and id = ? for update`,
          [t, amendmentId]
        )
      ).rows[0] as any
      if (!a) throw ApiError.notFound()
      const { c } = await authorized(
        scope,
        a.contract_id,
        decision === 'cancel' ? 'manage' : 'approve',
        true
      )
      versionCheck(a, input.expectedVersion)
      if (a.status !== 'PENDING')
        throw ApiError.conflict('INVALID_STATE', 'A adenda já foi decidida.')
      if (decision !== 'cancel' && a.requested_by === context.userId)
        throw ApiError.forbidden('SELF_APPROVAL', 'Propôs esta adenda: não a pode decidir.')
      const setA = async (set: Record<string, unknown>) => {
        const keys = Object.keys(set)
        await scope.trx.rawQuery(
          `update purchase_contract_amendments set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?,
              updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
          [...keys.map((k) => set[k]), context.userId, t, amendmentId] as never[]
        )
      }
      if (decision !== 'approve') {
        const reason = reasonOf(input.reason)
        await setA({
          status: decision === 'reject' ? 'REJECTED' : 'CANCELLED',
          decision_reason: reason,
          ...(decision === 'reject' ? { decided_at: new Date(), decided_by: context.userId } : {}),
        })
        await setContract(scope, c.id, {})
        await event(
          scope,
          c.id,
          decision === 'reject' ? 'AMENDMENT_REJECTED' : 'AMENDMENT_CANCELLED',
          {
            reason,
            details: { amendmentNo: Number(a.amendment_no) },
          }
        )
        await audit(scope, {
          action:
            decision === 'reject'
              ? 'purchase_contract.amendment_rejected'
              : 'purchase_contract.amendment_cancelled',
          entityType: 'purchase_contract',
          entityId: c.id,
          changes: { amendmentNo: { from: null, to: Number(a.amendment_no) } },
        })
        return detail(scope, c.id)
      }
      if (!['ACTIVE', 'SUSPENDED'].includes(c.status))
        throw ApiError.conflict('INVALID_STATE', 'O contrato já não está activo nem suspenso.')
      const prop = a.proposed as any
      if (c2(prop.header.maxAmount) < c2(c.consumed_amount))
        throw ApiError.conflict(
          'BELOW_CONSUMED',
          'Entretanto o consumido passou o máximo proposto.'
        )
      const before = await rowsOf(scope, c.id)
      const previous = {
        header: {
          title: c.title,
          object: c.object,
          startDate: isoDate(c.start_date),
          endDate: isoDate(c.end_date),
          maxAmount: money(c2(c.max_amount)),
          paymentTermsDays: c.payment_terms_days,
          autoRenew: c.auto_renew,
          renewalNoticeDays: c.renewal_notice_days,
          renewalMonths: c.renewal_months,
          notes: c.notes,
        },
        prices: prop.prices ? before.prices.map(priceView) : null,
        slas: prop.slas ? before.slas.map(slaView) : null,
      }
      // Marca a transacção: só aqui o contrato aprovado, os preços e os SLA podem mudar.
      await scope.trx.rawQuery(`select set_config('app.contract_amendment', ?, true)`, [c.id])
      const h = normalizeContractHeader(prop.header).values
      await setContract(scope, c.id, {
        ...headerColumns(h),
        amendment_count: Number(c.amendment_count) + 1,
      })
      await writePricesAndSlas(
        scope,
        c.id,
        prop.prices ? prop.prices.map((x: any) => ({ ...x, unitPrice: q6(x.unitPrice) })) : null,
        prop.slas ? prop.slas.map((x: any) => ({ ...x, target: r3(x.target) })) : null
      )
      await scope.trx.rawQuery(`select set_config('app.contract_amendment', '', true)`)
      await setA({
        status: 'APPROVED',
        previous: JSON.stringify(previous),
        decided_at: new Date(),
        decided_by: context.userId,
        decision_reason: text(input.reason) || null,
      })
      await event(scope, c.id, a.kind === 'RENEWAL' ? 'RENEWED' : 'AMENDED', {
        reason: a.reason,
        details: {
          amendmentNo: Number(a.amendment_no),
          endDate: h.endDate,
          maxAmount: money(h.maxAmount),
        },
      })
      await audit(scope, {
        action: a.kind === 'RENEWAL' ? 'purchase_contract.renewed' : 'purchase_contract.amended',
        entityType: 'purchase_contract',
        entityId: c.id,
        changes: {
          endDate: { from: previous.header.endDate, to: h.endDate },
          maxAmount: { from: previous.header.maxAmount, to: money(h.maxAmount) },
        },
      })
      return detail(scope, c.id)
    })
  }
}

// ---------- Contratos para as ordens de compra ----------

/** Contrato para uma ordem: valida o encaixe e devolve os preços (produto|variante → preço). Lança se não serve. */
export async function contractForOrder(
  scope: TenantScope,
  contractId: string,
  order: { legalEntityId: string; supplierId: string; currency: string; orderDate: string }
) {
  if (!isUuid(contractId))
    fail([{ path: 'contractId', code: 'NOT_FOUND', message: 'Contrato inexistente.' }])
  const c = (
    await scope.trx.rawQuery(`select * from purchase_contracts where tenant_id = ? and id = ?`, [
      scope.context.tenantId,
      contractId,
    ])
  ).rows[0] as any
  if (!c) fail([{ path: 'contractId', code: 'NOT_FOUND', message: 'Contrato inexistente.' }])
  const issues = contractFitIssues(
    {
      status: c.status,
      legalEntityId: c.legal_entity_id,
      supplierId: c.supplier_id,
      currency: c.currency,
      startDate: isoDate(c.start_date)!,
      endDate: isoDate(c.end_date)!,
    },
    order
  )
  fail(issues)
  const prices = (await rowsOf(scope, c.id)).prices
  return {
    id: c.id as string,
    number: c.number as string,
    remaining: c2(c.max_amount) - c2(c.consumed_amount),
    prices: new Map(
      prices
        .filter((p) => p.product_id)
        .map((p) => [`${p.product_id}|${p.variant_id ?? ''}`, q6(p.unit_price)])
    ),
  }
}

/** Consumido do contrato por esta ordem (soma dos movimentos). */
export async function consumedByOrder(scope: TenantScope, contractId: string, orderId: string) {
  const r = await scope.trx.rawQuery(
    `select coalesce(sum(amount), 0)::text as s from purchase_contract_consumptions
      where tenant_id = ? and contract_id = ? and order_id = ?`,
    [scope.context.tenantId, contractId, orderId]
  )
  return c2((r.rows[0] as any).s)
}

/**
 * Consumo (positivo) ou devolução (negativo) de uma ordem: idempotente pela chave; com o contrato bloqueado; consumo
 * novo só num contrato efectivamente activo e até ao máximo.
 */
export async function consumeContract(
  scope: TenantScope,
  input: { contractId: string; orderId: string; orderRevision: number; amount: bigint; key: string }
) {
  if (input.amount === 0n) return
  const t = scope.context.tenantId
  const prev = await scope.trx.rawQuery(
    `select amount::text as amount, order_id from purchase_contract_consumptions where tenant_id = ? and idempotency_key = ?`,
    [t, input.key]
  )
  const p = prev.rows[0] as any
  if (p) {
    if (c2(p.amount) !== input.amount || p.order_id !== input.orderId)
      throw ApiError.conflict('IDEMPOTENCY_MISMATCH', 'Esta chave já foi usada noutro consumo.')
    return
  }
  const c = (
    await scope.trx.rawQuery(
      `select * from purchase_contracts where tenant_id = ? and id = ? for update`,
      [t, input.contractId]
    )
  ).rows[0] as any
  if (!c) throw ApiError.notFound()
  const consumed = c2(c.consumed_amount)
  if (input.amount > 0n) {
    const eff = effectiveStatus(
      { status: c.status, startDate: isoDate(c.start_date)!, endDate: isoDate(c.end_date)! },
      today()
    )
    if (eff !== 'ACTIVE')
      throw ApiError.conflict(
        'CONTRACT_NOT_ACTIVE',
        `O contrato ${c.number} não está activo (${eff}).`
      )
    const remaining = c2(c.max_amount) - consumed
    if (input.amount > remaining)
      throw new ApiError(
        409,
        'CONTRACT_EXCEEDED',
        `O contrato ${c.number} só tem ${money(remaining)} ${c.currency} disponíveis.`,
        [{ path: 'contractId', code: 'CONTRACT_EXCEEDED', message: money(remaining) }]
      )
  } else if (-input.amount > consumed) {
    throw ApiError.conflict('OVER_RELEASED', 'Devolução maior do que o consumido.')
  }
  await scope.trx.rawQuery(
    `insert into purchase_contract_consumptions (tenant_id, contract_id, order_id, order_revision, amount, idempotency_key,
        created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t,
      input.contractId,
      input.orderId,
      input.orderRevision,
      money(input.amount),
      input.key,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  await scope.trx.rawQuery(
    `update purchase_contracts set consumed_amount = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
    [money(consumed + input.amount), t, input.contractId] as never[]
  )
  await event(scope, input.contractId, input.amount > 0n ? 'CONSUMED' : 'RELEASED', {
    details: { orderId: input.orderId, amount: money(input.amount) },
  })
}

/** Existe nesta empresa e o membro pode ler (anexos): `null` sem acesso. */
export async function purchaseContractAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const c = (
    await scope.trx.rawQuery(
      `select legal_entity_id from purchase_contracts where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) return null
  const g = rights(await scopesOf(scope), c.legal_entity_id)
  return g.read ? { read: true, write: g.manage } : null
}
