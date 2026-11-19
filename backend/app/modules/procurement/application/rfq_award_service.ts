import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { legalEntityFacts } from '#modules/organization/index'
import { rateOn } from '#modules/settings/index'
import { coversLe, rfqEvent, rfqScopes } from '#modules/procurement/application/rfq_service'
import {
  lineAmounts,
  money,
  parseScaled,
  scaledText,
} from '#modules/procurement/domain/requisitions'
import {
  type AwardLineInput,
  awardLineIssues,
  type AwardStatus,
  decideBlockedBy,
  normalizeQuality,
  normalizeWeights,
  type Offer,
  scoreOffers,
  toBase6,
  toBaseCents,
  type Weights,
} from '#modules/procurement/domain/awards'

/*
 * Comparação e adjudicação (9.4). A comparação é calculada na hora sobre as propostas em vigor de um pedido fechado;
 * a adjudicação guarda pesos, notas de qualidade, as ofertas escolhidas por linha e fornecedor (com a fotografia dos
 * valores) e a justificação, e é aprovada por outra pessoa com `procurement.rfqs.approve` na entidade. Aprovada, o
 * pedido fica adjudicado; recusada ou anulada, pode preparar-se outra.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const c2 = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n
const r10 = (v: unknown) => parseScaled(String(v ?? '0'), 10) ?? 0n
const today = () => new Date().toISOString().slice(0, 10)
const isoDate = (v: unknown) => {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v as Date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const ONE = 10n ** 10n

async function rfqRow(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select * from rfqs where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}

async function access(scope: TenantScope, legalEntityId: string) {
  const s = await rfqScopes(scope)
  return {
    read: coversLe(s.read, legalEntityId) || coversLe(s.manage, legalEntityId),
    manage: coversLe(s.manage, legalEntityId),
    approve: coversLe(s.approve, legalEntityId),
  }
}

/** Tudo o que a comparação precisa: linhas, propostas em vigor, câmbios na data da abertura, ofertas pontuáveis. */
async function compareData(scope: TenantScope, r: any, weights: Weights, rawQuality: unknown) {
  const t = scope.context.tenantId
  const le = await legalEntityFacts(scope, r.legal_entity_id)
  const base = le!.functionalCurrency
  const rateDate = new Date(r.opened_at).toISOString().slice(0, 10)
  const lines = (
    await scope.trx.rawQuery(
      `select * from rfq_lines where tenant_id = ? and rfq_id = ? order by line_no`,
      [t, r.id]
    )
  ).rows as any[]
  const quotes = (
    await scope.trx.rawQuery(
      `select q.*, bp.code, bp.name from rfq_quotes q join suppliers s on s.tenant_id = q.tenant_id and s.id = q.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where q.tenant_id = ? and q.rfq_id = ? and q.status = 'ACTIVE' order by bp.code`,
      [t, r.id]
    )
  ).rows as any[]
  const qlines = (
    await scope.trx.rawQuery(
      `select ql.* from rfq_quote_lines ql join rfq_quotes q on q.tenant_id = ql.tenant_id and q.id = ql.quote_id
        where ql.tenant_id = ? and q.rfq_id = ? and q.status = 'ACTIVE' order by ql.alternative_no`,
      [t, r.id]
    )
  ).rows as any[]
  const rates = new Map<string, bigint | null>([[base, ONE]])
  for (const q of quotes)
    if (!rates.has(q.currency)) {
      const fx = await rateOn(scope, q.currency, base, rateDate)
      rates.set(q.currency, fx ? r10(fx.rate) : null)
    }
  const quoteById = new Map(quotes.map((q) => [q.id as string, q]))
  const now = today()
  const offers = new Map<
    string,
    Offer & { quantity: bigint; expired: boolean; row: any; quote: any }
  >()
  for (const x of qlines) {
    const q = quoteById.get(x.quote_id)!
    const rate = rates.get(q.currency) ?? null
    offers.set(x.id, {
      id: x.id,
      rfqLineId: x.rfq_line_id,
      supplierId: q.supplier_id,
      alternativeNo: Number(x.alternative_no),
      unitPriceBase: rate === null ? null : toBase6(q6(x.unit_price), rate),
      deliveryDays: x.delivery_days ?? q.delivery_days ?? null,
      paymentDays: q.payment_terms_days ?? null,
      quantity: q6(x.quantity),
      expired: (isoDate(q.valid_until) ?? '') < now,
      row: x,
      quote: q,
    })
  }
  const supplierIds = new Set(quotes.map((q) => q.supplier_id as string))
  const { quality, issues } = normalizeQuality(rawQuality, supplierIds)
  const scores = scoreOffers([...offers.values()], weights, quality)
  return { base, rateDate, lines, quotes, offers, rates, quality, qualityIssues: issues, scores }
}

type Data = Awaited<ReturnType<typeof compareData>>

function present(r: any, d: Data, weights: Weights) {
  const offersOf = (lineId: string) => [...d.offers.values()].filter((o) => o.rfqLineId === lineId)
  return {
    rfq: {
      id: r.id as string,
      number: r.number as string,
      title: r.title as string,
      status: r.status as string,
    },
    baseCurrency: d.base,
    rateDate: d.rateDate,
    rates: [...d.rates.entries()]
      .filter(([c]) => c !== d.base)
      .map(([currency, rate]) => ({ currency, rate: rate === null ? null : scaledText(rate, 10) })),
    weights,
    quality: Object.fromEntries(d.quality),
    suppliers: d.quotes.map((q) => {
      const rate = d.rates.get(q.currency) ?? null
      const mine = [...d.offers.values()].filter((o) => o.supplierId === q.supplier_id)
      const main = mine.filter((o) => o.alternativeNo === 0)
      return {
        supplier: { id: q.supplier_id as string, code: q.code as string, name: q.name as string },
        quoteId: q.id as string,
        quoteVersion: Number(q.quote_version),
        outdated: Number(q.rfq_revision) < Number(r.revision),
        currency: q.currency as string,
        rate: rate === null ? null : scaledText(rate, 10),
        validUntil: isoDate(q.valid_until),
        expired: (isoDate(q.valid_until) ?? '') < today(),
        deliveryDays: q.delivery_days ?? null,
        paymentTermsDays: q.payment_terms_days ?? null,
        quality: d.quality.get(q.supplier_id) ?? null,
        linesQuoted: new Set(main.map((o) => o.rfqLineId)).size,
        totalAmount: money(c2(q.total_amount)),
        totalBase:
          rate === null
            ? null
            : money(toBaseCents(c2(q.total_net), rate) + toBaseCents(c2(q.total_tax), rate)),
        bestLines: mine.filter((o) => d.scores.get(o.id)?.best).length,
      }
    }),
    lines: d.lines.map((l) => ({
      id: l.id as string,
      lineNo: Number(l.line_no),
      description: l.description as string,
      uom: (l.uom_code as string) ?? null,
      quantity: scaledText(q6(l.quantity), 6),
      offers: offersOf(l.id)
        .sort((a, b) => {
          const sa = d.scores.get(a.id)?.total ?? -1
          const sb = d.scores.get(b.id)?.total ?? -1
          return sb - sa || a.alternativeNo - b.alternativeNo
        })
        .map((o) => {
          const rate = d.rates.get(o.quote.currency) ?? null
          return {
            quoteLineId: o.id,
            quoteId: o.quote.id as string,
            supplier: { id: o.supplierId, code: o.quote.code as string },
            alternativeNo: o.alternativeNo,
            description: (o.row.description as string) ?? null,
            quantity: scaledText(o.quantity, 6),
            unitPrice: scaledText(q6(o.row.unit_price), 6),
            taxRate: scaledText(parseScaled(String(o.row.tax_rate), 3) ?? 0n, 3),
            currency: o.quote.currency as string,
            unitPriceBase: o.unitPriceBase === null ? null : scaledText(o.unitPriceBase, 6),
            totalBase:
              rate === null
                ? null
                : money(
                    toBaseCents(c2(o.row.net_amount), rate) +
                      toBaseCents(c2(o.row.tax_amount), rate)
                  ),
            deliveryDays: o.deliveryDays,
            expired: o.expired,
            score: d.scores.get(o.id) ?? null,
          }
        }),
    })),
  }
}

/** Linhas da adjudicação a gravar: valida e fotografa os valores na moeda de base. */
function buildLines(d: Data, raw: unknown) {
  const list = Array.isArray(raw) ? raw : []
  const issues: ErrorDetail[] = []
  const inputs: AwardLineInput[] = list.map((l: any, i: number) => {
    const q = parseScaled(l?.quantity, 6)
    if (q === null)
      issues.push({
        path: `lines.${i}.quantity`,
        code: 'INVALID',
        message: 'Quantidade em texto, até 6 casas.',
      })
    const reason = text(l?.reason) || null
    if (reason && reason.length > 500)
      issues.push({ path: `lines.${i}.reason`, code: 'LENGTH', message: 'Até 500 caracteres.' })
    return {
      quoteLineId: typeof l?.quoteLineId === 'string' ? l.quoteLineId : '',
      quantity: q ?? 0n,
      reason,
    }
  })
  const requested = new Map(d.lines.map((l) => [l.id as string, q6(l.quantity)]))
  issues.push(...awardLineIssues(inputs, d.offers, requested, d.scores))
  if (issues.length) return { issues, rows: [], net: 0n, total: 0n }
  let net = 0n
  let total = 0n
  const rows = inputs.map((l) => {
    const o = d.offers.get(l.quoteLineId)!
    const rate = d.rates.get(o.quote.currency)!
    const a = lineAmounts(
      l.quantity,
      q6(o.row.unit_price),
      parseScaled(String(o.row.tax_rate), 3) ?? 0n
    )
    const netBase = toBaseCents(a.net, rate)
    const totalBase = netBase + toBaseCents(a.tax, rate)
    net += netBase
    total += totalBase
    const s = d.scores.get(o.id)!
    return {
      rfqLineId: o.rfqLineId,
      quoteId: o.quote.id as string,
      quoteLineId: o.id,
      supplierId: o.supplierId,
      quantity: l.quantity,
      unitPrice: q6(o.row.unit_price),
      currency: o.quote.currency as string,
      rate,
      unitPriceBase: o.unitPriceBase!,
      netBase,
      totalBase,
      score: s.total,
      best: s.best,
      reason: l.reason,
    }
  })
  return { issues, rows, net, total }
}

async function writeAward(
  scope: TenantScope,
  awardId: string,
  d: Data,
  built: ReturnType<typeof buildLines>
) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  await scope.trx.rawQuery(`delete from rfq_award_lines where tenant_id = ? and award_id = ?`, [
    t,
    awardId,
  ])
  await scope.trx.rawQuery(`delete from rfq_award_scores where tenant_id = ? and award_id = ?`, [
    t,
    awardId,
  ])
  for (const [supplierId, score] of d.quality)
    await scope.trx.rawQuery(
      `insert into rfq_award_scores (tenant_id, award_id, supplier_id, quality_score, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?)`,
      [t, awardId, supplierId, score, u, u]
    )
  for (const l of built.rows)
    await scope.trx.rawQuery(
      `insert into rfq_award_lines (tenant_id, award_id, rfq_line_id, quote_id, quote_line_id, supplier_id, quantity,
          unit_price, currency, rate, unit_price_base, net_base, total_base, score, best, reason, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        awardId,
        l.rfqLineId,
        l.quoteId,
        l.quoteLineId,
        l.supplierId,
        scaledText(l.quantity, 6),
        scaledText(l.unitPrice, 6),
        l.currency,
        scaledText(l.rate, 10),
        scaledText(l.unitPriceBase, 6),
        money(l.netBase),
        money(l.totalBase),
        l.score.toFixed(2),
        l.best,
        l.reason,
        u,
        u,
      ] as never[]
    )
}

/** Valida o pedido de adjudicação (pesos, notas, linhas, justificação) contra a comparação actual. */
async function prepare(scope: TenantScope, r: any, input: Record<string, unknown>) {
  const { weights, issues } = normalizeWeights(input.weights)
  fail(issues)
  const d = await compareData(scope, r, weights, input.quality)
  const more = [...d.qualityIssues]
  if (weights.quality > 0)
    for (const q of d.quotes)
      if (!d.quality.has(q.supplier_id))
        more.push({
          path: `quality.${q.supplier_id}`,
          code: 'QUALITY_REQUIRED',
          message: `Dê a nota de qualidade de ${q.code} (o critério pesa ${weights.quality}%).`,
        })
  const justification = text(input.justification)
  if (justification.length < 10 || justification.length > 4000)
    more.push({
      path: 'justification',
      code: 'REQUIRED',
      message: 'Justifique a adjudicação (10 a 4000 caracteres).',
    })
  const built = buildLines(d, input.lines)
  fail([...more, ...built.issues])
  return { weights, d, built, justification }
}

async function awardRow(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const a = (
    await scope.trx.rawQuery(
      `select * from rfq_awards where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!a) throw ApiError.notFound()
  return a
}

async function setAward(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update rfq_awards set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function awardDetail(scope: TenantScope, id: string) {
  const a = await awardRow(scope, id)
  const r = await rfqRow(scope, a.rfq_id)
  const acc = await access(scope, r.legal_entity_id)
  if (!acc.read) throw ApiError.notFound()
  const t = scope.context.tenantId
  const lines = (
    await scope.trx.rawQuery(
      `select al.*, l.line_no, l.description as line_description, l.uom_code, ql.alternative_no,
          ql.description as offer_description, bp.code, bp.name
         from rfq_award_lines al join rfq_lines l on l.tenant_id = al.tenant_id and l.id = al.rfq_line_id
         join rfq_quote_lines ql on ql.tenant_id = al.tenant_id and ql.id = al.quote_line_id
         join suppliers s on s.tenant_id = al.tenant_id and s.id = al.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where al.tenant_id = ? and al.award_id = ? order by l.line_no, bp.code`,
      [t, id]
    )
  ).rows as any[]
  const scores = (
    await scope.trx.rawQuery(
      `select supplier_id, quality_score from rfq_award_scores where tenant_id = ? and award_id = ?`,
      [t, id]
    )
  ).rows as any[]
  const users = (
    await scope.trx.rawQuery(`select id, full_name from users where id = any(?::uuid[])`, [
      [a.submitted_by, a.decided_by, a.created_by].filter(Boolean),
    ] as never[])
  ).rows as any[]
  const name = (u: string | null) => users.find((x) => x.id === u)?.full_name ?? null
  const status = a.status as AwardStatus
  const weights: Weights = {
    price: Number(a.price_weight),
    delivery: Number(a.delivery_weight),
    quality: Number(a.quality_weight),
    payment: Number(a.payment_weight),
  }
  const quality = Object.fromEntries(scores.map((s) => [s.supplier_id, Number(s.quality_score)]))
  const bySupplier = new Map<
    string,
    { supplier: any; netBase: bigint; totalBase: bigint; lines: number }
  >()
  for (const l of lines) {
    const k = l.supplier_id as string
    const cur = bySupplier.get(k) ?? {
      supplier: { id: k, code: l.code, name: l.name },
      netBase: 0n,
      totalBase: 0n,
      lines: 0,
    }
    cur.netBase += c2(l.net_base)
    cur.totalBase += c2(l.total_base)
    cur.lines += 1
    bySupplier.set(k, cur)
  }
  const blocked =
    status === 'PENDING_APPROVAL' ? decideBlockedBy(a.submitted_by, scope.context.userId) : null
  return {
    id: a.id as string,
    version: Number(a.version),
    status,
    rfq: {
      id: r.id as string,
      number: r.number as string,
      title: r.title as string,
      status: r.status as string,
    },
    weights,
    quality,
    baseCurrency: a.base_currency as string,
    rateDate: isoDate(a.rate_date),
    justification: a.justification as string,
    totalNetBase: money(c2(a.total_net_base)),
    totalBase: money(c2(a.total_base)),
    createdBy: name(a.created_by),
    submittedAt: a.submitted_at ? new Date(a.submitted_at).toISOString() : null,
    submittedBy: name(a.submitted_by),
    decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null,
    decidedBy: name(a.decided_by),
    decisionReason: (a.decision_reason as string) ?? null,
    cancelReason: (a.cancel_reason as string) ?? null,
    lines: lines.map((l) => ({
      id: l.id as string,
      rfqLineId: l.rfq_line_id as string,
      lineNo: Number(l.line_no),
      description: l.line_description as string,
      uom: (l.uom_code as string) ?? null,
      quoteId: l.quote_id as string,
      quoteLineId: l.quote_line_id as string,
      supplier: { id: l.supplier_id as string, code: l.code as string, name: l.name as string },
      alternativeNo: Number(l.alternative_no),
      offerDescription: (l.offer_description as string) ?? null,
      quantity: scaledText(q6(l.quantity), 6),
      unitPrice: scaledText(q6(l.unit_price), 6),
      currency: l.currency as string,
      rate: scaledText(r10(l.rate), 10),
      unitPriceBase: scaledText(q6(l.unit_price_base), 6),
      netBase: money(c2(l.net_base)),
      totalBase: money(c2(l.total_base)),
      score: Number(l.score),
      best: l.best as boolean,
      reason: (l.reason as string) ?? null,
    })),
    bySupplier: [...bySupplier.values()].map((s) => ({
      supplier: s.supplier,
      lines: s.lines,
      netBase: money(s.netBase),
      totalBase: money(s.totalBase),
    })),
    can: {
      edit: acc.manage && status === 'DRAFT' && r.status === 'CLOSED',
      submit: acc.manage && status === 'DRAFT' && r.status === 'CLOSED',
      decide: acc.approve && status === 'PENDING_APPROVAL' && !blocked,
      decideBlockedBy: acc.approve ? blocked : null,
      cancel: acc.manage && (status === 'DRAFT' || status === 'PENDING_APPROVAL'),
    },
  }
}

export type AwardDetail = Awaited<ReturnType<typeof awardDetail>>

const reasonOf = (v: unknown) => {
  const r = text(v)
  if (!r) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}
const versionCheck = (a: any, expected: unknown) => {
  if (Number(a.version) !== Number(expected)) throw ApiError.versionConflict(Number(a.version))
}

export class RfqAwardService {
  /** Mapa comparativo (sem gravar) com os pesos e notas indicados; pedido fechado ou adjudicado. */
  compare(context: TenantContext, rfqId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const r = await rfqRow(scope, rfqId)
      if (!(await access(scope, r.legal_entity_id)).read) throw ApiError.notFound()
      if (!['CLOSED', 'AWARDED'].includes(r.status))
        throw ApiError.conflict(
          'INVALID_STATE',
          'A comparação só existe depois de abertas as propostas.'
        )
      const { weights, issues } = normalizeWeights(input.weights)
      fail(issues)
      const d = await compareData(scope, r, weights, input.quality)
      fail(d.qualityIssues)
      return present(r, d, weights)
    })
  }

  create(context: TenantContext, rfqId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const r = await rfqRow(scope, rfqId, true)
      const acc = await access(scope, r.legal_entity_id)
      if (!acc.read) throw ApiError.notFound()
      if (!acc.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação desta entidade.')
      if (r.status !== 'CLOSED')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se adjudica um pedido com as propostas abertas.'
        )
      const live = await scope.trx.rawQuery(
        `select id from rfq_awards where tenant_id = ? and rfq_id = ? and status in ('DRAFT','PENDING_APPROVAL','APPROVED')`,
        [context.tenantId, rfqId]
      )
      if (live.rows.length)
        throw new ApiError(409, 'AWARD_EXISTS', 'Já há uma adjudicação para este pedido.', [
          { path: 'awardId', code: 'AWARD_EXISTS', message: (live.rows[0] as any).id },
        ])
      const p = await prepare(scope, r, input)
      const ins = await scope.trx.rawQuery(
        `insert into rfq_awards (tenant_id, rfq_id, price_weight, delivery_weight, quality_weight, payment_weight,
            base_currency, rate_date, justification, total_net_base, total_base, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          rfqId,
          p.weights.price,
          p.weights.delivery,
          p.weights.quality,
          p.weights.payment,
          p.d.base,
          p.d.rateDate,
          p.justification,
          money(p.built.net),
          money(p.built.total),
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await writeAward(scope, id, p.d, p.built)
      await rfqEvent(scope, rfqId, 'AWARD_DRAFTED', { details: { awardId: id } })
      await audit(scope, {
        action: 'rfq_award.created',
        entityType: 'rfq_award',
        entityId: id,
        changes: { totalBase: { from: null, to: money(p.built.total) } },
      })
      return awardDetail(scope, id)
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => awardDetail(scope, id))
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await awardRow(scope, id, true)
      const r = await rfqRow(scope, a.rfq_id, true)
      const acc = await access(scope, r.legal_entity_id)
      if (!acc.read) throw ApiError.notFound()
      if (!acc.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação desta entidade.')
      versionCheck(a, input.expectedVersion)
      if (a.status !== 'DRAFT') throw ApiError.conflict('INVALID_STATE', 'Só o rascunho se altera.')
      const p = await prepare(scope, r, input)
      await writeAward(scope, id, p.d, p.built)
      await setAward(scope, id, {
        price_weight: p.weights.price,
        delivery_weight: p.weights.delivery,
        quality_weight: p.weights.quality,
        payment_weight: p.weights.payment,
        justification: p.justification,
        total_net_base: money(p.built.net),
        total_base: money(p.built.total),
      })
      await audit(scope, {
        action: 'rfq_award.updated',
        entityType: 'rfq_award',
        entityId: id,
        changes: { totalBase: { from: money(c2(a.total_base)), to: money(p.built.total) } },
      })
      return awardDetail(scope, id)
    })
  }

  /** Submeter: refaz a comparação (validade das propostas, câmbios) e fixa a fotografia gravada. */
  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await awardRow(scope, id, true)
      const r = await rfqRow(scope, a.rfq_id, true)
      const acc = await access(scope, r.legal_entity_id)
      if (!acc.read) throw ApiError.notFound()
      if (!acc.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação desta entidade.')
      versionCheck(a, input.expectedVersion)
      if (a.status !== 'DRAFT' || r.status !== 'CLOSED')
        throw ApiError.conflict('INVALID_STATE', 'Só um rascunho de um pedido fechado se submete.')
      const t = context.tenantId
      const scores = (
        await scope.trx.rawQuery(
          `select supplier_id, quality_score from rfq_award_scores where tenant_id = ? and award_id = ?`,
          [t, id]
        )
      ).rows as any[]
      const lines = (
        await scope.trx.rawQuery(
          `select quote_line_id, quantity, reason from rfq_award_lines where tenant_id = ? and award_id = ?`,
          [t, id]
        )
      ).rows as any[]
      const p = await prepare(scope, r, {
        weights: {
          price: a.price_weight,
          delivery: a.delivery_weight,
          quality: a.quality_weight,
          payment: a.payment_weight,
        },
        quality: Object.fromEntries(scores.map((s) => [s.supplier_id, Number(s.quality_score)])),
        justification: a.justification,
        lines: lines.map((l) => ({
          quoteLineId: l.quote_line_id,
          quantity: scaledText(q6(l.quantity), 6),
          reason: l.reason,
        })),
      })
      await writeAward(scope, id, p.d, p.built)
      await setAward(scope, id, {
        status: 'PENDING_APPROVAL',
        total_net_base: money(p.built.net),
        total_base: money(p.built.total),
        submitted_at: new Date(),
        submitted_by: context.userId,
      })
      await rfqEvent(scope, r.id, 'AWARD_SUBMITTED', {
        details: { awardId: id, totalBase: money(p.built.total), currency: p.d.base },
      })
      await audit(scope, {
        action: 'rfq_award.submitted',
        entityType: 'rfq_award',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'PENDING_APPROVAL' } },
      })
      return awardDetail(scope, id)
    })
  }

  /** Decidir: outra pessoa com `.approve` na entidade; aprovar exige as propostas ainda válidas. */
  decide(
    context: TenantContext,
    id: string,
    decision: 'approve' | 'reject',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const a = await awardRow(scope, id, true)
      const r = await rfqRow(scope, a.rfq_id, true)
      const acc = await access(scope, r.legal_entity_id)
      if (!acc.read) throw ApiError.notFound()
      if (!acc.approve)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova adjudicações desta entidade.')
      versionCheck(a, input.expectedVersion)
      if (a.status !== 'PENDING_APPROVAL')
        throw ApiError.conflict('INVALID_STATE', 'A adjudicação não está em aprovação.')
      if (decideBlockedBy(a.submitted_by, context.userId))
        throw ApiError.forbidden('SELF_APPROVAL', 'Submeteu esta adjudicação: não a pode decidir.')
      const reason = decision === 'reject' ? reasonOf(input.reason) : text(input.reason) || null
      if (decision === 'approve') {
        const expired = await scope.trx.rawQuery(
          `select distinct bp.code from rfq_award_lines al join rfq_quotes q on q.tenant_id = al.tenant_id and q.id = al.quote_id
             join suppliers s on s.tenant_id = q.tenant_id and s.id = q.supplier_id
             join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
            where al.tenant_id = ? and al.award_id = ? and (q.valid_until < ?::date or q.status <> 'ACTIVE')`,
          [context.tenantId, id, today()]
        )
        if (expired.rows.length)
          throw ApiError.conflict(
            'QUOTE_EXPIRED',
            `Proposta já não válida: ${(expired.rows as any[]).map((x) => x.code).join(', ')}. Recuse e prepare outra.`
          )
      }
      const to = decision === 'approve' ? 'APPROVED' : 'REJECTED'
      await setAward(scope, id, {
        status: to,
        decided_at: new Date(),
        decided_by: context.userId,
        decision_reason: reason,
      })
      if (decision === 'approve')
        await scope.trx.rawQuery(
          `update rfqs set status = 'AWARDED', updated_by = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ?`,
          [context.userId, context.tenantId, r.id]
        )
      await rfqEvent(scope, r.id, decision === 'approve' ? 'AWARDED' : 'AWARD_REJECTED', {
        reason,
        details: { awardId: id, totalBase: money(c2(a.total_base)), currency: a.base_currency },
      })
      await audit(scope, {
        action: decision === 'approve' ? 'rfq_award.approved' : 'rfq_award.rejected',
        entityType: 'rfq_award',
        entityId: id,
        changes: { status: { from: 'PENDING_APPROVAL', to } },
      })
      return awardDetail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await awardRow(scope, id, true)
      const r = await rfqRow(scope, a.rfq_id, true)
      const acc = await access(scope, r.legal_entity_id)
      if (!acc.read) throw ApiError.notFound()
      if (!acc.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere pedidos de cotação desta entidade.')
      versionCheck(a, input.expectedVersion)
      if (!['DRAFT', 'PENDING_APPROVAL'].includes(a.status))
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se anula uma adjudicação em rascunho ou em aprovação.'
        )
      const reason = reasonOf(input.reason)
      await setAward(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await rfqEvent(scope, r.id, 'AWARD_CANCELLED', { reason, details: { awardId: id } })
      await audit(scope, {
        action: 'rfq_award.cancelled',
        entityType: 'rfq_award',
        entityId: id,
        changes: { status: { from: a.status, to: 'CANCELLED' } },
      })
      return awardDetail(scope, id)
    })
  }
}
