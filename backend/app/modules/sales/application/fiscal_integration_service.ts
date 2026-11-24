import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { documentHash } from '#modules/sales/domain/invoices'
import { dbScaled, scaledText } from '#modules/sales/domain/pricing'
import {
  type FiscalPayload,
  PAYLOAD_FORMAT,
  type PollResult,
  type SubmitResult,
  PROVIDER_INFO,
  PROVIDERS,
  type ProviderCode,
  retryDelayMinutes,
  type Scenario,
  SCENARIOS,
  SUBMISSION_STATUSES,
  validatePayload,
} from '#modules/sales/domain/fiscal_integration'
import { fiscalProvider } from '#modules/sales/infrastructure/fiscal_providers'

/*
 * Integração fiscal electrónica (10.9), só em SIMULAÇÃO. A emissão de um documento (factura, factura-recibo, nota)
 * põe-no na fila na mesma transacção (outbox): payload fotografado, validação local e idempotência por documento. O
 * processamento é separado da emissão: reclama submissões vencidas (`FOR UPDATE SKIP LOCKED`), chama o fornecedor fora
 * da transacção do pedido e grava o resultado; falhas transitórias repetem com espera crescente; a decisão final
 * actualiza o estado fiscal do documento. Contingência por entidade: os documentos emitidos ficam retidos e são
 * enviados quando a contingência termina. Permissões: `sales.fiscal.read` (consultar) e `.manage` (configurar,
 * contingência, processar, repetir) no âmbito da entidade legal.
 */

const money = (v: unknown) => scaledText(dbScaled(v, 2), 2)
const today = () => new Date().toISOString().slice(0, 10)
const LEASE_MINUTES = 5
type DocType = 'SALES_INVOICE' | 'SALES_NOTE'

async function scopesOf(scope: TenantScope) {
  return {
    read: await permissionScope(scope, 'sales.fiscal.read'),
    manage: await permissionScope(scope, 'sales.fiscal.manage'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
const reasonOf = (v: unknown) => {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3 || r.length > 500)
    throw ApiError.validation([
      { path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' },
    ])
  return r
}

/** Definições da entidade (ou as de omissão: simulador, aceitar, 5 tentativas, sem contingência). */
async function settingsOf(scope: TenantScope, le: string, lock = false) {
  const r = (
    await scope.trx.rawQuery(
      `select * from fiscal_integration_settings where tenant_id = ? and legal_entity_id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, le]
    )
  ).rows[0] as any
  return {
    row: r ?? null,
    provider: (r?.provider ?? 'LOCAL_SIMULATOR') as ProviderCode,
    scenario: (r?.simulator_scenario ?? 'ACCEPT') as Scenario,
    maxAttempts: Number(r?.max_attempts ?? 5),
    contingency: !!r?.contingency_active,
    contingencyReason: (r?.contingency_reason as string) ?? null,
    contingencySince: r?.contingency_since ? new Date(r.contingency_since).toISOString() : null,
    version: r ? Number(r.version) : 0,
  }
}

const taxesOf = (taxes: any[] | null) =>
  (taxes ?? []).map((t) => ({
    code: String(t.code),
    kind: String(t.kind),
    rate: String(t.rate),
    base: String(t.base),
    amount: String(t.amount),
    exemptionCode: (t.exemptionCode as string) ?? null,
  }))

/** Payload interno (`SG-SIM-1`) de um documento emitido, a partir do que ficou gravado na emissão. */
async function buildPayload(scope: TenantScope, type: DocType, id: string) {
  const t = scope.context.tenantId
  if (type === 'SALES_INVOICE') {
    const i = (
      await scope.trx.rawQuery(
        `select i.*, i.invoice_date::text as d, le.tax_id as le_tax, le.legal_name as le_name, s.fiscal_code
           from sales_invoices i join legal_entities le on le.tenant_id = i.tenant_id and le.id = i.legal_entity_id
           left join fiscal_series s on s.tenant_id = i.tenant_id and s.id = i.series_id
          where i.tenant_id = ? and i.id = ?`,
        [t, id]
      )
    ).rows[0] as any
    if (!i || !['ISSUED', 'CORRECTED'].includes(i.status))
      throw ApiError.conflict('NOT_ISSUED', 'Só se comunica um documento emitido.')
    const lines = (
      await scope.trx.rawQuery(
        `select * from sales_invoice_lines where tenant_id = ? and invoice_id = ? order by line_no`,
        [t, id]
      )
    ).rows as any[]
    const snap = (i.customer_snapshot ?? {}) as any
    const payload: FiscalPayload = {
      format: PAYLOAD_FORMAT,
      simulation: true,
      documentType: (i.fiscal_code as string) ?? '',
      number: i.number,
      date: i.d,
      issuer: { taxId: (i.le_tax as string) ?? null, name: i.le_name },
      customer: {
        taxId: snap.taxId ?? null,
        name: snap.name ?? null,
        countryCode: snap.countryCode ?? null,
      },
      currency: String(i.currency).trim(),
      exchangeRate: String(i.exchange_rate),
      reference: null,
      reason: null,
      lines: lines.map((l) => ({
        n: Number(l.line_no),
        description: l.description,
        quantity: scaledText(dbScaled(l.quantity, 6), 6),
        unitPrice: l.net_unit_price === null ? null : scaledText(dbScaled(l.net_unit_price, 4), 4),
        net: money(l.net_amount),
        taxes: taxesOf(l.taxes),
      })),
      totals: {
        net: money(i.net_total),
        tax: money(i.tax_total),
        gross: money(i.gross_total),
        withholding: money(i.withholding_total),
        payable: money(i.payable_total),
      },
      documentHash: (i.document_hash as string) ?? null,
    }
    return { payload, legalEntityId: i.legal_entity_id as string, number: i.number as string }
  }
  const n = (
    await scope.trx.rawQuery(
      `select n.*, n.note_date::text as d, le.tax_id as le_tax, le.legal_name as le_name, s.fiscal_code,
              i.number as inv_number, i.invoice_date::text as inv_date
         from sales_notes n join legal_entities le on le.tenant_id = n.tenant_id and le.id = n.legal_entity_id
         join sales_invoices i on i.tenant_id = n.tenant_id and i.id = n.invoice_id
         left join fiscal_series s on s.tenant_id = n.tenant_id and s.id = n.series_id
        where n.tenant_id = ? and n.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!n || n.status !== 'ISSUED')
    throw ApiError.conflict('NOT_ISSUED', 'Só se comunica um documento emitido.')
  const lines = (
    await scope.trx.rawQuery(
      `select * from sales_note_lines where tenant_id = ? and note_id = ? order by line_no`,
      [t, id]
    )
  ).rows as any[]
  const snap = (n.customer_snapshot ?? {}) as any
  const payload: FiscalPayload = {
    format: PAYLOAD_FORMAT,
    simulation: true,
    documentType: (n.fiscal_code as string) ?? '',
    number: n.number,
    date: n.d,
    issuer: { taxId: (n.le_tax as string) ?? null, name: n.le_name },
    customer: {
      taxId: snap.taxId ?? null,
      name: snap.name ?? null,
      countryCode: snap.countryCode ?? null,
    },
    currency: String(n.currency).trim(),
    exchangeRate: String(n.exchange_rate),
    reference: { number: n.inv_number, date: n.inv_date },
    reason: `${n.reason_code}: ${n.reason}`,
    lines: lines.map((l) => ({
      n: Number(l.line_no),
      description: l.description,
      quantity: l.quantity === null ? null : scaledText(dbScaled(l.quantity, 6), 6),
      unitPrice: null,
      net: money(l.net_amount),
      taxes: taxesOf(l.taxes),
    })),
    totals: {
      net: money(n.net_total),
      tax: money(n.tax_total),
      gross: money(n.gross_total),
      withholding: money(n.withholding_total),
      payable: money(n.payable_total),
    },
    documentHash: (n.document_hash as string) ?? null,
  }
  return { payload, legalEntityId: n.legal_entity_id as string, number: n.number as string }
}

/** Estado fiscal do documento (o que a factura/nota mostram). */
async function setDocumentFiscal(scope: TenantScope, type: DocType, id: string, status: string) {
  const table = type === 'SALES_INVOICE' ? 'sales_invoices' : 'sales_notes'
  await scope.trx.rawQuery(
    `update ${table} set fiscal_status = ?, version = version + 1, updated_at = now(), updated_by = ?
      where tenant_id = ? and id = ? and fiscal_status is distinct from ?`,
    [status, scope.context.userId, scope.context.tenantId, id, status]
  )
}

async function attempt(
  scope: TenantScope,
  s: { id: string; attempts: number },
  action: string,
  outcome: string,
  code: string | null,
  message: string | null,
  ms: number | null = null
) {
  await scope.trx.rawQuery(
    `insert into fiscal_submission_attempts (tenant_id, submission_id, attempt_no, action, outcome, code, message, duration_ms,
       created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      s.id,
      s.attempts,
      action,
      outcome,
      code,
      message ? message.slice(0, 500) : null,
      ms,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function setSubmission(
  scope: TenantScope,
  id: string,
  f: Record<string, unknown>,
  raw: string[] = []
) {
  const cols = Object.keys(f)
  await scope.trx.rawQuery(
    `update fiscal_submissions set ${[...cols.map((c) => `${c} = ?`), ...raw].join(', ')}, version = version + 1,
       updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
    [...cols.map((c) => f[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/**
 * Pôr um documento emitido na fila (na transacção da emissão). Idempotente: um documento tem uma só submissão. Com a
 * validação local a falhar fica INVALID; com a contingência activa fica retido (CONTINGENCY) para enviar depois.
 */
export async function enqueueFiscalDocument(
  scope: TenantScope,
  doc: { documentType: DocType; documentId: string }
) {
  const t = scope.context.tenantId
  const existing = (
    await scope.trx.rawQuery(
      `select id from fiscal_submissions where tenant_id = ? and document_type = ? and document_id = ?`,
      [t, doc.documentType, doc.documentId]
    )
  ).rows[0] as any
  if (existing) return existing.id as string
  const b = await buildPayload(scope, doc.documentType, doc.documentId)
  const settings = await settingsOf(scope, b.legalEntityId)
  const hash = documentHash(b.payload)
  const issues = validatePayload(b.payload, today())
  const status = issues.length ? 'INVALID' : settings.contingency ? 'CONTINGENCY' : 'QUEUED'
  const ins = await scope.trx.rawQuery(
    `insert into fiscal_submissions (tenant_id, legal_entity_id, document_type, document_id, document_number, provider,
       payload_format, payload, payload_hash, idempotency_key, status, next_attempt_at, validation_issues, in_contingency,
       requested_membership_id, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'QUEUED' ? 'now()' : 'null'}, ?, ?, ?, ?, ?) returning id`,
    [
      t,
      b.legalEntityId,
      doc.documentType,
      doc.documentId,
      b.number,
      settings.provider,
      PAYLOAD_FORMAT,
      JSON.stringify(b.payload),
      hash,
      `${doc.documentType}:${doc.documentId}:${hash.slice(0, 16)}`,
      status,
      issues.length ? JSON.stringify(issues) : null,
      status === 'CONTINGENCY',
      scope.context.membershipId,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  const id = (ins.rows[0] as any).id as string
  const s = { id, attempts: 0 }
  if (status === 'INVALID')
    await attempt(
      scope,
      s,
      'VALIDATE',
      'INVALID',
      'LOCAL-VALIDATION',
      issues.map((x) => x.message).join(' ')
    )
  if (status === 'CONTINGENCY') {
    await attempt(scope, s, 'CONTINGENCY', 'HELD', null, settings.contingencyReason)
    await setDocumentFiscal(scope, doc.documentType, doc.documentId, 'CONTINGENCY')
  }
  return id
}

type Claimed = {
  id: string
  status: 'SENDING' | 'AWAITING'
  attempts: number
  failures: number
  provider: ProviderCode
  scenario: Scenario
  maxAttempts: number
  payload: FiscalPayload
  payloadHash: string
  key: string
  requestId: string | null
  documentType: DocType
  documentId: string
  legalEntityId: string
}

/** Reclama uma submissão (vencida, ou uma em particular) numa transacção curta; devolve null se não houver. */
async function claim(context: TenantContext, only: string | null, les: Set<string> | null) {
  return runInTenant(context, async (scope) => {
    const params: unknown[] = [context.tenantId]
    let where: string
    if (only) {
      where = `id = ? and (status in ('QUEUED','AWAITING') or (status = 'SENDING' and updated_at < now() - interval '${LEASE_MINUTES} minutes'))`
      params.push(only)
    } else
      where = `((status in ('QUEUED','AWAITING') and next_attempt_at <= now())
               or (status = 'SENDING' and updated_at < now() - interval '${LEASE_MINUTES} minutes'))`
    if (les) {
      if (!les.size) return null
      where += ` and legal_entity_id in (${[...les].map(() => '?').join(', ')})`
      params.push(...les)
    }
    const r = (
      await scope.trx.rawQuery(
        `select * from fiscal_submissions where tenant_id = ? and ${where}
          order by next_attempt_at nulls first, created_at limit 1 for update skip locked`,
        params as never[]
      )
    ).rows[0] as any
    if (!r) return null
    const settings = await settingsOf(scope, r.legal_entity_id)
    const polling = r.status === 'AWAITING'
    // Reserva: em envio (com prazo) ou, na consulta, empurra a próxima consulta para não ser apanhada em paralelo.
    if (polling)
      await setSubmission(scope, r.id, {}, [
        `next_attempt_at = now() + interval '${LEASE_MINUTES} minutes'`,
      ])
    else await setSubmission(scope, r.id, { status: 'SENDING', attempts: Number(r.attempts) + 1 })
    return {
      id: r.id,
      status: polling ? 'AWAITING' : 'SENDING',
      attempts: polling ? Number(r.attempts) : Number(r.attempts) + 1,
      failures: Number(r.failures),
      provider: r.provider,
      scenario: settings.scenario,
      maxAttempts: settings.maxAttempts,
      payload: r.payload,
      payloadHash: r.payload_hash,
      key: r.idempotency_key,
      requestId: r.request_id,
      documentType: r.document_type,
      documentId: r.document_id,
      legalEntityId: r.legal_entity_id,
    } as Claimed
  })
}

/** Grava o resultado de uma chamada ao fornecedor (envio ou consulta) e actualiza o documento. */
async function record(context: TenantContext, c: Claimed, res: any, ms: number) {
  return runInTenant(context, async (scope) => {
    const s = { id: c.id, attempts: c.attempts }
    const action = c.status === 'SENDING' ? 'SUBMIT' : 'POLL'
    const decided = async (status: 'ACCEPTED' | 'REJECTED') => {
      await setSubmission(
        scope,
        c.id,
        {
          status,
          result_code: res.code,
          result_message: res.message,
          response: JSON.stringify(res),
          decided_at: new Date(),
          next_attempt_at: null,
        },
        []
      )
      await setDocumentFiscal(scope, c.documentType, c.documentId, status)
      await audit(scope, {
        action: `fiscal_submission.${status.toLowerCase()}`,
        entityType: 'fiscal_submission',
        entityId: c.id,
        metadata: { document: c.payload.number, code: res.code, simulation: true },
      })
    }
    const transient = async () => {
      const failures = c.failures + 1
      const failed = failures >= c.maxAttempts
      await setSubmission(
        scope,
        c.id,
        {
          status: failed ? 'FAILED' : c.status === 'SENDING' ? 'QUEUED' : 'AWAITING',
          failures,
          result_code: res.code,
          result_message: res.message,
        },
        failed
          ? ['next_attempt_at = null']
          : [`next_attempt_at = now() + interval '${retryDelayMinutes(failures)} minutes'`]
      )
    }
    await attempt(
      scope,
      s,
      action,
      res.outcome === 'RECEIVED' ? 'OK' : res.outcome,
      res.code,
      res.message,
      ms
    )
    switch (res.outcome) {
      case 'RECEIVED':
        await setSubmission(
          scope,
          c.id,
          { status: 'AWAITING', request_id: res.requestId, sent_at: new Date(), failures: 0 },
          ['next_attempt_at = now()']
        )
        break
      case 'PENDING':
        await setSubmission(scope, c.id, { status: 'AWAITING' }, [
          `next_attempt_at = now() + interval '1 minutes'`,
        ])
        break
      case 'ACCEPTED':
        await decided('ACCEPTED')
        break
      case 'REJECTED':
        await decided('REJECTED')
        break
      default:
        await transient()
    }
  })
}

/** Processa uma submissão já reclamada: chama o fornecedor (fora da transacção da reclamação) e grava o resultado. */
async function run(context: TenantContext, c: Claimed) {
  const provider = fiscalProvider(c.provider)
  const started = Date.now()
  let res: any
  try {
    if (!provider.availability().available)
      res = {
        outcome: 'TRANSIENT',
        code: 'PROVIDER_UNAVAILABLE',
        message: provider.availability().reason,
      }
    else
      res = await runInTenant<SubmitResult | PollResult>(context, (scope) =>
        c.status === 'SENDING'
          ? provider.submit(scope, {
              idempotencyKey: c.key,
              payload: c.payload,
              payloadHash: c.payloadHash,
              scenario: c.scenario,
            })
          : provider.poll(scope, { requestId: c.requestId!, scenario: c.scenario })
      )
  } catch (e: any) {
    // Falha de comunicação ou do adaptador: transitória (repete com espera), nunca perde o documento.
    res = { outcome: 'TRANSIENT', code: 'ERROR', message: String(e?.message ?? e).slice(0, 300) }
  }
  await record(context, c, res, Date.now() - started)
  return { id: c.id, outcome: res.outcome as string }
}

/**
 * Processa a fila vencida de um tenant (até `limit` chamadas): é o que um agendador corre periodicamente. Só nas
 * entidades onde quem processa tem `sales.fiscal.manage` (ou todas, para o comando de sistema).
 */
export async function processFiscalQueue(
  context: TenantContext,
  limit = 20,
  les: Set<string> | null = null
) {
  const out: { id: string; outcome: string }[] = []
  for (let n = 0; n < limit; n++) {
    const c = await claim(context, null, les)
    if (!c) break
    out.push(await run(context, c))
  }
  return out
}

async function view(scope: TenantScope, id: string) {
  const r = (
    await scope.trx.rawQuery(
      `select s.*, le.code as le_code from fiscal_submissions s join legal_entities le on le.tenant_id = s.tenant_id and le.id = s.legal_entity_id
        where s.tenant_id = ? and s.id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  const attempts = (
    await scope.trx.rawQuery(
      `select a.*, u.full_name from fiscal_submission_attempts a left join users u on u.id = a.created_by
        where a.tenant_id = ? and a.submission_id = ? order by a.created_at, a.id`,
      [scope.context.tenantId, id]
    )
  ).rows as any[]
  const g = await scopesOf(scope)
  return {
    id: r.id as string,
    version: Number(r.version),
    legalEntity: { id: r.legal_entity_id as string, code: r.le_code as string },
    documentType: r.document_type as DocType,
    documentId: r.document_id as string,
    documentNumber: r.document_number as string,
    provider: r.provider as string,
    providerLabel: PROVIDER_INFO[r.provider as ProviderCode].label,
    environment: r.environment as string,
    payloadFormat: r.payload_format as string,
    payload: r.payload as FiscalPayload,
    payloadHash: r.payload_hash as string,
    idempotencyKey: r.idempotency_key as string,
    status: r.status as string,
    attempts: Number(r.attempts),
    failures: Number(r.failures),
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
    requestId: (r.request_id as string) ?? null,
    resultCode: (r.result_code as string) ?? null,
    resultMessage: (r.result_message as string) ?? null,
    validationIssues: (r.validation_issues as ErrorDetail[]) ?? [],
    inContingency: !!r.in_contingency,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    history: attempts.map((a) => ({
      attemptNo: Number(a.attempt_no),
      action: a.action as string,
      outcome: a.outcome as string,
      code: (a.code as string) ?? null,
      message: (a.message as string) ?? null,
      durationMs: a.duration_ms === null ? null : Number(a.duration_ms),
      at: new Date(a.created_at).toISOString(),
      by: (a.full_name as string) ?? null,
    })),
    can: {
      process: covers(g.manage, r.legal_entity_id) && ['QUEUED', 'AWAITING'].includes(r.status),
      requeue: covers(g.manage, r.legal_entity_id) && r.status === 'FAILED',
    },
  }
}
export type FiscalSubmissionView = Awaited<ReturnType<typeof view>>

export class FiscalIntegrationService {
  /** Fornecedores (com disponibilidade) e definições por entidade legal visível. */
  settings(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const g = await scopesOf(scope)
      const les = (
        (
          await scope.trx.rawQuery(
            `select id, code, legal_name, tax_id, status from legal_entities where tenant_id = ? order by code`,
            [context.tenantId]
          )
        ).rows as any[]
      ).filter((l) => l.status === 'ACTIVE' && (covers(g.read, l.id) || covers(g.manage, l.id)))
      if (!les.length && !g.read.tenant && !g.manage.tenant)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar a integração fiscal.')
      const counts = (
        await scope.trx.rawQuery(
          `select legal_entity_id, status, count(*)::int as n from fiscal_submissions where tenant_id = ? group by 1, 2`,
          [context.tenantId]
        )
      ).rows as any[]
      const out = []
      for (const l of les) {
        const s = await settingsOf(scope, l.id)
        out.push({
          legalEntity: {
            id: l.id as string,
            code: l.code as string,
            name: l.legal_name as string,
            taxId: (l.tax_id as string) ?? null,
          },
          provider: s.provider,
          simulatorScenario: s.scenario,
          maxAttempts: s.maxAttempts,
          contingency: s.contingency,
          contingencyReason: s.contingencyReason,
          contingencySince: s.contingencySince,
          version: s.version,
          counts: Object.fromEntries(
            counts.filter((c) => c.legal_entity_id === l.id).map((c) => [c.status, Number(c.n)])
          ),
          canManage: covers(g.manage, l.id),
        })
      }
      return {
        providers: PROVIDERS.map((p) => ({ code: p, ...PROVIDER_INFO[p] })),
        scenarios: [...SCENARIOS],
        payloadFormat: PAYLOAD_FORMAT,
        entities: out,
      }
    })
  }

  /** Alterar fornecedor, cenário do simulador e máximo de tentativas. O adaptador oficial é recusado. */
  updateSettings(context: TenantContext, le: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(le)) throw ApiError.notFound()
      if (!covers((await scopesOf(scope)).manage, le))
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Não configura a integração fiscal desta entidade.'
        )
      const exists = (
        await scope.trx.rawQuery(`select 1 from legal_entities where tenant_id = ? and id = ?`, [
          context.tenantId,
          le,
        ])
      ).rows[0]
      if (!exists) throw ApiError.notFound()
      const issues: ErrorDetail[] = []
      const provider = input.provider ?? 'LOCAL_SIMULATOR'
      if (!(PROVIDERS as readonly unknown[]).includes(provider))
        issues.push({ path: 'provider', code: 'INVALID', message: 'Fornecedor desconhecido.' })
      const scenario = input.simulatorScenario ?? 'ACCEPT'
      if (!(SCENARIOS as readonly unknown[]).includes(scenario))
        issues.push({
          path: 'simulatorScenario',
          code: 'INVALID',
          message: 'Cenário desconhecido.',
        })
      const max = Number(input.maxAttempts ?? 5)
      if (!Number.isInteger(max) || max < 1 || max > 20)
        issues.push({ path: 'maxAttempts', code: 'INVALID', message: 'Entre 1 e 20.' })
      if (issues.length) throw ApiError.validation(issues)
      if (!PROVIDER_INFO[provider as ProviderCode].available)
        throw new ApiError(
          409,
          'PROVIDER_UNAVAILABLE',
          PROVIDER_INFO[provider as ProviderCode].reason!,
          [
            {
              path: 'provider',
              code: 'UNAVAILABLE',
              message: PROVIDER_INFO[provider as ProviderCode].reason!,
            },
          ]
        )
      const s = await settingsOf(scope, le, true)
      if (s.row && Number(input.expectedVersion) !== s.version)
        throw ApiError.versionConflict(s.version)
      if (s.row)
        await scope.trx.rawQuery(
          `update fiscal_integration_settings set provider = ?, simulator_scenario = ?, max_attempts = ?, version = version + 1,
             updated_at = now(), updated_by = ? where tenant_id = ? and legal_entity_id = ?`,
          [provider, scenario, max, context.userId, context.tenantId, le] as never[]
        )
      else
        await scope.trx.rawQuery(
          `insert into fiscal_integration_settings (tenant_id, legal_entity_id, provider, simulator_scenario, max_attempts, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [context.tenantId, le, provider, scenario, max, context.userId, context.userId] as never[]
        )
      await audit(scope, {
        action: 'fiscal_integration.settings_updated',
        entityType: 'legal_entity',
        entityId: le,
        metadata: { provider, simulatorScenario: scenario, maxAttempts: max },
      })
      return settingsOf(scope, le)
    })
  }

  /**
   * Contingência da entidade. Activar (com motivo): os documentos emitidos a seguir ficam retidos. Terminar (com
   * motivo): os retidos voltam à fila e são enviados — o estado fiscal só muda quando houver decisão.
   */
  setContingency(context: TenantContext, le: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(le)) throw ApiError.notFound()
      if (!covers((await scopesOf(scope)).manage, le))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a contingência desta entidade.')
      const exists = (
        await scope.trx.rawQuery(`select 1 from legal_entities where tenant_id = ? and id = ?`, [
          context.tenantId,
          le,
        ])
      ).rows[0]
      if (!exists) throw ApiError.notFound()
      const reason = reasonOf(input.reason)
      const active = input.active === true
      const s = await settingsOf(scope, le, true)
      if (s.row && Number(input.expectedVersion) !== s.version)
        throw ApiError.versionConflict(s.version)
      if (s.contingency === active)
        throw ApiError.conflict(
          'INVALID_STATE',
          active ? 'A contingência já está activa.' : 'Não há contingência activa.'
        )
      if (!s.row)
        await scope.trx.rawQuery(
          `insert into fiscal_integration_settings (tenant_id, legal_entity_id, created_by, updated_by) values (?, ?, ?, ?)`,
          [context.tenantId, le, context.userId, context.userId]
        )
      await scope.trx.rawQuery(
        `update fiscal_integration_settings set contingency_active = ?, contingency_reason = ?, contingency_since = ${active ? 'now()' : 'null'},
           version = version + 1, updated_at = now(), updated_by = ? where tenant_id = ? and legal_entity_id = ?`,
        [active, active ? reason : null, context.userId, context.tenantId, le] as never[]
      )
      let released = 0
      if (!active) {
        const held = (
          await scope.trx.rawQuery(
            `select id, attempts from fiscal_submissions where tenant_id = ? and legal_entity_id = ? and status = 'CONTINGENCY' for update`,
            [context.tenantId, le]
          )
        ).rows as any[]
        for (const h of held) {
          await setSubmission(scope, h.id, { status: 'QUEUED' }, ['next_attempt_at = now()'])
          await attempt(
            scope,
            { id: h.id, attempts: Number(h.attempts) },
            'REQUEUE',
            'REQUEUED',
            null,
            reason
          )
        }
        released = held.length
      }
      await audit(scope, {
        action: active
          ? 'fiscal_integration.contingency_started'
          : 'fiscal_integration.contingency_ended',
        entityType: 'legal_entity',
        entityId: le,
        metadata: { reason, released },
      })
      return { ...(await settingsOf(scope, le)), released }
    })
  }

  list(
    context: TenantContext,
    f: { status?: string; documentType?: string; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const g = await scopesOf(scope)
      const where = ['s.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!g.read.tenant && !g.manage.tenant) {
        const les = [...new Set([...g.read.legalEntityIds, ...g.manage.legalEntityIds])]
        if (!les.length)
          throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar a integração fiscal.')
        where.push(`s.legal_entity_id in (${les.map(() => '?').join(', ')})`)
        params.push(...les)
      }
      if (f.status && (SUBMISSION_STATUSES as readonly string[]).includes(f.status))
        (where.push('s.status = ?'), params.push(f.status))
      if (f.documentType === 'SALES_INVOICE' || f.documentType === 'SALES_NOTE')
        (where.push('s.document_type = ?'), params.push(f.documentType))
      if (f.q) {
        where.push(`lower(s.document_number) like ?`)
        params.push(`%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`)
      }
      const from = `from fiscal_submissions s join legal_entities le on le.tenant_id = s.tenant_id and le.id = s.legal_entity_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select s.*, le.code as le_code ${from} order by s.created_at desc, s.id limit ? offset ?`,
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
        items: rows.map((r) => ({
          id: r.id as string,
          documentType: r.document_type as string,
          documentId: r.document_id as string,
          documentNumber: r.document_number as string,
          legalEntity: r.le_code as string,
          provider: r.provider as string,
          status: r.status as string,
          attempts: Number(r.attempts),
          resultCode: (r.result_code as string) ?? null,
          resultMessage: (r.result_message as string) ?? null,
          inContingency: !!r.in_contingency,
          nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
          createdAt: new Date(r.created_at).toISOString(),
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      const le = (
        await scope.trx.rawQuery(
          `select legal_entity_id from fiscal_submissions where tenant_id = ? and id = ?`,
          [context.tenantId, id]
        )
      ).rows[0] as any
      if (!le) throw ApiError.notFound()
      const g = await scopesOf(scope)
      if (!covers(g.read, le.legal_entity_id) && !covers(g.manage, le.legal_entity_id))
        throw ApiError.notFound()
      return view(scope, id)
    })
  }

  /** Submissão de um documento (para a ficha da factura/nota). */
  forDocument(context: TenantContext, type: string, documentId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(documentId) || (type !== 'SALES_INVOICE' && type !== 'SALES_NOTE'))
        throw ApiError.notFound()
      const r = (
        await scope.trx.rawQuery(
          `select id, legal_entity_id from fiscal_submissions where tenant_id = ? and document_type = ? and document_id = ?`,
          [context.tenantId, type, documentId]
        )
      ).rows[0] as any
      if (!r) throw ApiError.notFound()
      const g = await scopesOf(scope)
      if (!covers(g.read, r.legal_entity_id) && !covers(g.manage, r.legal_entity_id))
        throw ApiError.notFound()
      return view(scope, r.id)
    })
  }

  /** Processar a fila vencida das entidades que gere (o mesmo que o agendador faz). */
  async processQueue(context: TenantContext) {
    const les = await runInTenant(context, async (scope) => {
      const g = await scopesOf(scope)
      if (g.manage.tenant) return null
      if (!g.manage.legalEntityIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não processa a fila fiscal.')
      return new Set(g.manage.legalEntityIds)
    })
    const done = await processFiscalQueue(context, 20, les)
    return { processed: done.length, results: done }
  }

  /** Processar já uma submissão (envio ou consulta), sem esperar pela hora marcada. */
  async processOne(context: TenantContext, id: string) {
    await this.manageable(context, id)
    const c = await claim(context, id, null)
    if (!c)
      throw ApiError.conflict(
        'INVALID_STATE',
        'Nada a processar agora (decidida, retida ou em envio).'
      )
    await run(context, c)
    return runInTenant(context, (scope) => view(scope, id))
  }

  /** Repetir uma submissão que esgotou as tentativas (com motivo). */
  requeue(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      await this.manageable(context, id)
      const r = (
        await scope.trx.rawQuery(
          `select * from fiscal_submissions where tenant_id = ? and id = ? for update`,
          [context.tenantId, id]
        )
      ).rows[0] as any
      if (Number(input.expectedVersion) !== Number(r.version))
        throw ApiError.versionConflict(Number(r.version))
      if (r.status !== 'FAILED')
        throw ApiError.conflict('INVALID_STATE', 'Só se repete uma submissão falhada.')
      const reason = reasonOf(input.reason)
      await setSubmission(
        scope,
        id,
        { status: r.request_id ? 'AWAITING' : 'QUEUED', failures: 0 },
        ['next_attempt_at = now()']
      )
      await attempt(
        scope,
        { id, attempts: Number(r.attempts) },
        'REQUEUE',
        'REQUEUED',
        null,
        reason
      )
      await audit(scope, {
        action: 'fiscal_submission.requeued',
        entityType: 'fiscal_submission',
        entityId: id,
        metadata: { document: r.document_number, reason },
      })
      return view(scope, id)
    })
  }

  private manageable(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      const r = (
        await scope.trx.rawQuery(
          `select legal_entity_id from fiscal_submissions where tenant_id = ? and id = ?`,
          [context.tenantId, id]
        )
      ).rows[0] as any
      if (!r) throw ApiError.notFound()
      const g = await scopesOf(scope)
      if (!covers(g.read, r.legal_entity_id) && !covers(g.manage, r.legal_entity_id))
        throw ApiError.notFound()
      if (!covers(g.manage, r.legal_entity_id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a integração fiscal desta entidade.')
    })
  }
}
