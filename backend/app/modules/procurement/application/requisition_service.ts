import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts } from '#modules/organization/index'
import { rateOn, reserveDocumentNumber } from '#modules/settings/index'
import {
  CAN,
  fulfilmentStatus,
  isDate,
  type Level,
  lineAmounts,
  money,
  nextStep,
  normalizeLines,
  OPEN,
  parseScaled,
  PRIORITIES,
  REQUISITION_STATUSES,
  requiredLevels,
  type RequisitionStatus,
  scaledText,
  SERIES_TYPE,
  toFunctional,
} from '#modules/procurement/domain/requisitions'
import { syncCommitments } from '#modules/procurement/application/finance_service'

/*
 * Requisições de compra (9.2). Permissões com âmbito: `procurement.requisitions.request` (departamento, filial,
 * entidade ou só as próprias), `.approve` (departamento, filial ou entidade) e `.process` (compradores: entidade ou
 * filial — necessidades consolidadas, fecho do resto). Afectações às cotações/ordens pelo contrato `allocateRequisition`.
 * Tudo auditado; decisões, afectações e histórico só de acréscimo.
 */

const KEY = /^[A-Za-z0-9:._-]{8,120}$/
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const today = () => new Date().toISOString().slice(0, 10)
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const big = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const cents = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n

interface Scopes {
  request: PermissionScope
  approve: PermissionScope
  process: PermissionScope
}
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    request: await permissionScope(scope, 'procurement.requisitions.request'),
    approve: await permissionScope(scope, 'procurement.requisitions.approve'),
    process: await permissionScope(scope, 'procurement.requisitions.process'),
  }
}
const anyScope = (s: PermissionScope) =>
  s.tenant || s.own || s.legalEntityIds.size > 0 || s.branchIds.size > 0 || s.departmentIds.size > 0
type Place = { departmentId: string; legalEntityId: string; branchId: string | null }
const covers = (s: PermissionScope, p: Place) =>
  s.tenant ||
  s.legalEntityIds.has(p.legalEntityId) ||
  (!!p.branchId && s.branchIds.has(p.branchId)) ||
  s.departmentIds.has(p.departmentId)
const coversEntity = (s: PermissionScope, p: Omit<Place, 'departmentId'>) =>
  s.tenant || s.legalEntityIds.has(p.legalEntityId) || (!!p.branchId && s.branchIds.has(p.branchId))

function rights(s: Scopes, r: any, me: string) {
  const place: Place = {
    departmentId: r.department_id,
    legalEntityId: r.legal_entity_id,
    branchId: r.branch_id ?? null,
  }
  const mine = r.requested_by_membership_id === me
  const request = covers(s.request, place) || (mine && anyScope(s.request))
  const approve = covers(s.approve, place)
  const process = coversEntity(s.process, place)
  return { request, approve, process, mine, read: request || approve || process }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select * from purchase_requisitions where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  const x = r.rows[0] as any
  if (!x) throw ApiError.notFound()
  return x
}

async function authorized(
  scope: TenantScope,
  id: string,
  need: 'read' | 'request' | 'approve' | 'process',
  lock = false
) {
  const r = await load(scope, id, lock)
  const s = await scopesOf(scope)
  const g = rights(s, r, scope.context.membershipId)
  if (!g.read) throw ApiError.notFound()
  if (need !== 'read' && !g[need])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      {
        request: 'Não pode alterar requisições deste departamento.',
        approve: 'Não aprova requisições deste departamento.',
        process: 'Não trata requisições desta entidade.',
      }[need]
    )
  return { r, g, s }
}

const versionCheck = (r: any, expected: unknown) => {
  if (Number(r.version) !== Number(expected)) throw ApiError.versionConflict(Number(r.version))
}
const stateCheck = (r: any, action: keyof typeof CAN) => {
  if (!CAN[action].includes(r.status))
    throw ApiError.conflict('INVALID_STATE', `Não é possível nesta fase (${r.status}).`)
}
const reasonOf = (v: unknown) => {
  const r = text(v)
  if (!r) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}

async function event(
  scope: TenantScope,
  id: string,
  kind: string,
  e: { from?: string; to?: string; reason?: string | null; details?: Record<string, unknown> } = {}
) {
  await scope.trx.rawQuery(
    `insert into purchase_requisition_events (tenant_id, requisition_id, kind, from_status, to_status, reason, details,
        created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      id,
      kind,
      e.from ?? null,
      e.to ?? null,
      e.reason ?? null,
      e.details ? JSON.stringify(e.details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function setStatus(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update purchase_requisitions set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** Valida o cabeçalho contra a base (departamento no âmbito de quem pede, centro de custo da mesma entidade). */
async function header(scope: TenantScope, s: Scopes, input: Record<string, unknown>) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  let dept: any = null
  if (!isUuid(input.departmentId))
    issues.push({ path: 'departmentId', code: 'REQUIRED', message: 'Departamento.' })
  else {
    const d = await scope.trx.rawQuery(
      `select id, legal_entity_id, branch_id, status from departments where tenant_id = ? and id = ?`,
      [t, input.departmentId]
    )
    dept = d.rows[0] ?? null
    if (!dept || dept.status !== 'ACTIVE')
      issues.push({
        path: 'departmentId',
        code: 'NOT_FOUND',
        message: 'Departamento inexistente ou inactivo.',
      })
  }
  let le: Awaited<ReturnType<typeof legalEntityFacts>> = null
  if (dept) {
    le = await legalEntityFacts(scope, dept.legal_entity_id)
    const place = {
      departmentId: dept.id,
      legalEntityId: dept.legal_entity_id,
      branchId: dept.branch_id,
    }
    if (!covers(s.request, place) && !(s.request.own && anyScope(s.request)))
      throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode requisitar para este departamento.')
  }
  let costCenterId: string | null = null
  if (input.costCenterId) {
    const c = isUuid(input.costCenterId)
      ? (
          await scope.trx.rawQuery(
            `select legal_entity_id, status from cost_centers where tenant_id = ? and id = ?`,
            [t, input.costCenterId]
          )
        ).rows[0]
      : null
    if (!c || (c as any).status !== 'ACTIVE')
      issues.push({
        path: 'costCenterId',
        code: 'NOT_FOUND',
        message: 'Centro de custo inexistente ou inactivo.',
      })
    else if (dept && (c as any).legal_entity_id !== dept.legal_entity_id)
      issues.push({
        path: 'costCenterId',
        code: 'OTHER_LEGAL_ENTITY',
        message: 'O centro de custo é de outra entidade.',
      })
    else costCenterId = input.costCenterId as string
  } else if (dept) {
    const dc = await scope.trx.rawQuery(
      `select cost_center_id from departments where tenant_id = ? and id = ?`,
      [t, dept.id]
    )
    costCenterId = ((dc.rows[0] as any)?.cost_center_id as string) ?? null
  }
  const priority = (input.priority ?? 'NORMAL') as string
  if (!(PRIORITIES as readonly string[]).includes(priority))
    issues.push({ path: 'priority', code: 'INVALID', message: 'Baixa, normal, alta ou urgente.' })
  if (!isDate(input.neededBy))
    issues.push({ path: 'neededBy', code: 'INVALID', message: 'Data de necessidade AAAA-MM-DD.' })
  const purpose = text(input.purpose)
  if (purpose.length < 3 || purpose.length > 500)
    issues.push({ path: 'purpose', code: 'LENGTH', message: 'Finalidade: 3 a 500 caracteres.' })
  const budget = text(input.budgetReference) || null
  if (budget && budget.length > 60)
    issues.push({ path: 'budgetReference', code: 'LENGTH', message: 'Até 60 caracteres.' })
  const currency = (text(input.currency).toUpperCase() || le?.functionalCurrency) ?? ''
  if (!/^[A-Z]{3}$/.test(currency))
    issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: código ISO de 3 letras.' })
  return {
    issues,
    values: {
      legal_entity_id: dept?.legal_entity_id,
      branch_id: dept?.branch_id ?? null,
      department_id: dept?.id,
      cost_center_id: costCenterId,
      priority,
      needed_by: input.neededBy,
      purpose,
      budget_reference: budget,
      currency,
    },
  }
}

/** Linhas validadas contra o catálogo (produto activo, variante do produto, unidade, fornecedor sugerido). */
async function linesOf(scope: TenantScope, raw: unknown) {
  const t = scope.context.tenantId
  const { lines, issues } = normalizeLines(raw)
  const out: (ReturnType<typeof normalizeLines>['lines'][number] & { uomCode: string | null })[] =
    []
  for (const [i, l] of lines.entries()) {
    const at = (field: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${field}`, code, message })
    let uomId = l.uomId
    let uomCode: string | null = null
    let description = l.description
    if (l.productId) {
      const p = isUuid(l.productId)
        ? (
            await scope.trx.rawQuery(
              `select p.name, p.status, p.product_type, p.base_uom_id, p.purchase_uom_id from products p
                where p.tenant_id = ? and p.id = ?`,
              [t, l.productId]
            )
          ).rows[0]
        : null
      if (!p || (p as any).status !== 'ACTIVE' || (p as any).product_type === 'KIT')
        at('productId', 'NOT_FOUND', 'Produto inexistente, inactivo ou kit.')
      else {
        description ||= (p as any).name
        uomId ||= (p as any).purchase_uom_id ?? (p as any).base_uom_id
      }
      if (l.variantId) {
        const v = isUuid(l.variantId)
          ? (
              await scope.trx.rawQuery(
                `select product_id, status from product_variants where tenant_id = ? and id = ?`,
                [t, l.variantId]
              )
            ).rows[0]
          : null
        if (!v || (v as any).product_id !== l.productId || (v as any).status !== 'ACTIVE')
          at('variantId', 'NOT_FOUND', 'Variante inexistente ou de outro produto.')
      }
    }
    if (uomId) {
      const u = isUuid(uomId)
        ? (
            await scope.trx.rawQuery(
              `select code, status from uoms where tenant_id = ? and id = ?`,
              [t, uomId]
            )
          ).rows[0]
        : null
      if (!u || (u as any).status !== 'ACTIVE')
        at('uomId', 'NOT_FOUND', 'Unidade inexistente ou inactiva.')
      else uomCode = (u as any).code
    }
    if (l.suggestedSupplierId) {
      const s = isUuid(l.suggestedSupplierId)
        ? (
            await scope.trx.rawQuery(`select 1 from suppliers where tenant_id = ? and id = ?`, [
              t,
              l.suggestedSupplierId,
            ])
          ).rows[0]
        : null
      if (!s) at('suggestedSupplierId', 'NOT_FOUND', 'Fornecedor inexistente.')
    }
    out.push({ ...l, description, uomId, uomCode })
  }
  fail(issues)
  return out
}

async function writeLines(
  scope: TenantScope,
  id: string,
  lines: Awaited<ReturnType<typeof linesOf>>
) {
  const t = scope.context.tenantId
  await scope.trx.rawQuery(
    `delete from purchase_requisition_lines where tenant_id = ? and requisition_id = ?`,
    [t, id]
  )
  let net = 0n
  let tax = 0n
  for (const [i, l] of lines.entries()) {
    const a = lineAmounts(l.quantity, l.unitPrice, l.taxRate)
    net += a.net
    tax += a.tax
    await scope.trx.rawQuery(
      `insert into purchase_requisition_lines (tenant_id, requisition_id, line_no, product_id, variant_id, description,
          uom_id, uom_code, quantity, estimated_unit_price, tax_rate, net_amount, tax_amount, total_amount, needed_by,
          suggested_supplier_id, notes, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        id,
        i + 1,
        l.productId,
        l.variantId,
        l.description,
        l.uomId,
        l.uomCode,
        scaledText(l.quantity, 6),
        scaledText(l.unitPrice, 6),
        scaledText(l.taxRate, 3),
        money(a.net),
        money(a.tax),
        money(a.total),
        l.neededBy,
        l.suggestedSupplierId,
        l.notes,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
  }
  return { net: money(net), tax: money(tax), total: money(net + tax) }
}

async function myRoleIds(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select role_id from membership_roles where tenant_id = ? and membership_id = ?`,
    [scope.context.tenantId, scope.context.membershipId]
  )
  return new Set((r.rows as any[]).map((x) => x.role_id as string))
}

const statusOf = (r: any) => r.status as RequisitionStatus

/** Ficha completa: cabeçalho, linhas com o que falta encomendar, cadeia de aprovação, histórico e o que posso fazer. */
async function detail(scope: TenantScope, id: string) {
  const { r, g } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const [lines, approvals, events, refs] = await Promise.all([
    scope.trx.rawQuery(
      `select l.*, p.sku, v.sku as variant_sku, sp.code as supplier_code, sp.name as supplier_name
         from purchase_requisition_lines l
         left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
         left join suppliers s on s.tenant_id = l.tenant_id and s.id = l.suggested_supplier_id
         left join business_partners sp on sp.tenant_id = s.tenant_id and sp.id = s.partner_id
        where l.tenant_id = ? and l.requisition_id = ? order by l.line_no`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select a.*, u.full_name from purchase_requisition_approvals a left join users u on u.id = a.decided_by_user_id
        where a.tenant_id = ? and a.requisition_id = ? order by a.sequence`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select e.*, u.full_name from purchase_requisition_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.requisition_id = ? order by e.created_at desc, e.id`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select le.code as le_code, d.code as dept_code, d.name as dept_name, cc.code as cc_code, cc.name as cc_name,
          u.full_name as requester_name
         from purchase_requisitions r
         join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
         join departments d on d.tenant_id = r.tenant_id and d.id = r.department_id
         left join cost_centers cc on cc.tenant_id = r.tenant_id and cc.id = r.cost_center_id
         left join users u on u.id = r.requested_by_user_id
        where r.tenant_id = ? and r.id = ?`,
      [t, id]
    ),
  ])
  const ref = refs.rows[0] as any
  const required: Level[] = (r.required_levels as Level[] | null) ?? []
  const decided = (approvals.rows as any[]).map((a) => ({
    sequence: Number(a.sequence),
    membershipId: a.decided_by_membership_id as string,
  }))
  const next =
    r.status === 'PENDING_APPROVAL'
      ? nextStep(required, decided, {
          membershipId: scope.context.membershipId,
          isRequester: g.mine,
          roleIds: await myRoleIds(scope),
        })
      : null
  const lineRows = (lines.rows as any[]).map((l) => {
    const q = big(l.quantity)
    const ordered = big(l.ordered_quantity)
    const closed = big(l.closed_quantity)
    return {
      id: l.id as string,
      lineNo: Number(l.line_no),
      product: l.product_id ? { id: l.product_id as string, sku: l.sku as string } : null,
      variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
      description: l.description as string,
      uom: l.uom_id ? { id: l.uom_id as string, code: l.uom_code as string } : null,
      quantity: scaledText(q, 6),
      estimatedUnitPrice: scaledText(big(l.estimated_unit_price), 6),
      taxRate: scaledText(parseScaled(String(l.tax_rate), 3) ?? 0n, 3),
      netAmount: money(cents(l.net_amount)),
      taxAmount: money(cents(l.tax_amount)),
      totalAmount: money(cents(l.total_amount)),
      neededBy: (l.needed_by as Date | null) ? isoDate(l.needed_by) : null,
      suggestedSupplier: l.suggested_supplier_id
        ? { id: l.suggested_supplier_id as string, code: l.supplier_code, name: l.supplier_name }
        : null,
      notes: l.notes as string | null,
      orderedQuantity: scaledText(ordered, 6),
      closedQuantity: scaledText(closed, 6),
      openQuantity: scaledText(q - ordered - closed, 6),
    }
  })
  const st = statusOf(r)
  return {
    id: r.id as string,
    version: Number(r.version),
    number: (r.number as string) ?? null,
    status: st,
    legalEntity: { id: r.legal_entity_id as string, code: ref.le_code as string },
    branchId: (r.branch_id as string) ?? null,
    department: {
      id: r.department_id as string,
      code: ref.dept_code as string,
      name: ref.dept_name as string,
    },
    costCenter: r.cost_center_id
      ? { id: r.cost_center_id as string, code: ref.cc_code as string, name: ref.cc_name as string }
      : null,
    requestedBy: {
      membershipId: r.requested_by_membership_id as string,
      name: (ref.requester_name as string) ?? null,
    },
    priority: r.priority as string,
    neededBy: isoDate(r.needed_by),
    purpose: r.purpose as string,
    budgetReference: (r.budget_reference as string) ?? null,
    currency: r.currency as string,
    totalNet: money(cents(r.total_net)),
    totalTax: money(cents(r.total_tax)),
    totalAmount: money(cents(r.total_amount)),
    totalFunctional: r.total_functional === null ? null : money(cents(r.total_functional)),
    exchangeRate: (r.exchange_rate as string) ?? null,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    rejectReason: (r.reject_reason as string) ?? null,
    cancelReason: (r.cancel_reason as string) ?? null,
    closeReason: (r.close_reason as string) ?? null,
    copiedFromId: (r.copied_from_id as string) ?? null,
    lines: lineRows,
    approval: required.map((lv) => {
      const a = (approvals.rows as any[]).find((x) => Number(x.sequence) === lv.sequence)
      return {
        sequence: lv.sequence,
        code: lv.code,
        name: lv.name,
        requiresRole: !!lv.approverRoleId,
        decision: (a?.decision as string) ?? null,
        decidedBy: a ? ((a.full_name as string) ?? null) : null,
        decidedAt: a ? new Date(a.created_at).toISOString() : null,
        reason: (a?.reason as string) ?? null,
        current: next?.step?.sequence === lv.sequence,
      }
    }),
    history: (events.rows as any[]).map((e) => ({
      kind: e.kind as string,
      fromStatus: e.from_status as string | null,
      toStatus: e.to_status as string | null,
      reason: e.reason as string | null,
      details: e.details ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: {
      edit: g.request && CAN.edit.includes(st),
      submit: g.request && CAN.submit.includes(st),
      decide: g.approve && !!next?.allowed,
      decideBlockedBy: g.approve && next && !next.allowed ? next.reason : null,
      cancel: (g.request || g.process) && CAN.cancel.includes(st),
      close: g.process && CAN.close.includes(st),
      copy: g.request,
    },
  }
}

function isoDate(v: unknown) {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v as Date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export type RequisitionDetail = Awaited<ReturnType<typeof detail>>

/**
 * Contrato para cotações e ordens (9.3/9.5): consome (quantidade positiva) ou devolve (negativa) quantidade de uma
 * linha aprovada, com chave de idempotência. Não ultrapassa o que está em aberto nem devolve mais do que foi consumido.
 * Na transacção de quem chama; a permissão é de quem chama.
 */
export async function allocateRequisition(
  scope: TenantScope,
  input: {
    lineId: string
    quantity: string
    sourceType: string
    sourceId: string
    sourceLineId?: string | null
    idempotencyKey: string
  }
) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  if (!KEY.test(input.idempotencyKey ?? ''))
    issues.push({
      path: 'idempotencyKey',
      code: 'INVALID',
      message: 'Chave de idempotência inválida.',
    })
  const neg = String(input.quantity ?? '')
    .trim()
    .startsWith('-')
  const abs = parseScaled(
    String(input.quantity ?? '')
      .trim()
      .replace(/^-/, ''),
    6
  )
  if (abs === null || abs === 0n)
    issues.push({
      path: 'quantity',
      code: 'INVALID',
      message: 'Quantidade diferente de zero, até 6 casas.',
    })
  if (!/^[A-Z_]{2,30}$/.test(input.sourceType ?? '') || !isUuid(input.sourceId))
    issues.push({ path: 'source', code: 'INVALID', message: 'Origem inválida.' })
  fail(issues)
  const q = neg ? -abs! : abs!
  if (!isUuid(input.lineId)) throw ApiError.notFound()
  const lr = await scope.trx.rawQuery(
    `select l.id, l.requisition_id, l.quantity, l.ordered_quantity, l.closed_quantity
       from purchase_requisition_lines l where l.tenant_id = ? and l.id = ?`,
    [t, input.lineId]
  )
  const line = lr.rows[0] as any
  if (!line) throw ApiError.notFound()
  const r = await load(scope, line.requisition_id, true)
  const prev = await scope.trx.rawQuery(
    `select line_id, quantity::text as quantity, source_type, source_id from purchase_requisition_allocations
      where tenant_id = ? and idempotency_key = ?`,
    [t, input.idempotencyKey]
  )
  const p = prev.rows[0] as any
  if (p) {
    if (p.line_id !== input.lineId || big(p.quantity) !== q || p.source_id !== input.sourceId)
      throw ApiError.conflict('IDEMPOTENCY_MISMATCH', 'Esta chave já foi usada noutro pedido.')
    return { replayed: true, requisitionStatus: statusOf(r) }
  }
  stateCheck(r, 'allocate')
  const fresh = await scope.trx.rawQuery(
    `select id, quantity, ordered_quantity, closed_quantity from purchase_requisition_lines
      where tenant_id = ? and requisition_id = ? for update`,
    [t, r.id]
  )
  const l = (fresh.rows as any[]).find((x) => x.id === input.lineId)
  const qty = big(l.quantity)
  const ordered = big(l.ordered_quantity)
  let closed = big(l.closed_quantity)
  if (q > 0n && q > qty - ordered - closed)
    throw ApiError.conflict(
      'OVER_ALLOCATED',
      `Só há ${scaledText(qty - ordered - closed, 6)} em aberto nesta linha.`
    )
  if (q < 0n && -q > ordered)
    throw ApiError.conflict(
      'OVER_RELEASED',
      `Só há ${scaledText(ordered, 6)} encomendado nesta linha.`
    )
  // Numa requisição fechada, o que volta não reabre: passa a fechado.
  if (q < 0n && r.status === 'CLOSED') closed += -q
  await scope.trx.rawQuery(
    `insert into purchase_requisition_allocations (tenant_id, line_id, source_type, source_id, source_line_id, quantity,
        idempotency_key, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t,
      input.lineId,
      input.sourceType,
      input.sourceId,
      input.sourceLineId ?? null,
      scaledText(q, 6),
      input.idempotencyKey,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  await scope.trx.rawQuery(
    `update purchase_requisition_lines set ordered_quantity = ?, closed_quantity = ?, updated_by = ?,
        updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
    [
      scaledText(ordered + q, 6),
      scaledText(closed, 6),
      scope.context.userId,
      t,
      input.lineId,
    ] as never[]
  )
  const all = (fresh.rows as any[]).map((x) =>
    x.id === input.lineId
      ? { quantity: qty, ordered: ordered + q, closed }
      : {
          quantity: big(x.quantity),
          ordered: big(x.ordered_quantity),
          closed: big(x.closed_quantity),
        }
  )
  const next = fulfilmentStatus(statusOf(r), all)
  if (next !== r.status) {
    await setStatus(scope, r.id, { status: next })
    await event(scope, r.id, 'STATUS', { from: r.status, to: next })
  }
  await event(scope, r.id, q > 0n ? 'ALLOCATED' : 'RELEASED', {
    details: {
      lineId: input.lineId,
      quantity: scaledText(q, 6),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
  })
  // O que a ordem encomenda deixa de estar comprometido na requisição (passa a estar na ordem).
  await syncCommitments(scope, { requisitionIds: [r.id] })
  return { replayed: false, requisitionStatus: next }
}

export class RequisitionService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      priority?: string
      departmentId?: string
      mine?: boolean
      awaitingMe?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const parts: string[] = []
      const params: unknown[] = []
      if (s.request.tenant || s.approve.tenant || s.process.tenant) parts.push('true')
      else {
        for (const [k, col] of [
          ['legalEntityIds', 'r.legal_entity_id'],
          ['branchIds', 'r.branch_id'],
        ] as const) {
          const v = [...new Set([...s.request[k], ...s.approve[k], ...s.process[k]])]
          if (v.length) {
            parts.push(`${col} = any(?::uuid[])`)
            params.push(v)
          }
        }
        const deps = [...new Set([...s.request.departmentIds, ...s.approve.departmentIds])]
        if (deps.length) {
          parts.push('r.department_id = any(?::uuid[])')
          params.push(deps)
        }
        if (anyScope(s.request)) {
          parts.push('r.requested_by_membership_id = ?')
          params.push(context.membershipId)
        }
      }
      if (!parts.length) return { items: [], total: 0 }
      const where = ['r.tenant_id = ?', `(${parts.join(' or ')})`]
      const all: unknown[] = [context.tenantId, ...params]
      if (f.status && (REQUISITION_STATUSES as readonly string[]).includes(f.status)) {
        where.push('r.status = ?')
        all.push(f.status)
      }
      if (f.priority && (PRIORITIES as readonly string[]).includes(f.priority)) {
        where.push('r.priority = ?')
        all.push(f.priority)
      }
      if (f.departmentId && isUuid(f.departmentId)) {
        where.push('r.department_id = ?')
        all.push(f.departmentId)
      }
      if (f.mine) {
        where.push('r.requested_by_membership_id = ?')
        all.push(context.membershipId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(`(lower(coalesce(r.number, '')) like ? or lower(r.purpose) like ?)`)
        all.push(like, like)
      }
      if (f.awaitingMe) where.push(`r.status = 'PENDING_APPROVAL'`)
      const from = `from purchase_requisitions r
        join departments d on d.tenant_id = r.tenant_id and d.id = r.department_id
        join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
        left join users u on u.id = r.requested_by_user_id
        where ${where.join(' and ')}`
      const rows = await scope.trx.rawQuery(
        `select r.*, d.code as dept_code, d.name as dept_name, le.code as le_code, u.full_name as requester_name
         ${from} order by r.created_at desc, r.id limit ? offset ?`,
        [...all, f.awaitingMe ? 1000 : f.limit, f.awaitingMe ? 0 : f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(`select count(*)::int as n ${from}`, all as never[])
      let items = (rows.rows as any[]).map((r) => ({
        id: r.id as string,
        version: Number(r.version),
        number: (r.number as string) ?? null,
        status: r.status as RequisitionStatus,
        priority: r.priority as string,
        neededBy: isoDate(r.needed_by),
        purpose: r.purpose as string,
        legalEntity: { id: r.legal_entity_id as string, code: r.le_code as string },
        department: {
          id: r.department_id as string,
          code: r.dept_code as string,
          name: r.dept_name as string,
        },
        requestedBy: (r.requester_name as string) ?? null,
        currency: r.currency as string,
        totalAmount: money(cents(r.total_amount)),
        createdAt: new Date(r.created_at).toISOString(),
        _raw: r,
      }))
      let total = Number((count.rows[0] as { n: number }).n)
      if (f.awaitingMe) {
        // Só as que esperam pela minha decisão (a etapa actual é minha).
        const roles = await myRoleIds(scope)
        const keep: typeof items = []
        for (const it of items) {
          const g = rights(s, it._raw, context.membershipId)
          if (!g.approve) continue
          const ap = await scope.trx.rawQuery(
            `select sequence, decided_by_membership_id from purchase_requisition_approvals
              where tenant_id = ? and requisition_id = ?`,
            [context.tenantId, it.id]
          )
          const n = nextStep(
            (it._raw.required_levels as Level[]) ?? [],
            (ap.rows as any[]).map((a) => ({
              sequence: Number(a.sequence),
              membershipId: a.decided_by_membership_id,
            })),
            { membershipId: context.membershipId, isRequester: g.mine, roleIds: roles }
          )
          if (n.allowed) keep.push(it)
        }
        total = keep.length
        items = keep.slice(f.offset, f.offset + f.limit)
      }
      return { items: items.map(({ _raw, ...x }) => x), total }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  /** Departamentos onde posso requisitar, centros de custo, unidades e produtos do catálogo para as linhas. */
  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!anyScope(s.request)) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode requisitar.')
      const t = context.tenantId
      const deps = await scope.trx.rawQuery(
        `select d.id, d.code, d.name, d.legal_entity_id, d.branch_id, d.cost_center_id, le.code as le_code,
            le.functional_currency from departments d
           join legal_entities le on le.tenant_id = d.tenant_id and le.id = d.legal_entity_id
          where d.tenant_id = ? and d.status = 'ACTIVE' order by d.code`,
        [t]
      )
      const departments = (deps.rows as any[])
        .filter(
          (d) =>
            covers(s.request, {
              departmentId: d.id,
              legalEntityId: d.legal_entity_id,
              branchId: d.branch_id,
            }) || s.request.own
        )
        .map((d) => ({
          id: d.id as string,
          code: d.code as string,
          name: d.name as string,
          legalEntityId: d.legal_entity_id as string,
          legalEntityCode: d.le_code as string,
          currency: d.functional_currency as string,
          costCenterId: (d.cost_center_id as string) ?? null,
        }))
      const les = [...new Set(departments.map((d) => d.legalEntityId))]
      const [cc, uoms, products, suppliers] = await Promise.all([
        scope.trx.rawQuery(
          `select id, code, name, legal_entity_id from cost_centers where tenant_id = ? and status = 'ACTIVE'
             and legal_entity_id = any(?::uuid[]) order by code`,
          [t, les] as never[]
        ),
        scope.trx.rawQuery(
          `select id, code, name from uoms where tenant_id = ? and status = 'ACTIVE' order by code`,
          [t]
        ),
        scope.trx.rawQuery(
          `select p.id, p.sku, p.name, p.product_type, coalesce(p.purchase_uom_id, p.base_uom_id) as uom_id
             from products p where p.tenant_id = ? and p.status = 'ACTIVE' and p.product_type <> 'KIT'
            order by p.sku limit 1000`,
          [t]
        ),
        scope.trx.rawQuery(
          `select s.id, p.code, p.name, s.status from suppliers s join business_partners p on p.tenant_id = s.tenant_id
             and p.id = s.partner_id where s.tenant_id = ? and s.status <> 'REJECTED' order by p.code`,
          [t]
        ),
      ])
      return {
        departments,
        costCenters: (cc.rows as any[]).map((c) => ({
          id: c.id as string,
          code: c.code as string,
          name: c.name as string,
          legalEntityId: c.legal_entity_id as string,
        })),
        uoms: uoms.rows as { id: string; code: string; name: string }[],
        products: (products.rows as any[]).map((p) => ({
          id: p.id as string,
          sku: p.sku as string,
          name: p.name as string,
          productType: p.product_type as string,
          uomId: p.uom_id as string,
        })),
        suppliers: (suppliers.rows as any[]).map((x) => ({
          id: x.id as string,
          code: x.code as string,
          name: x.name as string,
          status: x.status as string,
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!anyScope(s.request)) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode requisitar.')
      const h = await header(scope, s, input)
      fail(h.issues)
      const lines = await linesOf(scope, input.lines)
      const r = await scope.trx.rawQuery(
        `insert into purchase_requisitions (tenant_id, legal_entity_id, branch_id, department_id, cost_center_id,
            requested_by_membership_id, requested_by_user_id, priority, needed_by, purpose, budget_reference, currency,
            created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          h.values.legal_entity_id,
          h.values.branch_id,
          h.values.department_id,
          h.values.cost_center_id,
          context.membershipId,
          context.userId,
          h.values.priority,
          h.values.needed_by,
          h.values.purpose,
          h.values.budget_reference,
          h.values.currency,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      const totals = await writeLines(scope, id, lines)
      await scope.trx.rawQuery(
        `update purchase_requisitions set total_net = ?, total_tax = ?, total_amount = ? where tenant_id = ? and id = ?`,
        [totals.net, totals.tax, totals.total, context.tenantId, id]
      )
      await event(scope, id, 'CREATED', { to: 'DRAFT' })
      await audit(scope, {
        action: 'purchase_requisition.created',
        entityType: 'purchase_requisition',
        entityId: id,
        changes: {
          purpose: { from: null, to: h.values.purpose },
          totalAmount: { from: null, to: totals.total },
          lines: { from: null, to: lines.length },
        },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r, s } = await authorized(scope, id, 'request', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'edit')
      const h = await header(scope, s, { ...input, currency: input.currency ?? r.currency })
      fail(h.issues)
      const lines = await linesOf(scope, input.lines)
      const totals = await writeLines(scope, id, lines)
      await setStatus(scope, id, {
        ...h.values,
        total_net: totals.net,
        total_tax: totals.tax,
        total_amount: totals.total,
      })
      await event(scope, id, 'UPDATED')
      await audit(scope, {
        action: 'purchase_requisition.updated',
        entityType: 'purchase_requisition',
        entityId: id,
        changes: { totalAmount: { from: money(cents(r.total_amount)), to: totals.total } },
      })
      return detail(scope, id)
    })
  }

  /** Pedir aprovação: número da série, total em moeda funcional e as etapas que esse total exige (fixas daí em diante). */
  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'request', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'submit')
      const t = context.tenantId
      const le = (await legalEntityFacts(scope, r.legal_entity_id))!
      let rate = 10n ** 10n
      if (r.currency !== le.functionalCurrency) {
        const fx = await rateOn(scope, r.currency, le.functionalCurrency, today())
        if (!fx)
          throw ApiError.conflict(
            'NO_RATE',
            `Sem câmbio ${r.currency}→${le.functionalCurrency} até hoje: registe-o em Câmbios.`
          )
        rate = parseScaled(fx.rate, 10) ?? 0n
      }
      const functional = toFunctional(cents(r.total_amount), rate)
      const lv = await scope.trx.rawQuery(
        `select id, code, name, sequence, min_amount::text as min_amount, approver_role_id from purchase_approval_levels
          where tenant_id = ? and status = 'ACTIVE' and (legal_entity_id is null or legal_entity_id = ?)`,
        [t, r.legal_entity_id]
      )
      const required = requiredLevels(
        (lv.rows as any[]).map((x) => ({
          id: x.id,
          code: x.code,
          name: x.name,
          sequence: Number(x.sequence),
          approverRoleId: x.approver_role_id ?? null,
          minCents: cents(x.min_amount),
        })),
        functional
      )
      const ser = await scope.trx.rawQuery(
        `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
            and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
            and (branch_id is null or branch_id is not distinct from ?)
          order by (branch_id is not null) desc, code limit 1`,
        [t, r.legal_entity_id, SERIES_TYPE, today(), today(), r.branch_id] as never[]
      )
      const series = ser.rows[0] as { id: string } | undefined
      if (!series)
        throw ApiError.conflict(
          'NO_SERIES',
          `Sem série documental ${SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
        )
      const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      await setStatus(scope, id, {
        status: 'PENDING_APPROVAL',
        series_id: series.id,
        number,
        total_functional: money(functional),
        exchange_rate: scaledText(rate, 10),
        required_levels: JSON.stringify(required),
        submitted_at: new Date(),
      })
      await event(scope, id, 'SUBMITTED', {
        from: 'DRAFT',
        to: 'PENDING_APPROVAL',
        details: {
          number,
          levels: required.map((x) => x.code),
          totalFunctional: money(functional),
        },
      })
      await audit(scope, {
        action: 'purchase_requisition.submitted',
        entityType: 'purchase_requisition',
        entityId: id,
        changes: {
          status: { from: 'DRAFT', to: 'PENDING_APPROVAL' },
          number: { from: null, to: number },
        },
      })
      return detail(scope, id)
    })
  }

  /** Decidir a etapa actual (aprovar, ou recusar com motivo — recusar termina a requisição). */
  decide(
    context: TenantContext,
    id: string,
    decision: 'approve' | 'reject',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const { r, g } = await authorized(scope, id, 'approve', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'decide')
      const reason = decision === 'reject' ? reasonOf(input.reason) : text(input.reason) || null
      const ap = await scope.trx.rawQuery(
        `select sequence, decided_by_membership_id from purchase_requisition_approvals
          where tenant_id = ? and requisition_id = ?`,
        [context.tenantId, id]
      )
      const n = nextStep(
        (r.required_levels as Level[]) ?? [],
        (ap.rows as any[]).map((a) => ({
          sequence: Number(a.sequence),
          membershipId: a.decided_by_membership_id,
        })),
        { membershipId: context.membershipId, isRequester: g.mine, roleIds: await myRoleIds(scope) }
      )
      if (!n.step) throw ApiError.conflict('INVALID_STATE', 'Não há etapa por decidir.')
      if (!n.allowed)
        throw ApiError.forbidden(
          n.reason!,
          {
            SELF_APPROVAL: 'Quem pede a requisição não a pode aprovar.',
            SAME_APPROVER: 'Já decidiu uma etapa anterior desta requisição.',
            ROLE_REQUIRED: `A etapa ${n.step.name} exige outro perfil.`,
            DONE: '',
          }[n.reason!]
        )
      await scope.trx.rawQuery(
        `insert into purchase_requisition_approvals (tenant_id, requisition_id, level_id, level_code, sequence, decision,
            decided_by_membership_id, decided_by_user_id, reason, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          id,
          n.step.id,
          n.step.code,
          n.step.sequence,
          decision === 'approve' ? 'APPROVE' : 'REJECT',
          context.membershipId,
          context.userId,
          reason,
          context.userId,
          context.userId,
        ] as never[]
      )
      const required = (r.required_levels as Level[]) ?? []
      const last = required[required.length - 1]?.sequence === n.step.sequence
      const to: RequisitionStatus =
        decision === 'reject' ? 'REJECTED' : last ? 'APPROVED' : 'PENDING_APPROVAL'
      if (to !== 'PENDING_APPROVAL')
        await setStatus(scope, id, {
          status: to,
          ...(to === 'APPROVED' ? { approved_at: new Date() } : { reject_reason: reason }),
        })
      else await setStatus(scope, id, {})
      // Aprovada: compromete a verba do centro de custo (recusado se passar uma verba com bloqueio).
      if (to === 'APPROVED') await syncCommitments(scope, { requisitionIds: [id] }, { check: true })
      await event(scope, id, decision === 'approve' ? 'STEP_APPROVED' : 'REJECTED', {
        from: 'PENDING_APPROVAL',
        to,
        reason,
        details: { step: n.step.code },
      })
      await audit(scope, {
        action: `purchase_requisition.${decision === 'approve' ? (last ? 'approved' : 'step_approved') : 'rejected'}`,
        entityType: 'purchase_requisition',
        entityId: id,
        changes: {
          step: { from: null, to: n.step.code },
          status: { from: 'PENDING_APPROVAL', to },
        },
      })
      return detail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r, g } = await authorized(scope, id, 'read', true)
      if (!g.request && !g.process)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode anular requisições deste departamento.')
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'cancel')
      const reason = reasonOf(input.reason)
      await setStatus(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await event(scope, id, 'CANCELLED', { from: r.status, to: 'CANCELLED', reason })
      await syncCommitments(scope, { requisitionIds: [id] })
      await audit(scope, {
        action: 'purchase_requisition.cancelled',
        entityType: 'purchase_requisition',
        entityId: id,
        changes: { status: { from: r.status, to: 'CANCELLED' } },
      })
      return detail(scope, id)
    })
  }

  /** Fechar o resto em aberto (comprador): o que ainda não foi encomendado deixa de estar em aberto. */
  close(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'process', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'close')
      const reason = reasonOf(input.reason)
      await scope.trx.rawQuery(
        `update purchase_requisition_lines set closed_quantity = quantity - ordered_quantity, updated_by = ?,
            updated_at = now(), version = version + 1 where tenant_id = ? and requisition_id = ?`,
        [context.userId, context.tenantId, id]
      )
      await setStatus(scope, id, { status: 'CLOSED', close_reason: reason })
      await event(scope, id, 'CLOSED', { from: r.status, to: 'CLOSED', reason })
      await syncCommitments(scope, { requisitionIds: [id] })
      await audit(scope, {
        action: 'purchase_requisition.closed',
        entityType: 'purchase_requisition',
        entityId: id,
        changes: { status: { from: r.status, to: 'CLOSED' } },
      })
      return detail(scope, id)
    })
  }

  /** Nova requisição em rascunho com o mesmo cabeçalho e linhas (ex.: depois de uma recusa). */
  copy(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const { r, g } = await authorized(scope, id, 'read')
      if (!g.request)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode requisitar para este departamento.')
      const lines = await scope.trx.rawQuery(
        `select * from purchase_requisition_lines where tenant_id = ? and requisition_id = ? order by line_no`,
        [context.tenantId, id]
      )
      const n = await scope.trx.rawQuery(
        `insert into purchase_requisitions (tenant_id, legal_entity_id, branch_id, department_id, cost_center_id,
            requested_by_membership_id, requested_by_user_id, priority, needed_by, purpose, budget_reference, currency,
            total_net, total_tax, total_amount, copied_from_id, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, greatest(?::date, current_date), ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          r.legal_entity_id,
          r.branch_id,
          r.department_id,
          r.cost_center_id,
          context.membershipId,
          context.userId,
          r.priority,
          isoDate(r.needed_by),
          r.purpose,
          r.budget_reference,
          r.currency,
          r.total_net,
          r.total_tax,
          r.total_amount,
          id,
          context.userId,
          context.userId,
        ] as never[]
      )
      const newId = (n.rows[0] as { id: string }).id
      for (const l of lines.rows as any[])
        await scope.trx.rawQuery(
          `insert into purchase_requisition_lines (tenant_id, requisition_id, line_no, product_id, variant_id, description,
              uom_id, uom_code, quantity, estimated_unit_price, tax_rate, net_amount, tax_amount, total_amount, needed_by,
              suggested_supplier_id, notes, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            newId,
            l.line_no,
            l.product_id,
            l.variant_id,
            l.description,
            l.uom_id,
            l.uom_code,
            l.quantity,
            l.estimated_unit_price,
            l.tax_rate,
            l.net_amount,
            l.tax_amount,
            l.total_amount,
            l.needed_by ? isoDate(l.needed_by) : null,
            l.suggested_supplier_id,
            l.notes,
            context.userId,
            context.userId,
          ] as never[]
        )
      await event(scope, newId, 'CREATED', { to: 'DRAFT', details: { copiedFrom: r.number ?? id } })
      await audit(scope, {
        action: 'purchase_requisition.copied',
        entityType: 'purchase_requisition',
        entityId: newId,
        changes: { copiedFrom: { from: null, to: id } },
      })
      return detail(scope, newId)
    })
  }

  /**
   * Necessidades consolidadas (compradores): linhas em aberto das requisições aprovadas, agrupadas por entidade, produto
   * (ou descrição livre) e unidade, com a quantidade e o valor estimado em aberto, a necessidade mais cedo e as origens.
   */
  demand(context: TenantContext, f: { legalEntityId?: string; q?: string }) {
    return runInTenant(context, async (scope) => {
      const s = (await scopesOf(scope)).process
      if (!s.tenant && !s.legalEntityIds.size && !s.branchIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não trata requisições.')
      const where = [
        'r.tenant_id = ?',
        `r.status = any(?::text[])`,
        'l.quantity - l.ordered_quantity - l.closed_quantity > 0',
      ]
      const params: unknown[] = [context.tenantId, OPEN]
      if (!s.tenant) {
        where.push('(r.legal_entity_id = any(?::uuid[]) or r.branch_id = any(?::uuid[]))')
        params.push([...s.legalEntityIds], [...s.branchIds])
      }
      if (f.legalEntityId && isUuid(f.legalEntityId)) {
        where.push('r.legal_entity_id = ?')
        params.push(f.legalEntityId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(`(lower(l.description) like ? or lower(coalesce(p.sku, '')) like ?)`)
        params.push(like, like)
      }
      const rows = await scope.trx.rawQuery(
        `select l.id, l.product_id, l.variant_id, l.description, l.uom_id, l.uom_code, l.quantity, l.ordered_quantity,
            l.closed_quantity, l.estimated_unit_price, l.needed_by as line_needed, r.needed_by, r.priority, r.id as req_id,
            r.number, r.legal_entity_id, r.currency, le.code as le_code, p.sku
           from purchase_requisition_lines l
           join purchase_requisitions r on r.tenant_id = l.tenant_id and r.id = l.requisition_id
           join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
           left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
          where ${where.join(' and ')} order by r.needed_by, r.number, l.line_no`,
        params as never[]
      )
      const RANK: Record<string, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 }
      const groups = new Map<string, any>()
      for (const x of rows.rows as any[]) {
        const key = x.product_id
          ? `${x.legal_entity_id}|${x.product_id}|${x.variant_id ?? ''}|${x.uom_id ?? ''}|${x.currency}`
          : `${x.legal_entity_id}|line:${x.id}`
        const open = big(x.quantity) - big(x.ordered_quantity) - big(x.closed_quantity)
        const value = (open * big(x.estimated_unit_price) * 100n + 10n ** 12n / 2n) / 10n ** 12n
        const need = isoDate(x.line_needed ?? x.needed_by)!
        const g = groups.get(key) ?? {
          key,
          legalEntity: { id: x.legal_entity_id, code: x.le_code },
          product: x.product_id ? { id: x.product_id, sku: x.sku } : null,
          variantId: x.variant_id ?? null,
          description: x.description,
          uom: x.uom_code ?? null,
          currency: x.currency,
          open: 0n,
          value: 0n,
          neededBy: need,
          priority: x.priority,
          lines: [] as { lineId: string; requisitionId: string; number: string; open: string }[],
        }
        g.open += open
        g.value += value
        if (need < g.neededBy) g.neededBy = need
        if (RANK[x.priority] > RANK[g.priority]) g.priority = x.priority
        g.lines.push({
          lineId: x.id,
          requisitionId: x.req_id,
          number: x.number,
          open: scaledText(open, 6),
        })
        groups.set(key, g)
      }
      return [...groups.values()]
        .sort(
          (a, b) =>
            a.neededBy.localeCompare(b.neededBy) || a.description.localeCompare(b.description)
        )
        .map((g) => ({ ...g, open: scaledText(g.open, 6), estimatedValue: money(g.value) }))
    })
  }
}

/** Existe nesta empresa (para os anexos da requisição). */
export async function requisitionExists(scope: TenantScope, id: string) {
  if (!isUuid(id)) return false
  const r = await scope.trx.rawQuery(
    `select 1 from purchase_requisitions where tenant_id = ? and id = ?`,
    [scope.context.tenantId, id]
  )
  return r.rows.length > 0
}
