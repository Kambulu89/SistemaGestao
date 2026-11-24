import { createHash } from 'node:crypto'
import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts } from '#modules/organization/index'
import { documentSeriesFacts, reserveDocumentNumber } from '#modules/settings/index'
import { customerSnapshot } from '#modules/sales/application/customer_service'
import { resolvePrices, searchSalesRefs } from '#modules/sales/application/pricing_service'
import {
  dbScaled,
  PCT_SCALE,
  PRICE_SCALE,
  QTY_SCALE,
  scaledText,
} from '#modules/sales/domain/pricing'
import {
  CAN,
  isExpired,
  type LineInput,
  lineTotals,
  normalizeDecision,
  normalizeHeader,
  normalizeLines,
  normalizeSend,
  QUOTE_STATUSES,
  type QuoteStatus,
  SERIES_TYPE,
  sum,
} from '#modules/sales/domain/quotes'

/*
 * Orçamentos (10.3). Permissões no âmbito da entidade legal (ou só os próprios, como comercial — âmbito OWN):
 * `sales.quotes.read`, `.manage` (criar, editar, submeter, enviar, registar a decisão do cliente, rever, anular) e
 * `.approve` (aprovar descontos acima do limite, nunca os que a própria pessoa submeteu). Preços pelo motor do 10.2
 * (`resolvePrices`) à data do orçamento; identidade do cliente na versão imutável (`customerSnapshot`) no envio.
 */

const today = () => new Date().toISOString().slice(0, 10)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const money = (v: unknown) => scaledText(dbScaled(v, 2), 2)
const num = (v: unknown, scale: number) =>
  v === null || v === undefined ? null : scaledText(dbScaled(v, scale), scale)

interface Scopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    read: await permissionScope(scope, 'sales.quotes.read'),
    manage: await permissionScope(scope, 'sales.quotes.manage'),
    approve: await permissionScope(scope, 'sales.quotes.approve'),
  }
}
/** O âmbito cobre o orçamento: empresa, entidade legal, ou (OWN) os orçamentos de que a pessoa é o comercial. */
const covers = (s: PermissionScope, le: string, salesperson: string | null, me: string) =>
  s.tenant || s.legalEntityIds.has(le) || (s.own && salesperson === me)
const rights = (
  s: Scopes,
  q: { legal_entity_id: string; salesperson_membership_id: string },
  me: string
) => {
  const manage = covers(s.manage, q.legal_entity_id, q.salesperson_membership_id, me)
  const approve = covers(s.approve, q.legal_entity_id, q.salesperson_membership_id, me)
  return {
    read: manage || approve || covers(s.read, q.legal_entity_id, q.salesperson_membership_id, me),
    manage,
    approve,
  }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select *, quote_date::text as qd, valid_until::text as vu from sales_quotes where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}

async function authorized(
  scope: TenantScope,
  id: string,
  need: 'read' | 'manage' | 'approve',
  lock = false
) {
  const q = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), q, scope.context.membershipId)
  if (!g.read) throw ApiError.notFound()
  if (need === 'manage' && !g.manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere orçamentos desta entidade.')
  if (need === 'approve' && !g.approve)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova orçamentos desta entidade.')
  return { q, g }
}

const versionCheck = (q: any, expected: unknown) => {
  if (Number(q.version) !== Number(expected)) throw ApiError.versionConflict(Number(q.version))
}
const inState = (q: any, action: keyof typeof CAN, message: string) => {
  if (!CAN[action].includes(q.status)) throw ApiError.conflict('INVALID_STATE', message)
}
const reasonOf = (v: unknown) => {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}

async function event(
  scope: TenantScope,
  q: any,
  kind: string,
  e: {
    to?: string | null
    reason?: string | null
    details?: Record<string, unknown>
    versionNo?: number
  } = {}
) {
  await scope.trx.rawQuery(
    `insert into sales_quote_events (tenant_id, quote_id, kind, version_no, from_status, to_status, reason, details,
       created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      q.id,
      kind,
      e.versionNo ?? q.version_no,
      q.status,
      e.to ?? null,
      e.reason ?? null,
      e.details ? JSON.stringify(e.details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function setQuote(scope: TenantScope, id: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields)
  await scope.trx.rawQuery(
    `update sales_quotes set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(),
       updated_by = ? where tenant_id = ? and id = ?`,
    [...cols.map((c) => fields[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function customerRow(scope: TenantScope, id: string) {
  return (
    ((
      await scope.trx.rawQuery(
        `select c.id, c.status, c.currency, c.payment_terms_days, p.code, p.name from customers c
           join business_partners p on p.tenant_id = c.tenant_id and p.id = c.partner_id
          where c.tenant_id = ? and c.id = ?`,
        [scope.context.tenantId, id]
      )
    ).rows[0] as any) ?? null
  )
}
const customerActive = (c: any) => {
  if (c.status !== 'ACTIVE')
    throw ApiError.conflict(
      'CUSTOMER_BLOCKED',
      c.status === 'BLOCKED' ? 'O cliente está bloqueado.' : 'O cliente está inactivo.'
    )
}

/** Preços das linhas pelo motor do 10.2 (à data do orçamento) e totais. */
async function priced(
  scope: TenantScope,
  h: { customerId: string; currency: string; date: string; legalEntityId: string },
  lines: LineInput[]
) {
  if (!lines.length)
    return {
      rows: [],
      net: '0.00',
      tax: '0.00',
      gross: '0.00',
      requiresApproval: false,
      missing: false,
      hash: null as string | null,
    }
  const snap = await resolvePrices(scope, {
    customerId: h.customerId,
    currency: h.currency,
    date: h.date,
    legalEntityId: h.legalEntityId,
    lines: lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      quantity: l.quantity,
      manualDiscountPct: l.manualDiscountPct,
      manualUnitPrice: l.manualUnitPrice,
    })),
  })
  const rows = lines.map((l, i) => {
    const r = snap.lines[i]
    const t = lineTotals(r.netAmount, l.taxRate)
    return { input: l, r, ...t }
  })
  return {
    rows,
    net: sum(rows.map((x) => x.net)),
    tax: sum(rows.map((x) => x.tax)),
    gross: sum(rows.map((x) => x.gross)),
    requiresApproval: snap.requiresApproval,
    missing: snap.missingPrices,
    hash: snap.hash,
  }
}

async function storedLines(scope: TenantScope, quoteId: string): Promise<LineInput[]> {
  const rows = (
    await scope.trx.rawQuery(
      `select * from sales_quote_lines where tenant_id = ? and quote_id = ? order by line_no`,
      [scope.context.tenantId, quoteId]
    )
  ).rows as any[]
  return rows.map((l) => ({
    productId: l.product_id,
    variantId: l.variant_id ?? null,
    description: l.description,
    quantity: num(l.quantity, QTY_SCALE)!,
    manualDiscountPct: num(l.manual_discount_pct, PCT_SCALE),
    manualUnitPrice: num(l.manual_unit_price, PRICE_SCALE),
    taxRate: num(l.tax_rate, PCT_SCALE)!,
    taxExemptionReason: l.tax_exemption_reason ?? null,
  }))
}

/** Grava as linhas (substitui) e os totais do rascunho. */
async function writeLines(scope: TenantScope, q: any, lines: LineInput[]) {
  const t = scope.context.tenantId
  const p = await priced(
    scope,
    {
      customerId: q.customer_id,
      currency: String(q.currency).trim(),
      date: q.qd,
      legalEntityId: q.legal_entity_id,
    },
    lines
  )
  await scope.trx.rawQuery(`delete from sales_quote_lines where tenant_id = ? and quote_id = ?`, [
    t,
    q.id,
  ])
  for (const [i, x] of p.rows.entries())
    await scope.trx.rawQuery(
      `insert into sales_quote_lines (tenant_id, quote_id, line_no, product_id, variant_id, description, quantity,
         manual_discount_pct, manual_unit_price, tax_rate, tax_exemption_reason, price_source, base_price, net_unit_price,
         net_amount, tax_amount, gross_amount, requires_approval, pricing, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        q.id,
        i + 1,
        x.input.productId,
        x.input.variantId,
        x.input.description ?? x.r.name,
        x.input.quantity,
        x.input.manualDiscountPct,
        x.input.manualUnitPrice,
        x.input.taxRate,
        x.input.taxExemptionReason,
        x.r.source,
        x.r.basePrice,
        x.r.netUnitPrice,
        x.net,
        x.tax,
        x.gross,
        x.r.requiresApproval,
        JSON.stringify(x.r),
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
  return p
}

async function detail(
  scope: TenantScope,
  id: string,
  g?: { read: boolean; manage: boolean; approve: boolean }
) {
  const t = scope.context.tenantId
  const q = (
    await scope.trx.rawQuery(
      `select q.*, q.quote_date::text as qd, q.valid_until::text as vu, le.code as le_code, le.legal_name as le_name,
              bp.code as cus_code, bp.name as cus_name, c.status as cus_status, u.full_name as sp_name,
              ds.code as series_code
         from sales_quotes q
         join legal_entities le on le.tenant_id = q.tenant_id and le.id = q.legal_entity_id
         join customers c on c.tenant_id = q.tenant_id and c.id = q.customer_id
         join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
         join tenant_memberships m on m.tenant_id = q.tenant_id and m.id = q.salesperson_membership_id
         join users u on u.id = m.user_id
         left join document_series ds on ds.tenant_id = q.tenant_id and ds.id = q.series_id
        where q.tenant_id = ? and q.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!q) throw ApiError.notFound()
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, p.sku, v.sku as variant_sku from sales_quote_lines l
         join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
        where l.tenant_id = ? and l.quote_id = ? order by l.line_no`,
      [t, id]
    )
  ).rows as any[]
  const versions = (
    await scope.trx.rawQuery(
      `select v.version_no, v.hash, v.sent_channel, v.sent_to, v.created_at, u.full_name, cv.version_no as cv_no
         from sales_quote_versions v left join users u on u.id = v.created_by
         join customer_versions cv on cv.tenant_id = v.tenant_id and cv.id = v.customer_version_id
        where v.tenant_id = ? and v.quote_id = ? order by v.version_no desc`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from sales_quote_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.quote_id = ? order by e.created_at, e.id`,
      [t, id]
    )
  ).rows as any[]
  const access = g ?? rights(await scopesOf(scope), q, scope.context.membershipId)
  const status = q.status as QuoteStatus
  const can = (a: keyof typeof CAN) => CAN[a].includes(status)
  const self = q.submitted_by === scope.context.userId
  return {
    id: q.id as string,
    version: Number(q.version),
    number: (q.number as string) ?? null,
    versionNo: Number(q.version_no),
    status,
    expired: isExpired(status, q.vu, today()),
    legalEntity: {
      id: q.legal_entity_id as string,
      code: q.le_code as string,
      name: q.le_name as string,
    },
    customer: {
      id: q.customer_id as string,
      code: q.cus_code as string,
      name: q.cus_name as string,
      status: q.cus_status as string,
    },
    salesperson: { membershipId: q.salesperson_membership_id as string, name: q.sp_name as string },
    series: q.series_id ? { id: q.series_id as string, code: q.series_code as string } : null,
    quoteDate: q.qd as string,
    validUntil: q.vu as string,
    currency: String(q.currency).trim(),
    paymentTermsDays: Number(q.payment_terms_days),
    customerReference: (q.customer_reference as string) ?? null,
    notes: (q.notes as string) ?? null,
    netTotal: money(q.net_total),
    taxTotal: money(q.tax_total),
    grossTotal: money(q.gross_total),
    requiresApproval: !!q.requires_approval,
    pricingHash: (q.pricing_hash as string) ?? null,
    sentAt: q.sent_at ? new Date(q.sent_at).toISOString() : null,
    decidedAt: q.decided_at ? new Date(q.decided_at).toISOString() : null,
    decidedByName: (q.decided_by_name as string) ?? null,
    decisionReason: (q.decision_reason as string) ?? null,
    convertedOrderId: (q.converted_order_id as string) ?? null,
    lines: lines.map((l) => ({
      id: l.id as string,
      lineNo: Number(l.line_no),
      product: { id: l.product_id as string, sku: l.sku as string },
      variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
      description: l.description as string,
      quantity: num(l.quantity, QTY_SCALE)!,
      manualDiscountPct: num(l.manual_discount_pct, PCT_SCALE),
      manualUnitPrice: num(l.manual_unit_price, PRICE_SCALE),
      taxRate: num(l.tax_rate, PCT_SCALE)!,
      taxExemptionReason: (l.tax_exemption_reason as string) ?? null,
      priceSource: l.price_source as string,
      basePrice: num(l.base_price, PRICE_SCALE),
      netUnitPrice: num(l.net_unit_price, PRICE_SCALE),
      netAmount: money(l.net_amount),
      taxAmount: money(l.tax_amount),
      grossAmount: money(l.gross_amount),
      requiresApproval: !!l.requires_approval,
      pricing: l.pricing as Record<string, unknown>,
    })),
    versions: versions.map((v) => ({
      versionNo: Number(v.version_no),
      hash: v.hash as string,
      channel: v.sent_channel as string,
      sentTo: (v.sent_to as string) ?? null,
      at: new Date(v.created_at).toISOString(),
      by: (v.full_name as string) ?? null,
      customerVersionNo: Number(v.cv_no),
    })),
    history: events.map((e) => ({
      kind: e.kind as string,
      versionNo: Number(e.version_no),
      from: (e.from_status as string) ?? null,
      to: (e.to_status as string) ?? null,
      reason: (e.reason as string) ?? null,
      details: (e.details as Record<string, unknown>) ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: {
      edit: access.manage && can('edit'),
      submit: access.manage && can('submit'),
      approve: access.approve && can('approve') && !self,
      reject: access.approve && can('reject'),
      send: access.manage && can('send'),
      accept: access.manage && can('accept'),
      decline: access.manage && can('decline'),
      revise: access.manage && can('revise'),
      cancel: access.manage && can('cancel'),
    },
  }
}
export type QuoteView = Awaited<ReturnType<typeof detail>>

/** Comercial: membro activo da empresa (por omissão, quem cria). */
async function salespersonOk(scope: TenantScope, id: string) {
  const m = (
    await scope.trx.rawQuery(
      `select status from tenant_memberships where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!m || m.status !== 'ACTIVE')
    fail([
      {
        path: 'salespersonMembershipId',
        code: 'NOT_FOUND',
        message: 'Comercial inexistente ou inactivo.',
      },
    ])
}

export class QuoteService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      customerId?: string
      legalEntityId?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const where = ['q.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      const all = [s.read, s.manage, s.approve]
      if (!all.some((x) => x.tenant)) {
        const les = [...new Set(all.flatMap((x) => [...x.legalEntityIds]))]
        const own = all.some((x) => x.own)
        if (!les.length && !own)
          throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar orçamentos.')
        const or: string[] = []
        if (les.length) {
          or.push(`q.legal_entity_id in (${les.map(() => '?').join(', ')})`)
          params.push(...les)
        }
        if (own) {
          or.push('q.salesperson_membership_id = ?')
          params.push(context.membershipId)
        }
        where.push(`(${or.join(' or ')})`)
      }
      if (f.status === 'EXPIRED') {
        where.push(`q.status = 'SENT' and q.valid_until < ?::date`)
        params.push(today())
      } else if (f.status && (QUOTE_STATUSES as readonly string[]).includes(f.status)) {
        where.push('q.status = ?')
        params.push(f.status)
      }
      for (const [k, col] of [
        ['customerId', 'q.customer_id'],
        ['legalEntityId', 'q.legal_entity_id'],
      ] as const)
        if (f[k] && isUuid(f[k])) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(q.number, '')) like ? or lower(bp.code) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like)
      }
      const from = `from sales_quotes q
        join customers c on c.tenant_id = q.tenant_id and c.id = q.customer_id
        join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
        join legal_entities le on le.tenant_id = q.tenant_id and le.id = q.legal_entity_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select q.*, q.quote_date::text as qd, q.valid_until::text as vu, bp.code as cus_code, bp.name as cus_name,
                  le.code as le_code ${from} order by q.created_at desc, q.id limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      return {
        items: rows.map((q) => ({
          id: q.id as string,
          number: (q.number as string) ?? null,
          versionNo: Number(q.version_no),
          customer: { code: q.cus_code as string, name: q.cus_name as string },
          legalEntity: q.le_code as string,
          quoteDate: q.qd as string,
          validUntil: q.vu as string,
          currency: String(q.currency).trim(),
          grossTotal: money(q.gross_total),
          status: q.status as string,
          expired: isExpired(q.status, q.vu, today()),
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const { g } = await authorized(scope, id, 'read')
      return detail(scope, id, g)
    })
  }

  /** Opções do formulário: entidades onde pode gerir, comerciais e séries de orçamento. */
  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const t = context.tenantId
      const les = (
        await scope.trx.rawQuery(
          `select id, code, legal_name, status from legal_entities where tenant_id = ? order by code`,
          [t]
        )
      ).rows as any[]
      const manageable = les.filter(
        (l) =>
          l.status === 'ACTIVE' &&
          (s.manage.tenant || s.manage.legalEntityIds.has(l.id) || s.manage.own)
      )
      const people = (
        await scope.trx.rawQuery(
          `select m.id, u.full_name from tenant_memberships m join users u on u.id = m.user_id
            where m.tenant_id = ? and m.status = 'ACTIVE' order by u.full_name`,
          [t]
        )
      ).rows as any[]
      const series = (
        await scope.trx.rawQuery(
          `select id, code, prefix, legal_entity_id from document_series where tenant_id = ? and document_type = ?
              and status = 'ACTIVE' order by code`,
          [t, SERIES_TYPE]
        )
      ).rows as any[]
      return {
        legalEntities: manageable.map((l) => ({
          id: l.id as string,
          code: l.code as string,
          name: l.legal_name as string,
        })),
        salespeople: people.map((p) => ({
          membershipId: p.id as string,
          name: p.full_name as string,
        })),
        series: series.map((x) => ({
          id: x.id as string,
          code: x.code as string,
          prefix: x.prefix as string,
          legalEntityId: x.legal_entity_id as string,
        })),
        me: context.membershipId,
        ownOnly: !s.manage.tenant && s.manage.legalEntityIds.size === 0 && s.manage.own,
      }
    })
  }

  search(context: TenantContext, kind: 'customers' | 'products', q: string) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const any = (x: PermissionScope) => x.tenant || x.own || x.legalEntityIds.size > 0
      if (!any(s.manage)) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere orçamentos.')
      return searchSalesRefs(scope, kind, q)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, issues } = normalizeHeader(input, true)
      const { lines, issues: li } = normalizeLines(input.lines ?? [])
      fail([...issues, ...li])
      const le = await legalEntityFacts(scope, v.legalEntityId as string)
      if (!le)
        fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' }])
      const salesperson = (v.salespersonMembershipId as string | null) ?? context.membershipId
      const s = await scopesOf(scope)
      if (!covers(s.manage, le!.id, salesperson, context.membershipId))
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Não gere orçamentos desta entidade (ou de outro comercial).'
        )
      if (le!.status !== 'ACTIVE')
        throw ApiError.conflict('INVALID_STATE', 'A entidade legal não está activa.')
      await salespersonOk(scope, salesperson)
      const c = await customerRow(scope, v.customerId as string)
      if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
      customerActive(c)
      const ins = await scope.trx.rawQuery(
        `insert into sales_quotes (tenant_id, legal_entity_id, customer_id, salesperson_membership_id, quote_date,
           valid_until, currency, payment_terms_days, customer_reference, notes, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          le!.id,
          c.id,
          salesperson,
          v.quoteDate,
          v.validUntil,
          (v.currency as string) ?? String(c.currency).trim(),
          (v.paymentTermsDays as number) ?? Number(c.payment_terms_days),
          v.customerReference ?? null,
          v.notes ?? null,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as any).id as string
      const q = await load(scope, id)
      const p = await writeLines(scope, q, lines)
      await setQuote(scope, id, {
        net_total: p.net,
        tax_total: p.tax,
        gross_total: p.gross,
        requires_approval: p.requiresApproval,
        pricing_hash: p.hash,
      })
      await event(scope, q, 'CREATED', { to: 'DRAFT' })
      await audit(scope, {
        action: 'sales_quote.created',
        entityType: 'sales_quote',
        entityId: id,
        changes: { customerId: { from: null, to: c.id }, grossTotal: { from: null, to: p.gross } },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'manage', true)
      versionCheck(q, input.expectedVersion)
      inState(q, 'edit', 'Só se altera em rascunho; reveja o orçamento para criar uma versão nova.')
      const { expectedVersion, lines: rawLines, legalEntityId, ...rest } = input
      const { v, issues } = normalizeHeader(rest, false)
      const quoteDate = (v.quoteDate as string) ?? q.qd
      const validUntil = (v.validUntil as string) ?? q.vu
      if (validUntil < quoteDate)
        issues.push({
          path: 'validUntil',
          code: 'INVALID',
          message: 'A validade não pode ser antes da data.',
        })
      const nl = rawLines === undefined ? null : normalizeLines(rawLines)
      fail([...issues, ...(nl?.issues ?? [])])
      if (v.salespersonMembershipId === null) delete v.salespersonMembershipId
      if (v.salespersonMembershipId) {
        const s = await scopesOf(scope)
        if (
          !covers(
            s.manage,
            q.legal_entity_id,
            v.salespersonMembershipId as string,
            context.membershipId
          )
        )
          throw ApiError.forbidden(
            'OUT_OF_SCOPE',
            'Não pode atribuir o orçamento a outro comercial.'
          )
        await salespersonOk(scope, v.salespersonMembershipId as string)
      }
      if (v.customerId && v.customerId !== q.customer_id) {
        const c = await customerRow(scope, v.customerId as string)
        if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
        customerActive(c)
      }
      const map: Record<string, string> = {
        customerId: 'customer_id',
        salespersonMembershipId: 'salesperson_membership_id',
        quoteDate: 'quote_date',
        validUntil: 'valid_until',
        currency: 'currency',
        paymentTermsDays: 'payment_terms_days',
        customerReference: 'customer_reference',
        notes: 'notes',
      }
      const fields: Record<string, unknown> = {}
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const [k, col] of Object.entries(map))
        if (k in v) {
          fields[col] = v[k]
          changes[k] = {
            from: col === 'quote_date' ? q.qd : col === 'valid_until' ? q.vu : q[col],
            to: v[k],
          }
        }
      if (Object.keys(fields).length) await setQuote(scope, id, fields)
      const cur = await load(scope, id)
      const p = await writeLines(scope, cur, nl ? nl.lines : await storedLines(scope, id))
      await setQuote(scope, id, {
        net_total: p.net,
        tax_total: p.tax,
        gross_total: p.gross,
        requires_approval: p.requiresApproval,
        pricing_hash: p.hash,
      })
      if (nl) changes.lines = { from: null, to: nl.lines.length }
      changes.grossTotal = { from: money(q.gross_total), to: p.gross }
      await audit(scope, {
        action: 'sales_quote.updated',
        entityType: 'sales_quote',
        entityId: id,
        changes,
      })
      return detail(scope, id)
    })
  }

  /** Submeter: preços recalculados; sem linhas acima do limite fica aprovado, senão aguarda outra pessoa. */
  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'manage', true)
      versionCheck(q, input.expectedVersion)
      inState(q, 'submit', 'Só se submete um rascunho.')
      customerActive(await customerRow(scope, q.customer_id))
      const lines = await storedLines(scope, id)
      if (!lines.length) throw ApiError.conflict('NO_LINES', 'O orçamento não tem linhas.')
      const p = await writeLines(scope, q, lines)
      if (p.missing)
        throw ApiError.conflict(
          'NO_PRICE',
          'Há linhas sem preço: indique um preço manual ou crie a tabela.'
        )
      await setQuote(scope, id, {
        net_total: p.net,
        tax_total: p.tax,
        gross_total: p.gross,
        requires_approval: p.requiresApproval,
        pricing_hash: p.hash,
      })
      const to: QuoteStatus = p.requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED'
      await setQuote(scope, id, {
        status: to,
        submitted_by: context.userId,
        submitted_at: new Date(),
        approved_by: null,
        approved_at: to === 'APPROVED' ? new Date() : null,
      })
      await event(scope, q, 'SUBMITTED', {
        to,
        details: { requiresApproval: p.requiresApproval, grossTotal: p.gross },
      })
      await audit(scope, {
        action: 'sales_quote.submitted',
        entityType: 'sales_quote',
        entityId: id,
        changes: { status: { from: 'DRAFT', to } },
        metadata: { requiresApproval: p.requiresApproval },
      })
      return detail(scope, id)
    })
  }

  approve(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'approve', true)
      versionCheck(q, input.expectedVersion)
      inState(q, 'approve', 'Só se aprova um orçamento a aguardar aprovação.')
      if (q.submitted_by === context.userId)
        throw ApiError.forbidden('SELF_APPROVAL', 'Quem submete não aprova os próprios descontos.')
      await setQuote(scope, id, {
        status: 'APPROVED',
        approved_by: context.userId,
        approved_at: new Date(),
      })
      await event(scope, q, 'APPROVED', { to: 'APPROVED' })
      await audit(scope, {
        action: 'sales_quote.approved',
        entityType: 'sales_quote',
        entityId: id,
        changes: { status: { from: q.status, to: 'APPROVED' } },
      })
      return detail(scope, id)
    })
  }

  reject(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'approve', true)
      versionCheck(q, input.expectedVersion)
      inState(q, 'reject', 'Só se devolve um orçamento a aguardar aprovação.')
      const reason = reasonOf(input.reason)
      await setQuote(scope, id, { status: 'DRAFT', submitted_by: null, submitted_at: null })
      await event(scope, q, 'REJECTED', { to: 'DRAFT', reason })
      await audit(scope, {
        action: 'sales_quote.rejected',
        entityType: 'sales_quote',
        entityId: id,
        changes: { status: { from: q.status, to: 'DRAFT' } },
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }

  /** Enviar: número na primeira vez (série explícita se houver várias) e fotografia imutável da versão enviada. */
  send(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'manage', true)
      versionCheck(q, input.expectedVersion)
      inState(q, 'send', 'Só se envia um orçamento aprovado.')
      const s = normalizeSend(input)
      fail(s.issues)
      if (q.vu < today())
        throw ApiError.conflict(
          'EXPIRED',
          'A validade já passou: reveja o orçamento com uma nova validade.'
        )
      const cust = await customerSnapshot(scope, q.customer_id)
      if (cust.status !== 'ACTIVE')
        throw ApiError.conflict('CUSTOMER_BLOCKED', 'O cliente não está activo.')
      const fields: Record<string, unknown> = { status: 'SENT', sent_at: new Date() }
      if (!q.number) {
        let seriesId = s.seriesId
        if (seriesId) {
          const f = await documentSeriesFacts(scope, seriesId)
          if (!f || f.documentType !== SERIES_TYPE || f.legalEntityId !== q.legal_entity_id)
            fail([
              {
                path: 'seriesId',
                code: 'NOT_FOUND',
                message: 'Série de orçamentos inexistente nesta entidade.',
              },
            ])
        } else {
          const ser = (
            await scope.trx.rawQuery(
              `select id, code from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ?
                  and status = 'ACTIVE' and (valid_from is null or valid_from <= ?::date)
                  and (valid_to is null or valid_to >= ?::date) order by code`,
              [context.tenantId, q.legal_entity_id, SERIES_TYPE, today(), today()]
            )
          ).rows as any[]
          if (!ser.length)
            throw ApiError.conflict(
              'NO_SERIES',
              `Sem série documental ${SERIES_TYPE} activa para a entidade: crie-a em Séries documentais.`
            )
          if (ser.length > 1)
            throw new ApiError(
              409,
              'SERIES_REQUIRED',
              'Há várias séries de orçamentos: escolha uma.',
              [
                {
                  path: 'seriesId',
                  code: 'REQUIRED',
                  message: `Escolha a série (${ser.map((x) => x.code).join(', ')}).`,
                },
              ]
            )
          seriesId = ser[0].id
        }
        fields.series_id = seriesId
        fields.number = (await reserveDocumentNumber(scope, seriesId!, today())).formatted
      }
      await setQuote(scope, id, fields)
      const sent = (
        await scope.trx.rawQuery(
          `select 1 from sales_quote_versions where tenant_id = ? and quote_id = ? and version_no = ?`,
          [context.tenantId, id, q.version_no]
        )
      ).rows[0]
      if (!sent) {
        const view = await detail(scope, id)
        const data = {
          number: view.number,
          versionNo: view.versionNo,
          legalEntity: view.legalEntity,
          customer: { id: cust.customerId, versionNo: cust.versionNo, data: cust.data },
          salesperson: view.salesperson.name,
          quoteDate: view.quoteDate,
          validUntil: view.validUntil,
          currency: view.currency,
          paymentTermsDays: view.paymentTermsDays,
          customerReference: view.customerReference,
          notes: view.notes,
          // O id interno da linha não faz parte da fotografia (muda a cada edição do rascunho).
          lines: view.lines.map((l) => ({ ...l, id: undefined })),
          totals: { net: view.netTotal, tax: view.taxTotal, gross: view.grossTotal },
          pricingHash: view.pricingHash,
        }
        const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex')
        await scope.trx.rawQuery(
          `insert into sales_quote_versions (tenant_id, quote_id, version_no, customer_version_id, data, hash, sent_channel,
             sent_to, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            id,
            q.version_no,
            cust.versionId,
            JSON.stringify(data),
            hash,
            s.channel,
            s.sentTo,
            context.userId,
            context.userId,
          ] as never[]
        )
      }
      await event(scope, q, 'SENT', {
        to: 'SENT',
        details: { channel: s.channel, sentTo: s.sentTo, number: fields.number ?? q.number },
      })
      await audit(scope, {
        action: 'sales_quote.sent',
        entityType: 'sales_quote',
        entityId: id,
        changes: { status: { from: q.status, to: 'SENT' } },
        metadata: { channel: s.channel, versionNo: q.version_no },
      })
      return detail(scope, id)
    })
  }

  private decide(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    accept: boolean
  ) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'manage', true)
      versionCheck(q, input.expectedVersion)
      inState(
        q,
        accept ? 'accept' : 'decline',
        'Só se regista a decisão do cliente num orçamento enviado.'
      )
      const d = normalizeDecision(input, accept)
      fail(d.issues)
      if (d.versionNo !== Number(q.version_no))
        throw ApiError.conflict(
          'VERSION_MISMATCH',
          `A decisão tem de ser sobre a versão enviada em vigor (${q.version_no}).`
        )
      if (accept && q.vu < today())
        throw ApiError.conflict(
          'EXPIRED',
          'A validade já passou: reveja o orçamento com uma nova validade.'
        )
      const to: QuoteStatus = accept ? 'ACCEPTED' : 'DECLINED'
      await setQuote(scope, id, {
        status: to,
        decided_at: new Date(),
        decided_by_name: d.name,
        decision_reason: d.reason,
      })
      await event(scope, q, accept ? 'ACCEPTED' : 'DECLINED', {
        to,
        reason: d.reason,
        details: { by: d.name, customerReference: d.customerReference },
      })
      await audit(scope, {
        action: `sales_quote.${accept ? 'accepted' : 'declined'}`,
        entityType: 'sales_quote',
        entityId: id,
        changes: { status: { from: q.status, to } },
        metadata: { versionNo: q.version_no, by: d.name },
      })
      return detail(scope, id)
    })
  }
  accept(context: TenantContext, id: string, input: Record<string, unknown>) {
    return this.decide(context, id, input, true)
  }
  decline(context: TenantContext, id: string, input: Record<string, unknown>) {
    return this.decide(context, id, input, false)
  }

  /** Rever: volta a rascunho com a versão seguinte (a enviada fica fotografada); mantém o número. */
  revise(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'manage', true)
      versionCheck(q, input.expectedVersion)
      inState(q, 'revise', 'Só se revê um orçamento aprovado, enviado ou recusado.')
      const reason = reasonOf(input.reason)
      const next = Number(q.version_no) + 1
      await setQuote(scope, id, {
        status: 'DRAFT',
        version_no: next,
        submitted_by: null,
        submitted_at: null,
        approved_by: null,
        approved_at: null,
        decided_at: null,
        decided_by_name: null,
        decision_reason: null,
      })
      await event(scope, q, 'REVISED', {
        to: 'DRAFT',
        reason,
        versionNo: next,
        details: { fromVersion: Number(q.version_no) },
      })
      await audit(scope, {
        action: 'sales_quote.revised',
        entityType: 'sales_quote',
        entityId: id,
        changes: { versionNo: { from: Number(q.version_no), to: next } },
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { q } = await authorized(scope, id, 'manage', true)
      versionCheck(q, input.expectedVersion)
      inState(q, 'cancel', 'Não se anula um orçamento aceite, recusado ou já anulado.')
      const reason = reasonOf(input.reason)
      await setQuote(scope, id, { status: 'CANCELLED', decision_reason: reason })
      await event(scope, q, 'CANCELLED', { to: 'CANCELLED', reason })
      await audit(scope, {
        action: 'sales_quote.cancelled',
        entityType: 'sales_quote',
        entityId: id,
        changes: { status: { from: q.status, to: 'CANCELLED' } },
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Contrato para as encomendas (10.4): conversão única de um orçamento aceite.
// ---------------------------------------------------------------------------------------------------------------

/** Orçamento aceite pronto a converter (cabeçalho, linhas com o snapshot de preço e a versão enviada aceite). */
export async function acceptedQuote(scope: TenantScope, quoteId: string) {
  const q = await load(scope, quoteId, true)
  if (q.status === 'CONVERTED')
    throw ApiError.conflict('ALREADY_CONVERTED', 'O orçamento já foi convertido numa encomenda.')
  if (q.status !== 'ACCEPTED')
    throw ApiError.conflict('NOT_ACCEPTED', 'Só se converte um orçamento aceite pelo cliente.')
  const v = (
    await scope.trx.rawQuery(
      `select customer_version_id, hash from sales_quote_versions where tenant_id = ? and quote_id = ? and version_no = ?`,
      [scope.context.tenantId, quoteId, q.version_no]
    )
  ).rows[0] as any
  return {
    quote: await detail(scope, quoteId),
    customerVersionId: v.customer_version_id as string,
    versionHash: v.hash as string,
  }
}

/** Marca o orçamento como convertido na encomenda; uma segunda conversão (ou concorrente) falha com 409. */
export async function markQuoteConverted(scope: TenantScope, quoteId: string, orderId: string) {
  try {
    const r = await scope.trx.rawQuery(
      `update sales_quotes set status = 'CONVERTED', converted_order_id = ?, converted_at = now(), version = version + 1,
         updated_at = now(), updated_by = ? where tenant_id = ? and id = ? and status = 'ACCEPTED' and converted_order_id is null
       returning id, version_no, status`,
      [orderId, scope.context.userId, scope.context.tenantId, quoteId]
    )
    if (!r.rows.length)
      throw ApiError.conflict(
        'ALREADY_CONVERTED',
        'O orçamento já foi convertido ou não está aceite.'
      )
  } catch (e: any) {
    if (e?.code === '23505')
      throw ApiError.conflict('ALREADY_CONVERTED', 'Esta encomenda já tem um orçamento.')
    throw e
  }
  const q = await load(scope, quoteId)
  await scope.trx.rawQuery(
    `insert into sales_quote_events (tenant_id, quote_id, kind, version_no, from_status, to_status, details, created_by,
       updated_by) values (?, ?, 'CONVERTED', ?, 'ACCEPTED', 'CONVERTED', ?, ?, ?)`,
    [
      scope.context.tenantId,
      quoteId,
      q.version_no,
      JSON.stringify({ orderId }),
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  await audit(scope, {
    action: 'sales_quote.converted',
    entityType: 'sales_quote',
    entityId: quoteId,
    changes: { status: { from: 'ACCEPTED', to: 'CONVERTED' } },
    metadata: { orderId },
  })
}

/** Acesso aos anexos do orçamento: ler com qualquer permissão no âmbito; acrescentar com `.manage`. */
export async function quoteAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const q = (
    await scope.trx.rawQuery(
      `select legal_entity_id, salesperson_membership_id from sales_quotes where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!q) return null
  const g = rights(await scopesOf(scope), q, scope.context.membershipId)
  return g.read ? { read: true, write: g.manage } : null
}
