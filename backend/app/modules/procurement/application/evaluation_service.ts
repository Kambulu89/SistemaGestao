import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { parseScaled } from '#modules/procurement/domain/requisitions'
import {
  combine,
  complianceIndicator,
  costIndicator,
  CRITERIA,
  DEFAULT_WEIGHTS,
  deliveryIndicator,
  type Indicators,
  normalizePeriod,
  normalizeWeights,
  qualityIndicator,
  type Rating,
  scoreText,
  slaMet,
  type Weights,
} from '#modules/procurement/domain/evaluations'

/*
 * Avaliação de fornecedores (9.11). `procurement.evaluations.read` vê o mapa e as provas das entidades do âmbito;
 * `procurement.evaluations.manage` no âmbito da empresa publica avaliações (com as provas de todas as entidades — o
 * fornecedor é da empresa). Os pesos são da empresa (`procurement.settings`). As provas calculam-se na hora das
 * recepções, devoluções, facturas e propostas; publicar guarda a fotografia (imutável na base).
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const today = () => new Date().toISOString().slice(0, 10)

type Les = 'ALL' | string[]
async function scopes(scope: TenantScope) {
  return {
    read: await permissionScope(scope, 'procurement.evaluations.read'),
    manage: await permissionScope(scope, 'procurement.evaluations.manage'),
  }
}
const lesOf = (...ss: PermissionScope[]): Les =>
  ss.some((s) => s.tenant) ? 'ALL' : [...new Set(ss.flatMap((s) => [...s.legalEntityIds]))]
/** Filtro SQL por entidade legal (coluna dada). */
const leFilter = (les: Les, col: string) => (les === 'ALL' ? '' : ` and ${col} = any(?::uuid[])`)
const leParams = (les: Les) => (les === 'ALL' ? [] : [les])

export async function weightsOf(scope: TenantScope): Promise<Weights> {
  const r = (
    await scope.trx.rawQuery(`select * from supplier_evaluation_settings where tenant_id = ?`, [
      scope.context.tenantId,
    ])
  ).rows[0] as any
  return r
    ? {
        quality: Number(r.quality_weight),
        delivery: Number(r.delivery_weight),
        compliance: Number(r.compliance_weight),
        cost: Number(r.cost_weight),
      }
    : { ...DEFAULT_WEIGHTS }
}

interface Facts {
  receiptLines: any[]
  invoices: any[]
  quoteLines: any[]
}

/** Provas do período por fornecedor (`supplierId` nulo = todos), nas entidades indicadas. */
async function facts(
  scope: TenantScope,
  period: { from: string; to: string },
  les: Les,
  supplierId: string | null
): Promise<Facts> {
  const t = scope.context.tenantId
  const sup = (col: string) => (supplierId ? ` and ${col} = ?` : '')
  const supP = supplierId ? [supplierId] : []
  const receiptLines = (
    await scope.trx.rawQuery(
      `select r.supplier_id, r.id as receipt_id, r.number as receipt_number, r.receipt_date::text as received,
          coalesce(ol.expected_date, o.expected_date)::text as expected, o.id as order_id, o.number as order_number,
          o.contract_id, o.issued_at::date::text as issued, rl.id, rl.quantity, rl.rejected_quantity, ol.quantity as ordered,
          ol.cancelled_quantity,
          coalesce((select sum(x.quantity) from purchase_return_lines x join purchase_returns pr
              on pr.tenant_id = x.tenant_id and pr.id = x.return_id
            where x.tenant_id = rl.tenant_id and x.receipt_line_id = rl.id and x.source = 'ACCEPTED'
              and pr.status = 'CONFIRMED'), 0)::text as returned
         from purchase_receipt_lines rl
         join purchase_receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id
         join purchase_order_lines ol on ol.tenant_id = rl.tenant_id and ol.id = rl.order_line_id
         join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
        where rl.tenant_id = ? and r.status = 'CONFIRMED' and r.receipt_date between ?::date and ?::date
          ${leFilter(les, 'r.legal_entity_id')}${sup('r.supplier_id')}
        order by r.receipt_date, r.number, rl.line_no`,
      [t, period.from, period.to, ...leParams(les), ...supP] as never[]
    )
  ).rows as any[]
  const invoices = (
    await scope.trx.rawQuery(
      `select i.supplier_id, i.id, i.number, i.invoice_number, i.status, i.invoice_date::text as date,
          exists (select 1 from purchase_invoice_exceptions x where x.tenant_id = i.tenant_id and x.invoice_id = i.id
            and x.decision = 'APPROVE') as excepted
         from purchase_invoices i
        where i.tenant_id = ? and i.status in ('VALIDATED','REJECTED') and i.invoice_date between ?::date and ?::date
          ${leFilter(les, 'i.legal_entity_id')}${sup('i.supplier_id')}
        order by i.invoice_date, i.invoice_number`,
      [t, period.from, period.to, ...leParams(les), ...supP] as never[]
    )
  ).rows as any[]
  const quoteLines = (
    await scope.trx.rawQuery(
      `select q.supplier_id, f.id as rfq_id, f.number as rfq_number, ql.rfq_line_id, ql.unit_price, q.currency,
          (select min(ql2.unit_price) from rfq_quote_lines ql2 join rfq_quotes q2 on q2.tenant_id = ql2.tenant_id
              and q2.id = ql2.quote_id
            where ql2.tenant_id = ql.tenant_id and ql2.rfq_line_id = ql.rfq_line_id and ql2.alternative_no = 0
              and q2.status = 'ACTIVE' and q2.currency = q.currency)::text as best
         from rfq_quote_lines ql join rfq_quotes q on q.tenant_id = ql.tenant_id and q.id = ql.quote_id
         join rfqs f on f.tenant_id = q.tenant_id and f.id = q.rfq_id
        where ql.tenant_id = ? and q.status = 'ACTIVE' and ql.alternative_no = 0 and f.opened_at is not null
          and f.opened_at::date between ?::date and ?::date
          ${leFilter(les, 'f.legal_entity_id')}${sup('q.supplier_id')}`,
      [t, period.from, period.to, ...leParams(les), ...supP] as never[]
    )
  ).rows as any[]
  return { receiptLines, invoices, quoteLines }
}

function indicatorsOf(f: Facts, supplierId: string): Indicators {
  const rl = f.receiptLines.filter((x) => x.supplier_id === supplierId)
  return {
    quality: qualityIndicator(
      rl.map((x) => ({
        accepted: q6(x.quantity),
        rejected: q6(x.rejected_quantity),
        returned: q6(x.returned),
      }))
    ),
    delivery: deliveryIndicator(
      rl.map((x) => ({ received: x.received, expected: x.expected ?? null }))
    ),
    compliance: complianceIndicator(
      f.invoices
        .filter((x) => x.supplier_id === supplierId)
        .map((x) => ({ clean: x.status === 'VALIDATED' && !x.excepted }))
    ),
    cost: costIndicator(
      f.quoteLines
        .filter((x) => x.supplier_id === supplierId)
        .map((x) => ({ own: q6(x.unit_price), best: q6(x.best) }))
    ),
  }
}

const indicatorView = (ind: Indicators) =>
  Object.fromEntries(
    CRITERIA.map((c) => [c, { score: scoreText(ind[c].score), evidence: ind[c].evidence }])
  ) as Record<string, { score: string | null; evidence: number }>

async function suppliersInfo(scope: TenantScope, ids: string[]) {
  if (!ids.length) return new Map<string, any>()
  const rows = (
    await scope.trx.rawQuery(
      `select s.id, bp.code, bp.name, s.status,
          (select row_to_json(e) from (select ev.id, ev.rating, ev.score::text as score, ev.period_to::text as "periodTo"
              from supplier_evaluations ev where ev.tenant_id = s.tenant_id and ev.supplier_id = s.id
                and ev.superseded_by_id is null order by ev.period_to desc, ev.created_at desc limit 1) e) as latest
         from suppliers s join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where s.tenant_id = ? and s.id = any(?::uuid[])`,
      [scope.context.tenantId, ids] as never[]
    )
  ).rows as any[]
  return new Map(rows.map((r) => [r.id as string, r]))
}

/** SLA dos contratos do fornecedor medidos no período (só as métricas mensuráveis). */
async function slaOutcomes(scope: TenantScope, f: Facts, supplierId: string) {
  const rows = (
    await scope.trx.rawQuery(
      `select c.id, c.number, c.title, s.line_no, s.metric, s.target::text as target, s.description
         from purchase_contract_slas s join purchase_contracts c on c.tenant_id = s.tenant_id and c.id = s.contract_id
        where s.tenant_id = ? and c.supplier_id = ? and c.number is not null order by c.number, s.line_no`,
      [scope.context.tenantId, supplierId]
    )
  ).rows as any[]
  return rows.map((s) => {
    const lines = f.receiptLines.filter(
      (x) => x.supplier_id === supplierId && x.contract_id === s.id
    )
    let actual: number | null = null
    if (s.metric === 'DELIVERY_DAYS') {
      const days = lines
        .filter((x) => x.issued)
        .map((x) => (new Date(x.received).getTime() - new Date(x.issued).getTime()) / 86_400_000)
      actual = days.length
        ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10
        : null
    } else if (s.metric === 'FILL_RATE') {
      const rates = lines
        .filter((x) => q6(x.ordered) - q6(x.cancelled_quantity) > 0n)
        .map(
          (x) =>
            Number((q6(x.quantity) * 10_000n) / (q6(x.ordered) - q6(x.cancelled_quantity))) / 100
        )
      actual = rates.length
        ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) / 100
        : null
    } else if (s.metric === 'QUALITY_RATE') {
      const q = qualityIndicator(
        lines.map((x) => ({
          accepted: q6(x.quantity),
          rejected: q6(x.rejected_quantity),
          returned: q6(x.returned),
        }))
      )
      actual = q.score === null ? null : q.score / 100
    }
    const target = Number(s.target)
    return {
      contract: { id: s.id as string, number: s.number as string, title: s.title as string },
      metric: s.metric as string,
      description: (s.description as string) ?? null,
      target: s.target as string,
      actual: actual === null ? null : String(actual),
      evidence: lines.length,
      met: slaMet(s.metric, target, actual),
    }
  })
}

async function publishedView(scope: TenantScope, id: string) {
  const e = (
    await scope.trx.rawQuery(
      `select e.*, e.period_from::text as pf, e.period_to::text as pt, u.full_name, bp.code as sup_code, bp.name as sup_name
         from supplier_evaluations e join suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         left join users u on u.id = e.created_by where e.tenant_id = ? and e.id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!e) throw ApiError.notFound()
  return {
    id: e.id as string,
    supplier: {
      id: e.supplier_id as string,
      code: e.sup_code as string,
      name: e.sup_name as string,
    },
    periodFrom: e.pf as string,
    periodTo: e.pt as string,
    weights: e.weights as Weights,
    indicators: e.indicators as Record<string, { score: string | null; evidence: number }>,
    score: e.score === null ? null : String(e.score),
    rating: (e.rating as Rating) ?? null,
    comment: (e.comment as string) ?? null,
    superseded: !!e.superseded_by_id,
    publishedAt: new Date(e.created_at).toISOString(),
    publishedBy: (e.full_name as string) ?? null,
  }
}

export class EvaluationService {
  /** Mapa do período: fornecedores com provas, indicadores, nota e classe, e a última avaliação publicada. */
  ranking(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { period, issues } = normalizePeriod(input, today())
      fail(issues)
      const s = await scopes(scope)
      const les = lesOf(s.read, s.manage)
      if (les !== 'ALL' && !les.length)
        return { period, weights: await weightsOf(scope), items: [], summary: {} }
      const f = await facts(scope, period, les, null)
      const ids = [
        ...new Set([
          ...f.receiptLines.map((x) => x.supplier_id as string),
          ...f.invoices.map((x) => x.supplier_id as string),
          ...f.quoteLines.map((x) => x.supplier_id as string),
        ]),
      ]
      const weights = await weightsOf(scope)
      const info = await suppliersInfo(scope, ids)
      const scored = ids.map((id) => {
        const ind = indicatorsOf(f, id)
        return { id, ind, c: combine(weights, ind) }
      })
      scored.sort(
        (a, b) =>
          (b.c.score ?? -1) - (a.c.score ?? -1) ||
          String(info.get(a.id)?.code).localeCompare(String(info.get(b.id)?.code))
      )
      const items = scored.map(({ id, ind, c }) => {
        const sp = info.get(id)
        return {
          supplier: { id, code: sp?.code as string, name: sp?.name as string },
          indicators: indicatorView(ind),
          score: scoreText(c.score),
          rating: c.rating,
          latest: sp?.latest ?? null,
        }
      })
      const summary = { A: 0, B: 0, C: 0, D: 0, none: 0 } as Record<string, number>
      for (const x of items) summary[x.rating ?? 'none']++
      return { period, weights, items, summary }
    })
  }

  /** Provas de um fornecedor no período, SLA dos contratos e histórico de avaliações publicadas. */
  supplier(context: TenantContext, supplierId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(supplierId)) throw ApiError.notFound()
      const info = (await suppliersInfo(scope, [supplierId])).get(supplierId)
      if (!info) throw ApiError.notFound()
      const s = await scopes(scope)
      const les = lesOf(s.read, s.manage)
      if (les !== 'ALL' && !les.length) throw ApiError.notFound()
      const { period, issues } = normalizePeriod(input, today())
      fail(issues)
      const f = await facts(scope, period, les, supplierId)
      const weights = await weightsOf(scope)
      const ind = indicatorsOf(f, supplierId)
      const c = combine(weights, ind)
      const history = (
        await scope.trx.rawQuery(
          `select id from supplier_evaluations where tenant_id = ? and supplier_id = ? order by period_to desc, created_at desc`,
          [context.tenantId, supplierId]
        )
      ).rows as any[]
      const receipts = new Map<string, any>()
      for (const x of f.receiptLines) {
        const r = receipts.get(x.receipt_id) ?? {
          id: x.receipt_id as string,
          number: x.receipt_number as string,
          order: { id: x.order_id as string, number: x.order_number as string },
          receivedOn: x.received as string,
          expectedOn: (x.expected as string) ?? null,
          lines: 0,
          rejectedLines: 0,
          returnedLines: 0,
          late: false,
        }
        r.lines++
        if (q6(x.rejected_quantity) > 0n) r.rejectedLines++
        if (q6(x.returned) > 0n) r.returnedLines++
        if (x.expected && x.received > x.expected) r.late = true
        receipts.set(x.receipt_id, r)
      }
      const rfqs = new Map<string, any>()
      for (const x of f.quoteLines) {
        const r = rfqs.get(x.rfq_id) ?? {
          id: x.rfq_id as string,
          number: x.rfq_number as string,
          lines: 0,
          cheapest: 0,
        }
        r.lines++
        if (q6(x.unit_price) <= q6(x.best)) r.cheapest++
        rfqs.set(x.rfq_id, r)
      }
      return {
        supplier: { id: supplierId, code: info.code as string, name: info.name as string },
        period,
        weights,
        scopeAll: les === 'ALL',
        indicators: indicatorView(ind),
        score: scoreText(c.score),
        rating: c.rating,
        evidence: {
          receipts: [...receipts.values()],
          invoices: f.invoices.map((x) => ({
            id: x.id as string,
            number: x.number as string | null,
            invoiceNumber: x.invoice_number as string,
            date: x.date as string,
            status: x.status as string,
            excepted: !!x.excepted,
          })),
          rfqs: [...rfqs.values()],
        },
        sla: await slaOutcomes(scope, f, supplierId),
        history: await Promise.all(history.map((h) => publishedView(scope, h.id))),
        can: { publish: s.manage.tenant },
      }
    })
  }

  /** Publicar: recalcula com as provas de toda a empresa e guarda a fotografia (substitui a do mesmo período). */
  publish(context: TenantContext, supplierId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(supplierId)) throw ApiError.notFound()
      const info = (await suppliersInfo(scope, [supplierId])).get(supplierId)
      if (!info) throw ApiError.notFound()
      const s = await scopes(scope)
      if (!s.manage.tenant)
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Publicar avaliações exige a permissão no âmbito da empresa (o fornecedor é da empresa toda).'
        )
      const { period, issues } = normalizePeriod(input, today())
      const comment =
        typeof input.comment === 'string' && input.comment.trim() ? input.comment.trim() : null
      if (comment && comment.length > 2000)
        issues.push({ path: 'comment', code: 'LENGTH', message: 'Até 2000 caracteres.' })
      fail(issues)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `supplier-evaluation:${context.tenantId}:${supplierId}`,
      ])
      const f = await facts(scope, period, 'ALL', supplierId)
      const weights = await weightsOf(scope)
      const ind = indicatorsOf(f, supplierId)
      if (CRITERIA.every((c) => ind[c].evidence === 0))
        throw ApiError.conflict('NO_EVIDENCE', 'Sem provas neste período: não há o que avaliar.')
      const c = combine(weights, ind)
      const prev = (
        await scope.trx.rawQuery(
          `select id from supplier_evaluations where tenant_id = ? and supplier_id = ? and period_from = ? and period_to = ?
              and superseded_by_id is null for update`,
          [context.tenantId, supplierId, period.from, period.to]
        )
      ).rows[0] as { id: string } | undefined
      // A anterior do mesmo período fica no histórico, marcada como substituída pela nova.
      const id = (
        (await scope.trx.rawQuery('select gen_random_uuid() as id')).rows[0] as { id: string }
      ).id
      if (prev)
        await scope.trx.rawQuery(
          `update supplier_evaluations set superseded_by_id = ?, updated_by = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ?`,
          [id, context.userId, context.tenantId, prev.id]
        )
      await scope.trx.rawQuery(
        `insert into supplier_evaluations (id, tenant_id, supplier_id, period_from, period_to, weights, indicators, score,
            rating, comment, created_by, updated_by) values (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?)`,
        [
          id,
          context.tenantId,
          supplierId,
          period.from,
          period.to,
          JSON.stringify(weights),
          JSON.stringify(indicatorView(ind)),
          scoreText(c.score),
          c.rating,
          comment,
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'supplier_evaluation.published',
        entityType: 'supplier',
        entityId: supplierId,
        changes: {
          rating: { from: null, to: c.rating },
          score: { from: null, to: scoreText(c.score) },
        },
        metadata: {
          evaluationId: id,
          from: period.from,
          to: period.to,
          replaced: prev?.id ?? null,
        },
      })
      return publishedView(scope, id)
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      const s = await scopes(scope)
      const les = lesOf(s.read, s.manage)
      if (les !== 'ALL' && !les.length) throw ApiError.notFound()
      return publishedView(scope, id)
    })
  }

  weights(context: TenantContext) {
    return runInTenant(context, (scope) => weightsOf(scope))
  }

  setWeights(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { weights, issues } = normalizeWeights(input)
      fail(issues)
      const before = await weightsOf(scope)
      await scope.trx.rawQuery(
        `insert into supplier_evaluation_settings (tenant_id, quality_weight, delivery_weight, compliance_weight, cost_weight,
            created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?)
         on conflict (tenant_id) do update set quality_weight = excluded.quality_weight,
           delivery_weight = excluded.delivery_weight, compliance_weight = excluded.compliance_weight,
           cost_weight = excluded.cost_weight, updated_by = excluded.updated_by, updated_at = now(),
           version = supplier_evaluation_settings.version + 1`,
        [
          context.tenantId,
          weights.quality,
          weights.delivery,
          weights.compliance,
          weights.cost,
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'supplier_evaluation.weights_updated',
        entityType: 'supplier_evaluation_settings',
        entityId: context.tenantId,
        changes: { weights: { from: before, to: weights } },
      })
      return weights
    })
  }
}

/** Última avaliação publicada em vigor de um fornecedor (para a ficha do fornecedor e a adjudicação). */
export async function latestEvaluation(scope: TenantScope, supplierId: string) {
  return ((await suppliersInfo(scope, [supplierId])).get(supplierId)?.latest ?? null) as {
    id: string
    rating: Rating | null
    score: string | null
    periodTo: string
  } | null
}
