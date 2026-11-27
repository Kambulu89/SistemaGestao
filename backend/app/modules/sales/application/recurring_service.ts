import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { createRecurringDraft } from '#modules/sales/application/invoice_service'
import { searchSalesRefs } from '#modules/sales/application/pricing_service'
import { dbScaled, PRICE_SCALE, QTY_SCALE, scaledText } from '#modules/sales/domain/pricing'
import {
  CONTRACT_STATUSES,
  effectiveVersion,
  type Frequency,
  MAX_PERIODS_PER_RUN,
  normalizeContract,
  normalizeVersion,
  period,
  priceText,
  qtyText,
  type VersionLineInput,
  withinContract,
} from '#modules/sales/domain/recurring'

/*
 * Facturação recorrente (10.11). Permissões no âmbito da entidade legal: `sales.recurring.read`, `.manage` (contratos,
 * versões em rascunho, activar/suspender/terminar, gerar) e `.approve` (aprovar versões; nunca quem as preparou). A
 * geração cria RASCUNHOS de factura, um por período e só quando a data da factura chegou, cada período na sua
 * transacção e com o contrato bloqueado — nunca duplica e nunca emite: a emissão é de uma pessoa com
 * `sales.invoices.issue`.
 */

const today = () => new Date().toISOString().slice(0, 10)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
type Need = 'read' | 'manage' | 'approve'
async function scopesOf(scope: TenantScope): Promise<Record<Need, PermissionScope>> {
  return {
    read: await permissionScope(scope, 'sales.recurring.read'),
    manage: await permissionScope(scope, 'sales.recurring.manage'),
    approve: await permissionScope(scope, 'sales.recurring.approve'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
function rights(s: Record<Need, PermissionScope>, le: string) {
  const manage = covers(s.manage, le)
  const approve = covers(s.approve, le)
  return { read: manage || approve || covers(s.read, le), manage, approve }
}
const DENY: Record<Need, string> = {
  read: 'Não consulta contratos recorrentes desta entidade.',
  manage: 'Não gere contratos recorrentes desta entidade.',
  approve: 'Não aprova versões de contratos desta entidade.',
}
const reasonOf = (v: unknown) => {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3 || r.length > 500)
    fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' }])
  return r
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const c = (
    await scope.trx.rawQuery(
      `select *, start_date::text as sd, end_date::text as ed from sales_recurring_contracts where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) throw ApiError.notFound()
  return c
}
async function authorized(scope: TenantScope, id: string, need: Need, lock = false) {
  const c = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), c.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (!g[need]) throw ApiError.forbidden('OUT_OF_SCOPE', DENY[need])
  return { c, g }
}
const versionCheck = (r: any, expected: unknown) => {
  if (Number(r.version) !== Number(expected)) throw ApiError.versionConflict(Number(r.version))
}
async function setContract(scope: TenantScope, id: string, f: Record<string, unknown>) {
  const cols = Object.keys(f)
  await scope.trx.rawQuery(
    `update sales_recurring_contracts set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(),
       updated_by = ? where tenant_id = ? and id = ?`,
    [...cols.map((c) => f[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function versionsOf(scope: TenantScope, contractId: string) {
  return (
    (
      await scope.trx.rawQuery(
        `select v.*, v.valid_from::text as vf, cu.full_name as creator, au.full_name as approver
           from sales_recurring_versions v left join users cu on cu.id = v.created_by left join users au on au.id = v.approved_by
          where v.tenant_id = ? and v.contract_id = ? order by v.version_no`,
        [scope.context.tenantId, contractId]
      )
    ).rows as any[]
  ).map((v) => ({ ...v, validFrom: v.vf as string, status: v.status as string }))
}

async function linesOf(scope: TenantScope, versionId: string) {
  return (
    await scope.trx.rawQuery(
      `select l.*, p.sku, p.name from sales_recurring_version_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
        where l.tenant_id = ? and l.version_id = ? order by l.line_no`,
      [scope.context.tenantId, versionId]
    )
  ).rows as any[]
}

async function detail(scope: TenantScope, id: string, g?: ReturnType<typeof rights>) {
  const t = scope.context.tenantId
  const c = (
    await scope.trx.rawQuery(
      `select c.*, c.start_date::text as sd, c.end_date::text as ed, le.code as le_code, bp.code as cus_code, bp.name as cus_name,
              cu.status as cus_status
         from sales_recurring_contracts c join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id
         join customers cu on cu.tenant_id = c.tenant_id and cu.id = c.customer_id
         join business_partners bp on bp.tenant_id = cu.tenant_id and bp.id = cu.partner_id
        where c.tenant_id = ? and c.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!c) throw ApiError.notFound()
  const versions = await versionsOf(scope, id)
  const vlines = new Map<string, any[]>()
  for (const v of versions) vlines.set(v.id, await linesOf(scope, v.id))
  const runs = (
    await scope.trx.rawQuery(
      `select r.*, r.period_start::text as ps, r.period_end::text as pe, r.invoice_date::text as idt, i.number as inv_number,
              i.status as inv_status, i.payable_total, v.version_no
         from sales_recurring_runs r left join sales_invoices i on i.tenant_id = r.tenant_id and i.id = r.invoice_id
         left join sales_recurring_versions v on v.tenant_id = r.tenant_id and v.id = r.version_id
        where r.tenant_id = ? and r.contract_id = ? order by r.created_at desc limit 100`,
      [t, id]
    )
  ).rows as any[]
  const a = g ?? rights(await scopesOf(scope), c.legal_entity_id)
  const me = scope.context.userId
  const asOf = today()
  // Próximos períodos (o seguinte a gerar e mais 5), com a versão que se aplicará e se já está na data.
  const schedule = []
  for (let k = Number(c.periods_generated); k < Number(c.periods_generated) + 6; k++) {
    const p = period(c.sd, c.frequency as Frequency, k, c.billing_timing)
    if (!withinContract(p, c.ed)) break
    const v = effectiveVersion(versions, p.periodStart)
    schedule.push({ ...p, versionNo: v ? Number(v.version_no) : null, due: p.invoiceDate <= asOf })
  }
  const hasApprovedAtStart = !!effectiveVersion(versions, c.sd)
  return {
    id: c.id as string,
    version: Number(c.version),
    reference: c.reference as string,
    description: c.description as string,
    legalEntity: { id: c.legal_entity_id as string, code: c.le_code as string },
    customer: {
      id: c.customer_id as string,
      code: c.cus_code as string,
      name: c.cus_name as string,
      status: c.cus_status as string,
    },
    currency: String(c.currency).trim(),
    frequency: c.frequency as string,
    billingTiming: c.billing_timing as string,
    startDate: c.sd as string,
    endDate: (c.ed as string) ?? null,
    paymentTermsDays: Number(c.payment_terms_days),
    periodsGenerated: Number(c.periods_generated),
    status: c.status as string,
    statusReason: (c.status_reason as string) ?? null,
    versions: versions.map((v) => ({
      id: v.id as string,
      version: Number(v.version),
      versionNo: Number(v.version_no),
      validFrom: v.validFrom,
      status: v.status,
      notes: (v.notes as string) ?? null,
      createdBy: (v.creator as string) ?? null,
      approvedBy: (v.approver as string) ?? null,
      approvedAt: v.approved_at ? new Date(v.approved_at).toISOString() : null,
      decisionReason: (v.decision_reason as string) ?? null,
      lines: (vlines.get(v.id) ?? []).map((l) => ({
        productId: l.product_id as string,
        sku: l.sku as string,
        name: l.name as string,
        description: (l.description as string) ?? null,
        quantity: qtyText(dbScaled(l.quantity, QTY_SCALE)),
        unitPrice: l.unit_price === null ? null : priceText(dbScaled(l.unit_price, PRICE_SCALE)),
        taxCodeIds: l.tax_code_ids as string[],
        exemptionCode: (l.exemption_code as string) ?? null,
      })),
      can: {
        edit: a.manage && v.status === 'DRAFT' && c.status !== 'ENDED',
        approve: a.approve && v.status === 'DRAFT' && v.created_by !== me && c.status !== 'ENDED',
        discard: a.manage && v.status === 'DRAFT',
      },
    })),
    runs: runs.map((r) => ({
      id: r.id as string,
      periodIndex: Number(r.period_index),
      periodStart: r.ps as string,
      periodEnd: r.pe as string,
      invoiceDate: r.idt as string,
      versionNo: r.version_no === null ? null : Number(r.version_no),
      status: r.status as string,
      reason: (r.reason as string) ?? null,
      invoice: r.invoice_id
        ? {
            id: r.invoice_id as string,
            number: (r.inv_number as string) ?? null,
            status: r.inv_status as string,
            payable: scaledText(dbScaled(r.payable_total, 2), 2),
          }
        : null,
      at: new Date(r.created_at).toISOString(),
    })),
    schedule,
    can: {
      edit: a.manage && c.status !== 'ENDED',
      addVersion: a.manage && c.status !== 'ENDED',
      activate: a.manage && c.status === 'DRAFT' && hasApprovedAtStart,
      suspend: a.manage && c.status === 'ACTIVE',
      resume: a.manage && c.status === 'SUSPENDED',
      end: a.manage && (c.status === 'ACTIVE' || c.status === 'SUSPENDED'),
      generate: a.manage && c.status === 'ACTIVE' && schedule.some((s) => s.due),
    },
  }
}
export type RecurringView = Awaited<ReturnType<typeof detail>>

/** Serviços activos e impostos activos (validação das linhas de uma versão). */
async function checkLines(scope: TenantScope, lines: VersionLineInput[]) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  for (const [i, l] of lines.entries()) {
    const p = (
      await scope.trx.rawQuery(
        `select product_type, status from products where tenant_id = ? and id = ?`,
        [t, l.productId]
      )
    ).rows[0] as any
    if (!p)
      issues.push({
        path: `lines.${i}.productId`,
        code: 'NOT_FOUND',
        message: 'Serviço inexistente.',
      })
    else if (p.product_type !== 'SERVICE')
      issues.push({
        path: `lines.${i}.productId`,
        code: 'NOT_SERVICE',
        message: 'Só serviços: produtos de stock facturam-se a partir da encomenda expedida.',
      })
    const n = Number(
      (
        (
          await scope.trx.rawQuery(
            `select count(*)::int as n from tax_codes where tenant_id = ? and status = 'ACTIVE' and id = any(?::uuid[])`,
            [t, l.taxCodeIds] as never[]
          )
        ).rows[0] as any
      ).n
    )
    if (n !== l.taxCodeIds.length)
      issues.push({
        path: `lines.${i}.taxCodeIds`,
        code: 'NOT_FOUND',
        message: 'Imposto inexistente ou inactivo.',
      })
  }
  fail(issues)
}

async function writeVersionLines(scope: TenantScope, versionId: string, lines: VersionLineInput[]) {
  const t = scope.context.tenantId
  await scope.trx.rawQuery(
    `delete from sales_recurring_version_lines where tenant_id = ? and version_id = ?`,
    [t, versionId]
  )
  for (const [i, l] of lines.entries())
    await scope.trx.rawQuery(
      `insert into sales_recurring_version_lines (tenant_id, version_id, line_no, product_id, description, quantity, unit_price,
         tax_code_ids, exemption_code, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?::uuid[], ?, ?, ?)`,
      [
        t,
        versionId,
        i + 1,
        l.productId,
        l.description,
        qtyText(l.quantity),
        l.unitPrice === null ? null : priceText(l.unitPrice),
        l.taxCodeIds,
        l.exemptionCode,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
}

/**
 * Início de vigência permitido: a primeira versão aprovada começa no início do contrato; as seguintes nunca antes do
 * próximo período a gerar (os períodos já gerados não mudam de preço).
 */
async function validFromIssue(
  scope: TenantScope,
  c: any,
  validFrom: string,
  exceptVersionId?: string
) {
  const approved = (await versionsOf(scope, c.id)).filter(
    (v) => v.status === 'APPROVED' && v.id !== exceptVersionId
  )
  if (!approved.length) {
    if (validFrom !== c.sd) return 'A primeira versão começa na data de início do contrato.'
    return null
  }
  const next = period(c.sd, c.frequency as Frequency, Number(c.periods_generated), c.billing_timing)
  if (validFrom < next.periodStart)
    return `Só a partir do próximo período por gerar (${next.periodStart}): os já gerados não mudam.`
  if (validFrom > (c.ed ?? '9999-12-31')) return 'Depois do fim do contrato.'
  return null
}

/** Regista a falha de um período (sem repetir a mesma falha seguida). */
async function recordFailure(
  context: TenantContext,
  contractId: string,
  k: number,
  reason: string
) {
  await runInTenant(context, async (scope) => {
    const c = await load(scope, contractId)
    const p = period(c.sd, c.frequency as Frequency, k, c.billing_timing)
    const last = (
      await scope.trx.rawQuery(
        `select status, reason from sales_recurring_runs where tenant_id = ? and contract_id = ? and period_index = ?
          order by created_at desc limit 1`,
        [context.tenantId, contractId, k]
      )
    ).rows[0] as any
    if (last?.status === 'FAILED' && last.reason === reason.slice(0, 500)) return
    await scope.trx.rawQuery(
      `insert into sales_recurring_runs (tenant_id, contract_id, period_index, period_start, period_end, invoice_date, status, reason,
         created_by, updated_by) values (?, ?, ?, ?, ?, ?, 'FAILED', ?, ?, ?)`,
      [
        context.tenantId,
        contractId,
        k,
        p.periodStart,
        p.periodEnd,
        p.invoiceDate,
        reason.slice(0, 500),
        context.userId,
        context.userId,
      ] as never[]
    )
  })
}

/**
 * Gera os períodos vencidos de um contrato, um por transacção e com o contrato bloqueado (`SKIP LOCKED`: se outro
 * processo o tem, este passa à frente). Só rascunhos de factura. Pára no primeiro período que falha (fica registado e
 * volta a tentar-se na próxima geração).
 */
export async function generateContract(context: TenantContext, contractId: string, asOf = today()) {
  const out: { periodStart: string; invoiceId?: string; failed?: string }[] = []
  for (let n = 0; n < MAX_PERIODS_PER_RUN; n++) {
    let k = -1
    try {
      const step = await runInTenant(context, async (scope) => {
        const c = (
          await scope.trx.rawQuery(
            `select *, start_date::text as sd, end_date::text as ed from sales_recurring_contracts
              where tenant_id = ? and id = ? for update skip locked`,
            [context.tenantId, contractId]
          )
        ).rows[0] as any
        if (!c || c.status !== 'ACTIVE') return null
        k = Number(c.periods_generated)
        const p = period(c.sd, c.frequency as Frequency, k, c.billing_timing)
        if (!withinContract(p, c.ed) || p.invoiceDate > asOf) return null
        const v = effectiveVersion(await versionsOf(scope, c.id), p.periodStart)
        if (!v)
          throw ApiError.conflict('NO_VERSION', 'Sem versão aprovada em vigor para o período.')
        const cust = (
          await scope.trx.rawQuery(`select status from customers where tenant_id = ? and id = ?`, [
            context.tenantId,
            c.customer_id,
          ])
        ).rows[0] as any
        if (cust.status !== 'ACTIVE')
          throw ApiError.conflict('CUSTOMER_BLOCKED', 'O cliente não está activo.')
        const label = `período ${p.periodStart} a ${p.periodEnd}`
        const invoiceId = await createRecurringDraft(scope, {
          legalEntityId: c.legal_entity_id,
          customerId: c.customer_id,
          invoiceDate: p.invoiceDate,
          currency: String(c.currency).trim(),
          paymentTermsDays: Number(c.payment_terms_days),
          customerReference: c.reference,
          notes: `Facturação recorrente ${c.reference} — ${label}.`,
          versionId: v.id,
          lines: (await linesOf(scope, v.id)).map((l) => ({
            productId: l.product_id,
            variantId: null,
            description: `${l.description ?? l.name} — ${label}`.slice(0, 300),
            quantity: qtyText(dbScaled(l.quantity, QTY_SCALE)),
            manualDiscountPct: null,
            manualUnitPrice: null,
            taxCodeIds: l.tax_code_ids,
            exemptionCode: l.exemption_code,
            orderLineId: null,
          })),
        })
        await scope.trx.rawQuery(
          `insert into sales_recurring_runs (tenant_id, contract_id, period_index, period_start, period_end, invoice_date, version_id,
             invoice_id, status, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, 'GENERATED', ?, ?)`,
          [
            context.tenantId,
            c.id,
            k,
            p.periodStart,
            p.periodEnd,
            p.invoiceDate,
            v.id,
            invoiceId,
            context.userId,
            context.userId,
          ] as never[]
        )
        await setContract(scope, c.id, { periods_generated: k + 1 })
        await audit(scope, {
          action: 'sales_recurring.period_generated',
          entityType: 'sales_recurring_contract',
          entityId: c.id,
          metadata: { period: p.periodStart, invoiceId, versionNo: Number(v.version_no) },
        })
        return { periodStart: p.periodStart, invoiceId }
      })
      if (!step) break
      out.push(step)
    } catch (e: any) {
      if (k < 0) throw e
      const reason =
        e instanceof ApiError
          ? `${e.code}: ${e.message}${e.details?.length ? ' ' + e.details.map((d) => d.message).join(' ') : ''}`
          : String(e?.message ?? e)
      await recordFailure(context, contractId, k, reason)
      out.push({ periodStart: '', failed: reason })
      break
    }
  }
  return out
}

/** Gera os períodos vencidos de todos os contratos activos (das entidades indicadas, ou todas). */
export async function generateDueContracts(
  context: TenantContext,
  les: Set<string> | null,
  asOf = today()
) {
  const ids = await runInTenant(context, async (scope) => {
    const params: unknown[] = [context.tenantId]
    let where = ''
    if (les) {
      if (!les.size) return []
      where = ` and legal_entity_id in (${[...les].map(() => '?').join(', ')})`
      params.push(...les)
    }
    return (
      (
        await scope.trx.rawQuery(
          `select id from sales_recurring_contracts where tenant_id = ? and status = 'ACTIVE'${where} order by reference`,
          params as never[]
        )
      ).rows as any[]
    ).map((r) => r.id as string)
  })
  let generated = 0
  let failed = 0
  for (const id of ids) {
    const r = await generateContract(context, id, asOf)
    generated += r.filter((x) => x.invoiceId).length
    failed += r.filter((x) => x.failed).length
  }
  return { contracts: ids.length, generated, failed }
}

export class RecurringService {
  list(context: TenantContext, f: { q?: string; status?: string; limit: number; offset: number }) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = Object.values(s)
      const where = ['c.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all.some((x) => x.tenant)) {
        const les = [...new Set(all.flatMap((x) => [...x.legalEntityIds]))]
        if (!les.length)
          throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar contratos recorrentes.')
        where.push(`c.legal_entity_id in (${les.map(() => '?').join(', ')})`)
        params.push(...les)
      }
      if (f.status && (CONTRACT_STATUSES as readonly string[]).includes(f.status))
        (where.push('c.status = ?'), params.push(f.status))
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(c.reference) like ? or lower(c.description) like ? or lower(bp.code) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like, like)
      }
      const from = `from sales_recurring_contracts c join customers cu on cu.tenant_id = c.tenant_id and cu.id = c.customer_id
        join business_partners bp on bp.tenant_id = cu.tenant_id and bp.id = cu.partner_id
        join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select c.*, c.start_date::text as sd, c.end_date::text as ed, bp.code as cus_code, bp.name as cus_name, le.code as le_code
             ${from} order by c.created_at desc, c.id limit ? offset ?`,
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
        items: rows.map((c) => {
          const next = period(
            c.sd,
            c.frequency as Frequency,
            Number(c.periods_generated),
            c.billing_timing
          )
          return {
            id: c.id as string,
            reference: c.reference as string,
            description: c.description as string,
            customer: { code: c.cus_code as string, name: c.cus_name as string },
            legalEntity: c.le_code as string,
            currency: String(c.currency).trim(),
            frequency: c.frequency as string,
            startDate: c.sd as string,
            endDate: (c.ed as string) ?? null,
            nextInvoiceDate:
              withinContract(next, c.ed) && c.status === 'ACTIVE' ? next.invoiceDate : null,
            periodsGenerated: Number(c.periods_generated),
            status: c.status as string,
          }
        }),
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

  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const t = context.tenantId
      const les = (
        (
          await scope.trx.rawQuery(
            `select id, code, legal_name, status, country_code from legal_entities where tenant_id = ? order by code`,
            [t]
          )
        ).rows as any[]
      ).filter((l) => l.status === 'ACTIVE' && covers(s.manage, l.id))
      const codes = (
        await scope.trx.rawQuery(
          `select id, code, name, kind, country_code from tax_codes where tenant_id = ? and status = 'ACTIVE' order by kind, code`,
          [t]
        )
      ).rows as any[]
      const exemptions = (
        await scope.trx.rawQuery(
          `select code, description, country_code from tax_exemptions where tenant_id = ? and status = 'CONFIRMED' order by code`,
          [t]
        )
      ).rows as any[]
      return {
        legalEntities: les.map((l) => ({
          id: l.id as string,
          code: l.code as string,
          name: l.legal_name as string,
          countryCode: String(l.country_code).trim(),
        })),
        taxCodes: codes.map((c) => ({
          id: c.id as string,
          code: c.code as string,
          name: c.name as string,
          kind: c.kind as string,
          countryCode: String(c.country_code).trim(),
        })),
        exemptions: exemptions.map((x) => ({
          code: x.code as string,
          description: x.description as string,
          countryCode: String(x.country_code).trim(),
        })),
      }
    })
  }

  search(context: TenantContext, kind: 'customers' | 'products', q: string) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!(s.manage.tenant || s.manage.legalEntityIds.size))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere contratos recorrentes.')
      return searchSalesRefs(scope, kind, q)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, issues } = normalizeContract(input, true)
      fail(issues)
      if (!covers((await scopesOf(scope)).manage, v.legalEntityId as string))
        throw ApiError.forbidden('OUT_OF_SCOPE', DENY.manage)
      const t = context.tenantId
      const le = (
        await scope.trx.rawQuery(
          `select status from legal_entities where tenant_id = ? and id = ?`,
          [t, v.legalEntityId as string]
        )
      ).rows[0] as any
      if (!le)
        fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' }])
      const c = (
        await scope.trx.rawQuery(
          `select currency, payment_terms_days from customers where tenant_id = ? and id = ?`,
          [t, v.customerId as string]
        )
      ).rows[0] as any
      if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
      let ins: any
      try {
        ins = await scope.trx.rawQuery(
          `insert into sales_recurring_contracts (tenant_id, reference, description, legal_entity_id, customer_id, currency, frequency,
             billing_timing, start_date, end_date, payment_terms_days, owner_membership_id, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            t,
            v.reference,
            v.description,
            v.legalEntityId,
            v.customerId,
            (v.currency as string) ?? String(c.currency).trim(),
            v.frequency,
            v.billingTiming ?? 'ADVANCE',
            v.startDate,
            v.endDate ?? null,
            (v.paymentTermsDays as number) ?? Number(c.payment_terms_days),
            context.membershipId,
            context.userId,
            context.userId,
          ] as never[]
        )
      } catch (e: any) {
        if (e?.code === '23505')
          throw new ApiError(409, 'REFERENCE_TAKEN', 'Já existe um contrato com esta referência.', [
            { path: 'reference', code: 'TAKEN', message: 'Referência em uso.' },
          ])
        throw e
      }
      const id = (ins.rows[0] as any).id as string
      await audit(scope, {
        action: 'sales_recurring.created',
        entityType: 'sales_recurring_contract',
        entityId: id,
        metadata: { reference: v.reference, frequency: v.frequency },
      })
      return detail(scope, id)
    })
  }

  /** Alterar o contrato: em rascunho tudo; activo/suspenso só descrição, prazo e fim (nunca antes do já gerado). */
  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      if (c.status === 'ENDED') throw ApiError.conflict('INVALID_STATE', 'O contrato terminou.')
      const { expectedVersion, legalEntityId, customerId, ...rest } = input
      const { v, issues } = normalizeContract(rest, false)
      fail(issues)
      if (c.status !== 'DRAFT')
        for (const k of ['reference', 'frequency', 'billingTiming', 'startDate', 'currency'])
          if (k in v) fail([{ path: k, code: 'NOT_ALLOWED', message: 'Só em rascunho.' }])
      if ('endDate' in v && v.endDate !== null) {
        const start = (v.startDate as string) ?? c.sd
        if ((v.endDate as string) < start)
          fail([{ path: 'endDate', code: 'BEFORE_START', message: 'O fim é anterior ao início.' }])
        if (Number(c.periods_generated) > 0) {
          const last = period(
            c.sd,
            c.frequency as Frequency,
            Number(c.periods_generated) - 1,
            c.billing_timing
          )
          if ((v.endDate as string) < last.periodStart)
            fail([
              {
                path: 'endDate',
                code: 'BEFORE_GENERATED',
                message: `Já há períodos gerados até ${last.periodEnd}.`,
              },
            ])
        }
      }
      const map: Record<string, string> = {
        reference: 'reference',
        description: 'description',
        frequency: 'frequency',
        billingTiming: 'billing_timing',
        startDate: 'start_date',
        endDate: 'end_date',
        paymentTermsDays: 'payment_terms_days',
        currency: 'currency',
      }
      const fields = Object.fromEntries(
        Object.entries(map)
          .filter(([k]) => k in v)
          .map(([k, col]) => [col, v[k]])
      )
      if (Object.keys(fields).length) await setContract(scope, id, fields)
      await audit(scope, {
        action: 'sales_recurring.updated',
        entityType: 'sales_recurring_contract',
        entityId: id,
        metadata: { fields: Object.keys(fields) },
      })
      return detail(scope, id)
    })
  }

  addVersion(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      if (c.status === 'ENDED') throw ApiError.conflict('INVALID_STATE', 'O contrato terminou.')
      const n = normalizeVersion(input)
      fail(n.issues)
      const problem = await validFromIssue(scope, c, n.validFrom)
      if (problem) fail([{ path: 'validFrom', code: 'INVALID_DATE', message: problem }])
      await checkLines(scope, n.lines)
      const no =
        Number(
          (
            (
              await scope.trx.rawQuery(
                `select coalesce(max(version_no), 0)::int as n from sales_recurring_versions where tenant_id = ? and contract_id = ?`,
                [context.tenantId, id]
              )
            ).rows[0] as any
          ).n
        ) + 1
      const ins = await scope.trx.rawQuery(
        `insert into sales_recurring_versions (tenant_id, contract_id, version_no, valid_from, notes, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?) returning id`,
        [context.tenantId, id, no, n.validFrom, n.notes, context.userId, context.userId] as never[]
      )
      const vid = (ins.rows[0] as any).id as string
      await writeVersionLines(scope, vid, n.lines)
      await audit(scope, {
        action: 'sales_recurring.version_created',
        entityType: 'sales_recurring_contract',
        entityId: id,
        metadata: { versionNo: no, validFrom: n.validFrom },
      })
      return detail(scope, id)
    })
  }

  private async versionFor(scope: TenantScope, versionId: string, need: Need) {
    if (!isUuid(versionId)) throw ApiError.notFound()
    const v = (
      await scope.trx.rawQuery(
        `select *, valid_from::text as vf from sales_recurring_versions where tenant_id = ? and id = ? for update`,
        [scope.context.tenantId, versionId]
      )
    ).rows[0] as any
    if (!v) throw ApiError.notFound()
    const { c } = await authorized(scope, v.contract_id, need, true)
    return { v, c }
  }

  updateVersion(context: TenantContext, versionId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, c } = await this.versionFor(scope, versionId, 'manage')
      versionCheck(v, input.expectedVersion)
      if (v.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se altera uma versão em rascunho.')
      const n = normalizeVersion(input)
      fail(n.issues)
      const problem = await validFromIssue(scope, c, n.validFrom, v.id)
      if (problem) fail([{ path: 'validFrom', code: 'INVALID_DATE', message: problem }])
      await checkLines(scope, n.lines)
      await scope.trx.rawQuery(
        `update sales_recurring_versions set valid_from = ?, notes = ?, version = version + 1, updated_at = now(), updated_by = ?
          where tenant_id = ? and id = ?`,
        [n.validFrom, n.notes, context.userId, context.tenantId, v.id] as never[]
      )
      await writeVersionLines(scope, v.id, n.lines)
      await audit(scope, {
        action: 'sales_recurring.version_updated',
        entityType: 'sales_recurring_contract',
        entityId: c.id,
        metadata: { versionNo: Number(v.version_no) },
      })
      return detail(scope, c.id)
    })
  }

  /** Aprovar uma versão (outra pessoa): fica imutável e passa a aplicar-se aos períodos a partir da vigência. */
  approveVersion(context: TenantContext, versionId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, c } = await this.versionFor(scope, versionId, 'approve')
      versionCheck(v, input.expectedVersion)
      if (v.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se aprova uma versão em rascunho.')
      if (c.status === 'ENDED') throw ApiError.conflict('INVALID_STATE', 'O contrato terminou.')
      if (v.created_by === context.userId)
        throw ApiError.forbidden('SELF_APPROVAL', 'Quem preparou a versão não a aprova.')
      const problem = await validFromIssue(scope, c, v.vf, v.id)
      if (problem) throw ApiError.conflict('INVALID_DATE', problem)
      try {
        await scope.trx.rawQuery(
          `update sales_recurring_versions set status = 'APPROVED', approved_by = ?, approved_at = now(), version = version + 1,
             updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
          [context.userId, context.userId, context.tenantId, v.id]
        )
      } catch (e: any) {
        if (e?.code === '23505')
          throw ApiError.conflict(
            'VERSION_OVERLAP',
            'Já há uma versão aprovada com este início de vigência.'
          )
        throw e
      }
      await audit(scope, {
        action: 'sales_recurring.version_approved',
        entityType: 'sales_recurring_contract',
        entityId: c.id,
        metadata: { versionNo: Number(v.version_no), validFrom: v.vf },
      })
      return detail(scope, c.id)
    })
  }

  discardVersion(context: TenantContext, versionId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, c } = await this.versionFor(scope, versionId, 'manage')
      versionCheck(v, input.expectedVersion)
      if (v.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se descarta uma versão em rascunho.')
      const reason = reasonOf(input.reason)
      await scope.trx.rawQuery(
        `update sales_recurring_versions set status = 'DISCARDED', decision_reason = ?, version = version + 1, updated_at = now(),
           updated_by = ? where tenant_id = ? and id = ?`,
        [reason, context.userId, context.tenantId, v.id]
      )
      await audit(scope, {
        action: 'sales_recurring.version_discarded',
        entityType: 'sales_recurring_contract',
        entityId: c.id,
        metadata: { versionNo: Number(v.version_no), reason },
      })
      return detail(scope, c.id)
    })
  }

  /** Activar/suspender/retomar/terminar. Activar exige uma versão aprovada em vigor no início e cliente activo. */
  transition(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    action: 'activate' | 'suspend' | 'resume' | 'end'
  ) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      const from = c.status as string
      const allowed: Record<typeof action, string[]> = {
        activate: ['DRAFT'],
        suspend: ['ACTIVE'],
        resume: ['SUSPENDED'],
        end: ['ACTIVE', 'SUSPENDED'],
      }
      if (!allowed[action].includes(from))
        throw ApiError.conflict('INVALID_STATE', 'Esta acção não se aplica ao estado do contrato.')
      const fields: Record<string, unknown> = {}
      let reason: string | null = null
      if (action === 'activate' || action === 'resume') {
        if (action === 'activate' && !effectiveVersion(await versionsOf(scope, id), c.sd))
          throw ApiError.conflict(
            'NO_VERSION',
            'Falta uma versão aprovada em vigor na data de início.'
          )
        const cust = (
          await scope.trx.rawQuery(`select status from customers where tenant_id = ? and id = ?`, [
            context.tenantId,
            c.customer_id,
          ])
        ).rows[0] as any
        if (cust.status !== 'ACTIVE')
          throw ApiError.conflict('CUSTOMER_BLOCKED', 'O cliente não está activo.')
        Object.assign(fields, { status: 'ACTIVE', status_reason: null })
      } else {
        reason = reasonOf(input.reason)
        Object.assign(fields, {
          status: action === 'suspend' ? 'SUSPENDED' : 'ENDED',
          status_reason: reason,
        })
      }
      await setContract(scope, id, fields)
      await audit(scope, {
        action: `sales_recurring.${action === 'end' ? 'ended' : action === 'suspend' ? 'suspended' : action === 'resume' ? 'resumed' : 'activated'}`,
        entityType: 'sales_recurring_contract',
        entityId: id,
        changes: { status: { from, to: fields.status } },
        metadata: reason ? { reason } : undefined,
      })
      return detail(scope, id)
    })
  }

  /** Gerar já os períodos vencidos de um contrato (rascunhos). */
  async generate(context: TenantContext, id: string) {
    await runInTenant(context, (scope) => authorized(scope, id, 'manage'))
    const result = await generateContract(context, id)
    const view = await runInTenant(context, (scope) => detail(scope, id))
    return {
      generated: result.filter((r) => r.invoiceId).length,
      failed: result.find((r) => r.failed)?.failed ?? null,
      contract: view,
    }
  }

  /** Gerar os períodos vencidos de todos os contratos activos das entidades que gere. */
  async generateAll(context: TenantContext) {
    const les = await runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (s.manage.tenant) return null
      if (!s.manage.legalEntityIds.size) throw ApiError.forbidden('OUT_OF_SCOPE', DENY.manage)
      return new Set(s.manage.legalEntityIds)
    })
    return generateDueContracts(context, les)
  }
}

/** Acesso aos anexos do contrato. */
export async function recurringAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const c = (
    await scope.trx.rawQuery(
      `select legal_entity_id from sales_recurring_contracts where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) return null
  const g = rights(await scopesOf(scope), c.legal_entity_id)
  return g.read ? { read: true, write: g.manage } : null
}
