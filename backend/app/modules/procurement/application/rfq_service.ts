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
  canOpen,
  pricesHidden,
  quoteLines,
  RFQ_CAN,
  RFQ_SERIES_TYPE,
  RFQ_STATUSES,
  type RfqStatus,
} from '#modules/procurement/domain/rfqs'

/*
 * Pedidos de cotação (9.3). Permissões no âmbito da entidade legal: `procurement.rfqs.read` (consultar) e
 * `procurement.rfqs.manage` (criar, convidar, emitir, rever, registar propostas, abrir, anular). As propostas são
 * registadas pelo comprador (o portal do fornecedor é do Prompt 25). Envelope fechado: valores ocultos para todos
 * enquanto o pedido está aberto, também na auditoria e no histórico.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const big = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const cents = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n
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
}
/** Ler: `.read` ou quem aprova adjudicações (`.approve`) na entidade; gerir: `.manage`. */
export async function rfqScopes(
  scope: TenantScope
): Promise<Scopes & { approve: PermissionScope }> {
  const read = await permissionScope(scope, 'procurement.rfqs.read')
  const approve = await permissionScope(scope, 'procurement.rfqs.approve')
  return {
    read: {
      ...read,
      tenant: read.tenant || approve.tenant,
      legalEntityIds: new Set([...read.legalEntityIds, ...approve.legalEntityIds]),
    },
    manage: await permissionScope(scope, 'procurement.rfqs.manage'),
    approve,
  }
}
const scopesOf = rfqScopes
export const coversLe = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
const entitiesOf = (s: Scopes) =>
  s.read.tenant || s.manage.tenant
    ? 'ALL'
    : [...new Set([...s.read.legalEntityIds, ...s.manage.legalEntityIds])]

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select * from rfqs where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  const x = r.rows[0] as any
  if (!x) throw ApiError.notFound()
  return x
}

async function authorized(scope: TenantScope, id: string, need: 'read' | 'manage', lock = false) {
  const r = await load(scope, id, lock)
  const s = await scopesOf(scope)
  const manage = coversLe(s.manage, r.legal_entity_id)
  const read = manage || coversLe(s.read, r.legal_entity_id)
  if (!read) throw ApiError.notFound()
  if (need === 'manage' && !manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação desta entidade.')
  return { r, manage }
}

const stateCheck = (r: any, action: keyof typeof RFQ_CAN) => {
  if (!RFQ_CAN[action].includes(r.status))
    throw ApiError.conflict('INVALID_STATE', `Não é possível nesta fase (${r.status}).`)
}
const versionCheck = (r: any, expected: unknown) => {
  if (Number(r.version) !== Number(expected)) throw ApiError.versionConflict(Number(r.version))
}
const reasonOf = (v: unknown) => {
  const r = text(v)
  if (!r) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}

export async function rfqEvent(
  scope: TenantScope,
  id: string,
  kind: string,
  e: { revision?: number; reason?: string | null; details?: Record<string, unknown> } = {}
) {
  await scope.trx.rawQuery(
    `insert into rfq_events (tenant_id, rfq_id, kind, revision, reason, details, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      id,
      kind,
      e.revision ?? null,
      e.reason ?? null,
      e.details ? JSON.stringify(e.details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function touch(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update rfqs set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(), version = version + 1
      where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** Cabeçalho: entidade no âmbito de gestão, prazo futuro, moeda, condições. */
async function header(
  scope: TenantScope,
  s: Scopes,
  input: Record<string, unknown>,
  creating: boolean
) {
  const issues: ErrorDetail[] = []
  let le: Awaited<ReturnType<typeof legalEntityFacts>> = null
  if (creating) {
    if (!isUuid(input.legalEntityId))
      issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade legal.' })
    else {
      le = await legalEntityFacts(scope, input.legalEntityId)
      if (!le)
        issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' })
      else if (!coversLe(s.manage, le.id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação desta entidade.')
    }
  }
  const title = text(input.title)
  if (title.length < 3 || title.length > 200)
    issues.push({ path: 'title', code: 'LENGTH', message: 'Título: 3 a 200 caracteres.' })
  const specifications = text(input.specifications) || null
  if (specifications && specifications.length > 10000)
    issues.push({ path: 'specifications', code: 'LENGTH', message: 'Até 10 000 caracteres.' })
  const closesAt = typeof input.closesAt === 'string' ? new Date(input.closesAt) : null
  if (!closesAt || Number.isNaN(closesAt.getTime()))
    issues.push({ path: 'closesAt', code: 'INVALID', message: 'Prazo de resposta (data e hora).' })
  else if (closesAt.getTime() <= Date.now())
    issues.push({
      path: 'closesAt',
      code: 'PAST',
      message: 'O prazo de resposta tem de ser futuro.',
    })
  const terms: Record<string, string | null> = {}
  for (const k of ['deliveryTerms', 'paymentTerms']) {
    const v = text(input[k]) || null
    if (v && v.length > 500)
      issues.push({ path: k, code: 'LENGTH', message: 'Até 500 caracteres.' })
    terms[k] = v
  }
  const currency = text(input.currency).toUpperCase() || le?.functionalCurrency || ''
  if (creating && !/^[A-Z]{3}$/.test(currency))
    issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: código ISO de 3 letras.' })
  return {
    issues,
    le,
    values: {
      title,
      specifications,
      closes_at: closesAt,
      delivery_terms: terms.deliveryTerms,
      payment_terms: terms.paymentTerms,
      currency,
      sealed: input.sealed === undefined ? true : input.sealed === true,
    },
  }
}

/** Linhas do pedido: de uma linha de requisição aprovada da mesma entidade (com o aberto), ou de raiz. */
async function linesOf(scope: TenantScope, legalEntityId: string, raw: unknown) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  if (list.length > 200)
    issues.push({ path: 'lines', code: 'TOO_MANY', message: 'Até 200 linhas.' })
  const out: any[] = []
  for (const [i, l] of list.entries()) {
    const at = (field: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${field}`, code, message })
    let productId = isUuid(l?.productId) ? l.productId : null
    let variantId = isUuid(l?.variantId) ? l.variantId : null
    let description = text(l?.description)
    let uomId = isUuid(l?.uomId) ? l.uomId : null
    let qty = l?.quantity === undefined ? null : parseScaled(l.quantity, 6)
    let neededBy = l?.neededBy ? l.neededBy : null
    let requisitionLineId: string | null = null
    if (l?.requisitionLineId) {
      const rl = isUuid(l.requisitionLineId)
        ? (
            await scope.trx.rawQuery(
              `select l.*, r.legal_entity_id, r.status as req_status, r.needed_by as req_needed
                 from purchase_requisition_lines l join purchase_requisitions r on r.tenant_id = l.tenant_id
                  and r.id = l.requisition_id where l.tenant_id = ? and l.id = ?`,
              [t, l.requisitionLineId]
            )
          ).rows[0]
        : null
      const x = rl as any
      if (!x || !['APPROVED', 'PARTIALLY_ORDERED'].includes(x.req_status))
        at('requisitionLineId', 'NOT_FOUND', 'Linha de requisição inexistente ou não aprovada.')
      else if (x.legal_entity_id !== legalEntityId)
        at('requisitionLineId', 'OTHER_LEGAL_ENTITY', 'A requisição é de outra entidade.')
      else {
        const open = big(x.quantity) - big(x.ordered_quantity) - big(x.closed_quantity)
        if (open <= 0n)
          at('requisitionLineId', 'NOTHING_OPEN', 'A linha já não tem quantidade em aberto.')
        requisitionLineId = x.id
        productId = x.product_id
        variantId = x.variant_id
        description ||= x.description
        uomId ||= x.uom_id
        qty ??= open
        neededBy ||= isoDate(x.needed_by ?? x.req_needed)
      }
    }
    if (qty === null || qty <= 0n)
      at('quantity', 'INVALID', 'Quantidade maior que zero, até 6 casas, em texto.')
    if (productId) {
      const p = (
        await scope.trx.rawQuery(
          `select name, status, base_uom_id, purchase_uom_id from products where tenant_id = ? and id = ?`,
          [t, productId]
        )
      ).rows[0] as any
      if (!p || p.status !== 'ACTIVE')
        at('productId', 'NOT_FOUND', 'Produto inexistente ou inactivo.')
      else {
        description ||= p.name
        uomId ||= p.purchase_uom_id ?? p.base_uom_id
      }
    }
    if (description.length < 3 || description.length > 300)
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
    if (neededBy !== null && !isDate(neededBy)) at('neededBy', 'INVALID', 'Data AAAA-MM-DD.')
    const specifications = text(l?.specifications) || null
    if (specifications && specifications.length > 1000)
      at('specifications', 'LENGTH', 'Até 1000 caracteres.')
    out.push({
      requisitionLineId,
      productId,
      variantId,
      description,
      uomId,
      uomCode,
      quantity: qty ?? 0n,
      specifications,
      neededBy,
    })
  }
  fail(issues)
  return out
}

async function writeLines(scope: TenantScope, id: string, lines: any[]) {
  const t = scope.context.tenantId
  await scope.trx.rawQuery(`delete from rfq_lines where tenant_id = ? and rfq_id = ?`, [t, id])
  for (const [i, l] of lines.entries())
    await scope.trx.rawQuery(
      `insert into rfq_lines (tenant_id, rfq_id, line_no, requisition_line_id, product_id, variant_id, description, uom_id,
          uom_code, quantity, specifications, needed_by, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        id,
        i + 1,
        l.requisitionLineId,
        l.productId,
        l.variantId,
        l.description,
        l.uomId,
        l.uomCode,
        scaledText(l.quantity, 6),
        l.specifications,
        l.neededBy,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
}

/** Convida fornecedores: só homologados e com os documentos obrigatórios em dia. */
async function inviteSuppliers(scope: TenantScope, id: string, raw: unknown) {
  const ids = [...new Set(Array.isArray(raw) ? raw : [])]
  const issues: ErrorDetail[] = []
  const ok: string[] = []
  for (const [i, sid] of ids.entries()) {
    const st = isUuid(sid) ? await supplierStanding(scope, sid) : null
    if (!st)
      issues.push({
        path: `supplierIds.${i}`,
        code: 'NOT_FOUND',
        message: 'Fornecedor inexistente.',
      })
    else if (!st.canOrder)
      issues.push({
        path: `supplierIds.${i}`,
        code: 'NOT_QUALIFIED',
        message: 'Fornecedor não homologado ou com documentos obrigatórios fora de validade.',
      })
    else ok.push(sid as string)
  }
  fail(issues)
  const added: string[] = []
  for (const sid of ok) {
    const r = await scope.trx.rawQuery(
      `insert into rfq_invitations (tenant_id, rfq_id, supplier_id, created_by, updated_by) values (?, ?, ?, ?, ?)
       on conflict (tenant_id, rfq_id, supplier_id) do nothing returning id`,
      [scope.context.tenantId, id, sid, scope.context.userId, scope.context.userId]
    )
    if (r.rows.length) added.push(sid)
  }
  return added
}

async function detail(scope: TenantScope, id: string) {
  const { r, manage } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const hidden = pricesHidden(r)
  const [lines, invitations, quotes, qlines, events, le] = await Promise.all([
    scope.trx.rawQuery(
      `select l.*, p.sku, rq.number as req_number, rq.id as req_id from rfq_lines l
         left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join purchase_requisition_lines rl on rl.tenant_id = l.tenant_id and rl.id = l.requisition_line_id
         left join purchase_requisitions rq on rq.tenant_id = rl.tenant_id and rq.id = rl.requisition_id
        where l.tenant_id = ? and l.rfq_id = ? order by l.line_no`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select i.*, bp.code, bp.name from rfq_invitations i join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where i.tenant_id = ? and i.rfq_id = ? order by bp.code`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select q.*, u.full_name as received_name, a.file_name from rfq_quotes q left join users u on u.id = q.received_by
         left join attachments a on a.tenant_id = q.tenant_id and a.id = q.attachment_id
        where q.tenant_id = ? and q.rfq_id = ? order by q.supplier_id, q.quote_version desc`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select ql.* from rfq_quote_lines ql join rfq_quotes q on q.tenant_id = ql.tenant_id and q.id = ql.quote_id
        where ql.tenant_id = ? and q.rfq_id = ? order by ql.alternative_no`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select e.*, u.full_name from rfq_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.rfq_id = ? order by e.created_at desc, e.id`,
      [t, id]
    ),
    legalEntityFacts(scope, r.legal_entity_id),
  ])
  const status = r.status as RfqStatus
  const invs = invitations.rows as any[]
  const awards = (
    await scope.trx.rawQuery(
      `select a.id, a.status, a.total_base, a.base_currency, a.created_at, u.full_name as submitted_name
         from rfq_awards a left join users u on u.id = a.submitted_by
        where a.tenant_id = ? and a.rfq_id = ? order by a.created_at desc`,
      [t, id]
    )
  ).rows as any[]
  const liveAward = awards.some((a) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(a.status))
  const lineNo = new Map((lines.rows as any[]).map((l) => [l.id as string, Number(l.line_no)]))
  return {
    id: r.id as string,
    version: Number(r.version),
    number: (r.number as string) ?? null,
    status,
    legalEntity: { id: r.legal_entity_id as string, code: le?.code ?? '' },
    title: r.title as string,
    specifications: (r.specifications as string) ?? null,
    closesAt: new Date(r.closes_at).toISOString(),
    deliveryTerms: (r.delivery_terms as string) ?? null,
    paymentTerms: (r.payment_terms as string) ?? null,
    currency: r.currency as string,
    sealed: r.sealed as boolean,
    pricesHidden: hidden,
    revision: Number(r.revision),
    issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null,
    openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
    cancelReason: (r.cancel_reason as string) ?? null,
    lines: (lines.rows as any[]).map((l) => ({
      id: l.id as string,
      version: Number(l.version),
      lineNo: Number(l.line_no),
      product: l.product_id ? { id: l.product_id as string, sku: l.sku as string } : null,
      description: l.description as string,
      uom: l.uom_id ? { id: l.uom_id as string, code: l.uom_code as string } : null,
      quantity: scaledText(big(l.quantity), 6),
      specifications: (l.specifications as string) ?? null,
      neededBy: isoDate(l.needed_by),
      requisition: l.requisition_line_id
        ? {
            id: l.req_id as string,
            number: l.req_number as string,
            lineId: l.requisition_line_id as string,
          }
        : null,
    })),
    invitations: invs.map((i) => ({
      id: i.id as string,
      version: Number(i.version),
      supplier: { id: i.supplier_id as string, code: i.code as string, name: i.name as string },
      status: i.status as string,
      declineReason: (i.decline_reason as string) ?? null,
    })),
    quotes: (quotes.rows as any[]).map((q) => {
      const sup = invs.find((i) => i.supplier_id === q.supplier_id)
      return {
        id: q.id as string,
        version: Number(q.version),
        supplier: { id: q.supplier_id as string, code: sup?.code ?? '', name: sup?.name ?? '' },
        quoteVersion: Number(q.quote_version),
        rfqRevision: Number(q.rfq_revision),
        outdated: Number(q.rfq_revision) < Number(r.revision),
        status: q.status as string,
        withdrawReason: (q.withdraw_reason as string) ?? null,
        receivedAt: new Date(q.created_at).toISOString(),
        receivedBy: (q.received_name as string) ?? null,
        supplierReference: hidden ? null : ((q.supplier_reference as string) ?? null),
        currency: hidden ? null : (q.currency as string),
        validUntil: hidden ? null : isoDate(q.valid_until),
        deliveryDays: hidden ? null : (q.delivery_days ?? null),
        paymentTermsDays: hidden ? null : (q.payment_terms_days ?? null),
        notes: hidden ? null : ((q.notes as string) ?? null),
        totalNet: hidden ? null : money(cents(q.total_net)),
        totalTax: hidden ? null : money(cents(q.total_tax)),
        totalAmount: hidden ? null : money(cents(q.total_amount)),
        attachment:
          hidden || !q.attachment_id
            ? null
            : { id: q.attachment_id as string, fileName: q.file_name },
        lines: hidden
          ? []
          : (qlines.rows as any[])
              .filter((x) => x.quote_id === q.id)
              .sort(
                (a, b) =>
                  (lineNo.get(a.rfq_line_id) ?? 0) - (lineNo.get(b.rfq_line_id) ?? 0) ||
                  a.alternative_no - b.alternative_no
              )
              .map((x) => ({
                id: x.id as string,
                rfqLineId: x.rfq_line_id as string,
                lineNo: lineNo.get(x.rfq_line_id) ?? 0,
                alternativeNo: Number(x.alternative_no),
                description: (x.description as string) ?? null,
                quantity: scaledText(big(x.quantity), 6),
                unitPrice: scaledText(big(x.unit_price), 6),
                taxRate: scaledText(parseScaled(String(x.tax_rate), 3) ?? 0n, 3),
                netAmount: money(cents(x.net_amount)),
                taxAmount: money(cents(x.tax_amount)),
                totalAmount: money(cents(x.total_amount)),
                deliveryDays: x.delivery_days ?? null,
                notes: (x.notes as string) ?? null,
              })),
      }
    }),
    history: (events.rows as any[]).map((e) => ({
      kind: e.kind as string,
      revision: e.revision ?? null,
      reason: (e.reason as string) ?? null,
      details: e.details ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: {
      edit: manage && RFQ_CAN.edit.includes(status),
      invite: manage && RFQ_CAN.invite.includes(status),
      issue: manage && RFQ_CAN.issue.includes(status),
      amend: manage && RFQ_CAN.amend.includes(status),
      quote:
        manage && RFQ_CAN.quote.includes(status) && new Date(r.closes_at).getTime() > Date.now(),
      open: manage && status === 'OPEN' && canOpen(new Date(r.closes_at), new Date(), invs),
      cancel: manage && RFQ_CAN.cancel.includes(status),
      award: manage && status === 'CLOSED' && !liveAward,
    },
    awards: awards.map((a) => ({
      id: a.id as string,
      status: a.status as string,
      totalBase: money(cents(a.total_base)),
      baseCurrency: a.base_currency as string,
      submittedBy: (a.submitted_name as string) ?? null,
      createdAt: new Date(a.created_at).toISOString(),
    })),
  }
}

export type RfqDetail = Awaited<ReturnType<typeof detail>>

export class RfqService {
  list(
    context: TenantContext,
    f: { q?: string; status?: string; pendingAward?: boolean; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const e = entitiesOf(await scopesOf(scope))
      if (e !== 'ALL' && !e.length) return { items: [], total: 0 }
      const where = ['r.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (e !== 'ALL') {
        where.push('r.legal_entity_id = any(?::uuid[])')
        params.push(e)
      }
      if (f.status && (RFQ_STATUSES as readonly string[]).includes(f.status)) {
        where.push('r.status = ?')
        params.push(f.status)
      }
      if (f.pendingAward)
        where.push(`exists (select 1 from rfq_awards a where a.tenant_id = r.tenant_id and a.rfq_id = r.id
          and a.status = 'PENDING_APPROVAL')`)
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(`(lower(coalesce(r.number, '')) like ? or lower(r.title) like ?)`)
        params.push(like, like)
      }
      const from = `from rfqs r join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
        where ${where.join(' and ')}`
      const rows = await scope.trx.rawQuery(
        `select r.*, le.code as le_code,
            (select count(*) from rfq_invitations i where i.tenant_id = r.tenant_id and i.rfq_id = r.id)::int as invited,
            (select count(*) from rfq_quotes q where q.tenant_id = r.tenant_id and q.rfq_id = r.id
               and q.status = 'ACTIVE')::int as quotes
         ${from} order by r.created_at desc, r.id limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[])
      return {
        items: (rows.rows as any[]).map((r) => ({
          id: r.id as string,
          version: Number(r.version),
          number: (r.number as string) ?? null,
          status: r.status as RfqStatus,
          title: r.title as string,
          legalEntity: { id: r.legal_entity_id as string, code: r.le_code as string },
          closesAt: new Date(r.closes_at).toISOString(),
          sealed: r.sealed as boolean,
          revision: Number(r.revision),
          invited: Number(r.invited),
          quotes: Number(r.quotes),
          createdAt: new Date(r.created_at).toISOString(),
        })),
        total: Number((count.rows[0] as { n: number }).n),
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  /** Entidades onde posso gerir, fornecedores que posso convidar, produtos e unidades. */
  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!s.manage.tenant && !s.manage.legalEntityIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação.')
      const t = context.tenantId
      const les = await scope.trx.rawQuery(
        `select id, code, functional_currency from legal_entities where tenant_id = ? order by code`,
        [t]
      )
      const sup = await scope.trx.rawQuery(
        `select s.id, p.code, p.name from suppliers s join business_partners p on p.tenant_id = s.tenant_id
           and p.id = s.partner_id where s.tenant_id = ? and s.status = 'APPROVED' order by p.code`,
        [t]
      )
      const suppliers: { id: string; code: string; name: string }[] = []
      for (const x of sup.rows as any[])
        if ((await supplierStanding(scope, x.id))?.canOrder)
          suppliers.push({ id: x.id, code: x.code, name: x.name })
      const [uoms, products] = await Promise.all([
        scope.trx.rawQuery(
          `select id, code, name from uoms where tenant_id = ? and status = 'ACTIVE' order by code`,
          [t]
        ),
        scope.trx.rawQuery(
          `select id, sku, name, coalesce(purchase_uom_id, base_uom_id) as uom_id from products
            where tenant_id = ? and status = 'ACTIVE' and product_type <> 'KIT' order by sku limit 1000`,
          [t]
        ),
      ])
      return {
        legalEntities: (les.rows as any[])
          .filter((l) => coversLe(s.manage, l.id))
          .map((l) => ({
            id: l.id as string,
            code: l.code as string,
            currency: l.functional_currency as string,
          })),
        suppliers,
        uoms: uoms.rows as { id: string; code: string; name: string }[],
        products: (products.rows as any[]).map((p) => ({
          id: p.id as string,
          sku: p.sku as string,
          name: p.name as string,
          uomId: p.uom_id as string,
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!s.manage.tenant && !s.manage.legalEntityIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação.')
      const h = await header(scope, s, input, true)
      fail(h.issues)
      const lines = await linesOf(scope, h.le!.id, input.lines)
      const r = await scope.trx.rawQuery(
        `insert into rfqs (tenant_id, legal_entity_id, title, specifications, closes_at, delivery_terms, payment_terms,
            currency, sealed, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          h.le!.id,
          h.values.title,
          h.values.specifications,
          h.values.closes_at,
          h.values.delivery_terms,
          h.values.payment_terms,
          h.values.currency,
          h.values.sealed,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      await writeLines(scope, id, lines)
      const invited = input.supplierIds ? await inviteSuppliers(scope, id, input.supplierIds) : []
      await rfqEvent(scope, id, 'CREATED', {
        details: { lines: lines.length, invited: invited.length },
      })
      await audit(scope, {
        action: 'rfq.created',
        entityType: 'rfq',
        entityId: id,
        changes: {
          title: { from: null, to: h.values.title },
          lines: { from: null, to: lines.length },
        },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'edit')
      const s = await scopesOf(scope)
      const h = await header(scope, s, input, false)
      fail(h.issues)
      const lines = await linesOf(scope, r.legal_entity_id, input.lines)
      await writeLines(scope, id, lines)
      const cur = text(input.currency).toUpperCase()
      await touch(scope, id, {
        title: h.values.title,
        specifications: h.values.specifications,
        closes_at: h.values.closes_at,
        delivery_terms: h.values.delivery_terms,
        payment_terms: h.values.payment_terms,
        sealed: h.values.sealed,
        ...(/^[A-Z]{3}$/.test(cur) ? { currency: cur } : {}),
      })
      await rfqEvent(scope, id, 'UPDATED')
      await audit(scope, {
        action: 'rfq.updated',
        entityType: 'rfq',
        entityId: id,
        changes: { title: { from: r.title, to: h.values.title } },
      })
      return detail(scope, id)
    })
  }

  invite(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      stateCheck(r, 'invite')
      const added = await inviteSuppliers(scope, id, input.supplierIds)
      if (added.length) {
        await touch(scope, id, {})
        await rfqEvent(scope, id, 'INVITED', {
          revision: Number(r.revision),
          details: { suppliers: added },
        })
        await audit(scope, {
          action: 'rfq.invited',
          entityType: 'rfq',
          entityId: id,
          changes: { suppliers: { from: null, to: added.length } },
        })
      }
      return detail(scope, id)
    })
  }

  uninvite(context: TenantContext, invitationId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(invitationId)) throw ApiError.notFound()
      const i = (
        await scope.trx.rawQuery(
          `select rfq_id, supplier_id from rfq_invitations where tenant_id = ? and id = ?`,
          [context.tenantId, invitationId]
        )
      ).rows[0] as any
      if (!i) throw ApiError.notFound()
      const { r } = await authorized(scope, i.rfq_id, 'manage', true)
      stateCheck(r, 'uninvite')
      await scope.trx.rawQuery(`delete from rfq_invitations where tenant_id = ? and id = ?`, [
        context.tenantId,
        invitationId,
      ])
      await rfqEvent(scope, r.id, 'UNINVITED', { details: { supplierId: i.supplier_id } })
      return detail(scope, r.id)
    })
  }

  /** Emitir: número da série, prazo ainda futuro, linhas e convidados; a partir daqui as propostas entram em envelope. */
  issue(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'issue')
      const t = context.tenantId
      const issues: ErrorDetail[] = []
      if (new Date(r.closes_at).getTime() <= Date.now())
        issues.push({
          path: 'closesAt',
          code: 'PAST',
          message: 'O prazo de resposta já passou: altere-o.',
        })
      const inv = await scope.trx.rawQuery(
        `select supplier_id from rfq_invitations where tenant_id = ? and rfq_id = ?`,
        [t, id]
      )
      if (!inv.rows.length)
        issues.push({
          path: 'invitations',
          code: 'REQUIRED',
          message: 'Convide pelo menos um fornecedor.',
        })
      for (const x of inv.rows as any[])
        if (!(await supplierStanding(scope, x.supplier_id))?.canOrder)
          issues.push({
            path: 'invitations',
            code: 'NOT_QUALIFIED',
            message: 'Há um convidado que deixou de estar homologado.',
          })
      fail(issues)
      const ser = await scope.trx.rawQuery(
        `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
            and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
            and branch_id is null order by code limit 1`,
        [t, r.legal_entity_id, RFQ_SERIES_TYPE, today(), today()]
      )
      const series = ser.rows[0] as { id: string } | undefined
      if (!series)
        throw ApiError.conflict(
          'NO_SERIES',
          `Sem série documental ${RFQ_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
        )
      const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      await touch(scope, id, {
        status: 'OPEN',
        series_id: series.id,
        number,
        issued_at: new Date(),
        issued_by: context.userId,
      })
      await rfqEvent(scope, id, 'ISSUED', {
        revision: 0,
        details: { number, invited: inv.rows.length },
      })
      await audit(scope, {
        action: 'rfq.issued',
        entityType: 'rfq',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'OPEN' }, number: { from: null, to: number } },
      })
      return detail(scope, id)
    })
  }

  /** Revisão de um pedido emitido (com motivo): prazo, especificações, condições e quantidades/especificações das linhas. */
  amend(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'amend')
      const reason = reasonOf(input.reason)
      const issues: ErrorDetail[] = []
      const set: Record<string, unknown> = {}
      const changes: string[] = []
      if (input.closesAt !== undefined) {
        const d = typeof input.closesAt === 'string' ? new Date(input.closesAt) : null
        if (!d || Number.isNaN(d.getTime()) || d.getTime() <= Date.now())
          issues.push({
            path: 'closesAt',
            code: 'PAST',
            message: 'O prazo de resposta tem de ser futuro.',
          })
        else {
          set.closes_at = d
          changes.push('closesAt')
        }
      }
      for (const [k, col, max] of [
        ['specifications', 'specifications', 10000],
        ['deliveryTerms', 'delivery_terms', 500],
        ['paymentTerms', 'payment_terms', 500],
      ] as const)
        if (input[k] !== undefined) {
          const v = text(input[k]) || null
          if (v && v.length > max)
            issues.push({ path: k, code: 'LENGTH', message: `Até ${max} caracteres.` })
          set[col] = v
          changes.push(k)
        }
      const lineChanges = Array.isArray(input.lines) ? input.lines : []
      const current = await scope.trx.rawQuery(
        `select id from rfq_lines where tenant_id = ? and rfq_id = ?`,
        [context.tenantId, id]
      )
      const ids = new Set((current.rows as any[]).map((x) => x.id as string))
      for (const [i, l] of lineChanges.entries()) {
        if (!ids.has(l?.lineId)) {
          issues.push({
            path: `lines.${i}.lineId`,
            code: 'NOT_FOUND',
            message: 'Linha que não é deste pedido.',
          })
          continue
        }
        if (l.quantity !== undefined) {
          const q = parseScaled(l.quantity, 6)
          if (q === null || q <= 0n)
            issues.push({
              path: `lines.${i}.quantity`,
              code: 'INVALID',
              message: 'Quantidade maior que zero.',
            })
        }
      }
      if (!changes.length && !lineChanges.length)
        issues.push({ path: 'reason', code: 'NOTHING', message: 'Nada a rever.' })
      fail(issues)
      for (const l of lineChanges as any[]) {
        const sets: string[] = []
        const vals: unknown[] = []
        if (l.quantity !== undefined) {
          sets.push('quantity = ?')
          vals.push(scaledText(parseScaled(l.quantity, 6)!, 6))
        }
        if (l.specifications !== undefined) {
          sets.push('specifications = ?')
          vals.push(text(l.specifications).slice(0, 1000) || null)
        }
        if (sets.length)
          await scope.trx.rawQuery(
            `update rfq_lines set ${sets.join(', ')}, updated_by = ?, updated_at = now(), version = version + 1
              where tenant_id = ? and id = ?`,
            [...vals, context.userId, context.tenantId, l.lineId] as never[]
          )
      }
      const revision = Number(r.revision) + 1
      await touch(scope, id, { ...set, revision })
      await rfqEvent(scope, id, 'AMENDED', {
        revision,
        reason,
        details: { fields: changes, lines: lineChanges.length },
      })
      await audit(scope, {
        action: 'rfq.amended',
        entityType: 'rfq',
        entityId: id,
        changes: { revision: { from: Number(r.revision), to: revision } },
      })
      return detail(scope, id)
    })
  }

  decline(context: TenantContext, invitationId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(invitationId)) throw ApiError.notFound()
      const i = (
        await scope.trx.rawQuery(
          `select * from rfq_invitations where tenant_id = ? and id = ? for update`,
          [context.tenantId, invitationId]
        )
      ).rows[0] as any
      if (!i) throw ApiError.notFound()
      const { r } = await authorized(scope, i.rfq_id, 'manage', true)
      stateCheck(r, 'decline')
      const reason = reasonOf(input.reason)
      if (i.status !== 'INVITED')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só um convite sem proposta em vigor pode ser declinado.'
        )
      await scope.trx.rawQuery(
        `update rfq_invitations set status = 'DECLINED', decline_reason = ?, updated_by = ?, updated_at = now(),
            version = version + 1 where tenant_id = ? and id = ?`,
        [reason, context.userId, context.tenantId, invitationId]
      )
      await rfqEvent(scope, r.id, 'DECLINED', { reason, details: { supplierId: i.supplier_id } })
      return detail(scope, r.id)
    })
  }

  /**
   * Registar a proposta de um convidado (nova versão; a anterior fica substituída). Depois do prazo, recusada.
   * Com envelope fechado, nem a auditoria nem o histórico guardam valores.
   */
  registerQuote(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      stateCheck(r, 'quote')
      if (Date.now() > new Date(r.closes_at).getTime())
        throw ApiError.conflict(
          'QUOTE_LATE',
          'O prazo de resposta terminou: a proposta já não pode ser aceite.'
        )
      const t = context.tenantId
      const inv = isUuid(input.supplierId)
        ? ((
            await scope.trx.rawQuery(
              `select * from rfq_invitations where tenant_id = ? and rfq_id = ? and supplier_id = ? for update`,
              [t, id, input.supplierId]
            )
          ).rows[0] as any)
        : null
      if (!inv)
        fail([
          { path: 'supplierId', code: 'NOT_INVITED', message: 'O fornecedor não foi convidado.' },
        ])
      if (inv.status === 'DECLINED')
        throw ApiError.conflict('DECLINED', 'Este fornecedor declinou o convite.')
      const lineIds = new Set(
        (
          (
            await scope.trx.rawQuery(
              `select id from rfq_lines where tenant_id = ? and rfq_id = ?`,
              [t, id]
            )
          ).rows as any[]
        ).map((x) => x.id as string)
      )
      const ql = quoteLines(input.lines, lineIds)
      const issues = [...ql.issues]
      const currency = text(input.currency).toUpperCase() || r.currency
      if (!/^[A-Z]{3}$/.test(currency))
        issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: 3 letras.' })
      if (!isDate(input.validUntil) || (input.validUntil as string) < today())
        issues.push({
          path: 'validUntil',
          code: 'INVALID',
          message: 'Validade da proposta (hoje ou depois).',
        })
      const days = (v: unknown, max: number, path: string) => {
        if (v === undefined || v === null || v === '') return null
        const n = Number(v)
        if (!Number.isInteger(n) || n < 0 || n > max) {
          issues.push({ path, code: 'INVALID', message: `De 0 a ${max} dias.` })
          return null
        }
        return n
      }
      const deliveryDays = days(input.deliveryDays, 730, 'deliveryDays')
      const paymentDays = days(input.paymentTermsDays, 365, 'paymentTermsDays')
      const ref = text(input.supplierReference) || null
      if (ref && ref.length > 60)
        issues.push({ path: 'supplierReference', code: 'LENGTH', message: 'Até 60 caracteres.' })
      const notes = text(input.notes).slice(0, 1000) || null
      let attachmentId: string | null = null
      if (input.attachmentId) {
        const okA =
          isUuid(input.attachmentId) &&
          (
            await scope.trx.rawQuery(
              `select 1 from attachments where tenant_id = ? and id = ? and subject_type = 'rfq' and subject_id = ?
                 and status = 'ACTIVE'`,
              [t, input.attachmentId, id]
            )
          ).rows.length > 0
        if (!okA)
          issues.push({
            path: 'attachmentId',
            code: 'NOT_FOUND',
            message: 'O anexo tem de ser deste pedido.',
          })
        else attachmentId = input.attachmentId as string
      }
      if (!ql.lines.some((l) => l.alternativeNo === 0))
        issues.push({
          path: 'lines',
          code: 'NO_MAIN_OFFER',
          message: 'Indique pelo menos uma oferta principal.',
        })
      fail(issues)
      const prev = await scope.trx.rawQuery(
        `select coalesce(max(quote_version), 0)::int as v from rfq_quotes where tenant_id = ? and rfq_id = ? and supplier_id = ?`,
        [t, id, inv.supplier_id]
      )
      const versionNo = Number((prev.rows[0] as any).v) + 1
      await scope.trx.rawQuery(
        `update rfq_quotes set status = 'SUPERSEDED', updated_by = ?, updated_at = now(), version = version + 1
          where tenant_id = ? and rfq_id = ? and supplier_id = ? and status = 'ACTIVE'`,
        [context.userId, t, id, inv.supplier_id]
      )
      const q = await scope.trx.rawQuery(
        `insert into rfq_quotes (tenant_id, rfq_id, invitation_id, supplier_id, quote_version, rfq_revision,
            supplier_reference, currency, valid_until, delivery_days, payment_terms_days, notes, total_net, total_tax,
            total_amount, attachment_id, received_by, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          t,
          id,
          inv.id,
          inv.supplier_id,
          versionNo,
          r.revision,
          ref,
          currency,
          input.validUntil,
          deliveryDays,
          paymentDays,
          notes,
          money(ql.totals.net),
          money(ql.totals.tax),
          money(ql.totals.total),
          attachmentId,
          context.userId,
          context.userId,
          context.userId,
        ] as never[]
      )
      const quoteId = (q.rows[0] as { id: string }).id
      for (const [i, l] of ql.lines.entries()) {
        const a = ql.amounts[i]
        await scope.trx.rawQuery(
          `insert into rfq_quote_lines (tenant_id, quote_id, rfq_line_id, alternative_no, description, quantity, unit_price,
              tax_rate, net_amount, tax_amount, total_amount, delivery_days, notes, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            t,
            quoteId,
            l.rfqLineId,
            l.alternativeNo,
            l.description,
            scaledText(l.quantity, 6),
            scaledText(l.unitPrice, 6),
            scaledText(l.taxRate, 3),
            money(a.net),
            money(a.tax),
            money(a.total),
            l.deliveryDays,
            l.notes,
            context.userId,
            context.userId,
          ] as never[]
        )
      }
      await scope.trx.rawQuery(
        `update rfq_invitations set status = 'RESPONDED', updated_by = ?, updated_at = now(), version = version + 1
          where tenant_id = ? and id = ?`,
        [context.userId, t, inv.id]
      )
      await touch(scope, id, {})
      const hidden = pricesHidden(r)
      await rfqEvent(scope, id, 'QUOTE_RECEIVED', {
        revision: Number(r.revision),
        details: {
          supplierId: inv.supplier_id,
          quoteVersion: versionNo,
          ...(hidden ? {} : { currency, total: money(ql.totals.total) }),
        },
      })
      await audit(scope, {
        action: 'rfq.quote_received',
        entityType: 'rfq',
        entityId: id,
        changes: {
          supplierId: { from: null, to: inv.supplier_id },
          quoteVersion: { from: versionNo - 1 || null, to: versionNo },
          ...(hidden ? {} : { totalAmount: { from: null, to: money(ql.totals.total) } }),
        },
      })
      return detail(scope, id)
    })
  }

  withdrawQuote(context: TenantContext, quoteId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(quoteId)) throw ApiError.notFound()
      const q = (
        await scope.trx.rawQuery(
          `select * from rfq_quotes where tenant_id = ? and id = ? for update`,
          [context.tenantId, quoteId]
        )
      ).rows[0] as any
      if (!q) throw ApiError.notFound()
      const { r } = await authorized(scope, q.rfq_id, 'manage', true)
      stateCheck(r, 'quote')
      const reason = reasonOf(input.reason)
      if (q.status !== 'ACTIVE')
        throw ApiError.conflict('INVALID_STATE', 'Só a proposta em vigor pode ser retirada.')
      await scope.trx.rawQuery(
        `update rfq_quotes set status = 'WITHDRAWN', withdraw_reason = ?, updated_by = ?, updated_at = now(),
            version = version + 1 where tenant_id = ? and id = ?`,
        [reason, context.userId, context.tenantId, quoteId]
      )
      await scope.trx.rawQuery(
        `update rfq_invitations set status = 'INVITED', updated_by = ?, updated_at = now(), version = version + 1
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, q.invitation_id]
      )
      await rfqEvent(scope, r.id, 'QUOTE_WITHDRAWN', {
        reason,
        details: { supplierId: q.supplier_id, quoteVersion: q.quote_version },
      })
      return detail(scope, r.id)
    })
  }

  /** Abertura das propostas (fecha o pedido): depois do prazo, ou antes se todos os convidados já responderam. */
  open(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'close')
      const inv = await scope.trx.rawQuery(
        `select status from rfq_invitations where tenant_id = ? and rfq_id = ?`,
        [context.tenantId, id]
      )
      if (!canOpen(new Date(r.closes_at), new Date(), inv.rows as any[]))
        throw ApiError.conflict(
          'EARLY_OPENING',
          'Antes do prazo só se abrem as propostas quando todos os convidados responderam ou declinaram.'
        )
      await touch(scope, id, { status: 'CLOSED', opened_at: new Date(), opened_by: context.userId })
      const q = await scope.trx.rawQuery(
        `select count(*)::int as n from rfq_quotes where tenant_id = ? and rfq_id = ? and status = 'ACTIVE'`,
        [context.tenantId, id]
      )
      await rfqEvent(scope, id, 'OPENED', {
        revision: Number(r.revision),
        details: { quotes: Number((q.rows[0] as any).n) },
      })
      await audit(scope, {
        action: 'rfq.opened',
        entityType: 'rfq',
        entityId: id,
        changes: { status: { from: 'OPEN', to: 'CLOSED' } },
      })
      return detail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      stateCheck(r, 'cancel')
      const live = await scope.trx.rawQuery(
        `select 1 from rfq_awards where tenant_id = ? and rfq_id = ? and status in ('DRAFT','PENDING_APPROVAL')`,
        [context.tenantId, id]
      )
      if (live.rows.length)
        throw ApiError.conflict(
          'AWARD_IN_PROGRESS',
          'Há uma adjudicação em preparação ou em aprovação: anule-a primeiro.'
        )
      const reason = reasonOf(input.reason)
      await touch(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await rfqEvent(scope, id, 'CANCELLED', { reason })
      await audit(scope, {
        action: 'rfq.cancelled',
        entityType: 'rfq',
        entityId: id,
        changes: { status: { from: r.status, to: 'CANCELLED' } },
      })
      return detail(scope, id)
    })
  }
}

/** Existe nesta empresa e o membro pode ler (para os anexos do pedido): `null` sem acesso. */
export async function rfqAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const r = (
    await scope.trx.rawQuery(`select legal_entity_id from rfqs where tenant_id = ? and id = ?`, [
      scope.context.tenantId,
      id,
    ])
  ).rows[0] as any
  if (!r) return null
  const s = await scopesOf(scope)
  const manage = coversLe(s.manage, r.legal_entity_id)
  if (!manage && !coversLe(s.read, r.legal_entity_id)) return null
  return { read: true, write: manage }
}
