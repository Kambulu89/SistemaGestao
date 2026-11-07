import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import {
  crudFind,
  crudInsert,
  crudList,
  crudUpdate,
  type CrudSpec,
  type Row,
} from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit, diff } from '#modules/audit/index'
import { costCenterFacts, legalEntityFacts } from '#modules/organization/index'
import { tenantSettings } from '#modules/settings/index'
import { crud } from '#modules/accounting/application/setup_service'
import {
  createEntryInScope,
  lockEntry,
  postInScope,
} from '#modules/accounting/application/entries_service'
import {
  AMOUNT_KEY,
  buildLines,
  defaultKey,
  EVENT,
  fillTemplate,
  SOURCE,
  type PostingEvent,
  type RuleLine,
} from '#modules/accounting/domain/posting'
import {
  checkBalancedEntry,
  normalizeLines,
  RATE_SCALE,
} from '#modules/accounting/domain/accounting'
import { parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Motor de contabilização (6.3): regras configuradas pela empresa transformam eventos de negócio (origem + evento +
 * montantes nomeados) em lançamentos. Os módulos chamam `postAccountingEvent` na sua transacção; integrações
 * externas usam a API. Cada evento é idempotente pela chave (por omissão origem:evento:referência).
 */
export const RULE_SPEC = {
  table: 'posting_rules',
  columns: {
    legalEntityId: 'legal_entity_id',
    code: 'code',
    name: 'name',
    source: 'source',
    event: 'event',
    journalId: 'journal_id',
    autoPost: 'auto_post',
    descriptionTemplate: 'description_template',
    validFrom: 'valid_from',
    validTo: 'valid_to',
    status: 'status',
  },
  dateColumns: ['valid_from', 'valid_to'],
  searchColumns: ['code', 'name', 'source', 'event'],
  orderBy: 'source, event, valid_from desc',
  uniqueErrors: {
    posting_rules_code_unique: {
      code: 'RULE_CODE_TAKEN',
      message: 'Já existe uma regra com este código.',
    },
    posting_rules_no_overlap: {
      code: 'RULE_OVERLAP',
      message: 'Já existe uma regra activa para esta origem e evento numa data desta vigência.',
    },
  },
} satisfies CrudSpec

const ISO = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

async function ruleLines(
  scope: TenantScope,
  ruleId: string
): Promise<(RuleLine & { accountCode: string; accountName: string })[]> {
  const r = await scope.trx.rawQuery(
    `select l.line_no as "lineNo", l.side, l.account_id as "accountId", a.code as "accountCode", a.name as "accountName",
            l.amount_key as "amountKey", l.description, l.cost_center_id as "costCenterId",
            l.use_event_cost_center as "useEventCostCenter", l.use_event_third_party as "useEventThirdParty"
       from posting_rule_lines l join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ? and l.rule_id = ? order by l.line_no`,
    [scope.context.tenantId, ruleId]
  )
  return r.rows as never
}

async function ruleInUse(scope: TenantScope, ruleId: string) {
  const r = await scope.trx.rawQuery(
    'select 1 from posting_events where tenant_id = ? and rule_id = ? limit 1',
    [scope.context.tenantId, ruleId]
  )
  return r.rows.length > 0
}

/** Linhas da regra: duas ou mais, com débito e crédito, contas movimentáveis do plano activo da entidade. */
async function validateRuleLines(scope: TenantScope, legalEntityId: string, raw: unknown) {
  const issues: ErrorDetail[] = []
  const lines: RuleLine[] = []
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 50) {
    issues.push({ path: 'lines', code: 'MIN_LINES', message: 'Entre 2 e 50 linhas.' })
    return { issues, lines }
  }
  const accounts = await scope.trx.rawQuery(
    `select a.id, a.code, a.postable, a.status from accounts a
       join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
      where a.tenant_id = ? and c.legal_entity_id = ? and c.status = 'ACTIVE'`,
    [scope.context.tenantId, legalEntityId]
  )
  const byId = new Map(
    (accounts.rows as { id: string; code: string; postable: boolean; status: string }[]).map(
      (a) => [a.id, a]
    )
  )
  const centers = await costCenterFacts(
    scope,
    raw
      .map((l: any) => l?.costCenterId)
      .filter((x: unknown): x is string => typeof x === 'string' && UUID.test(x))
  )
  raw.forEach((l: any, i: number) => {
    const path = `lines.${i}`
    const side = l?.side
    if (side !== 'DEBIT' && side !== 'CREDIT')
      issues.push({ path: `${path}.side`, code: 'INVALID', message: 'Débito ou crédito.' })
    const account = typeof l?.accountId === 'string' ? byId.get(l.accountId) : undefined
    if (!account)
      issues.push({
        path: `${path}.accountId`,
        code: 'NOT_FOUND',
        message: 'Conta do plano activo desta entidade.',
      })
    else if (!account.postable || account.status !== 'ACTIVE')
      issues.push({
        path: `${path}.accountId`,
        code: 'NOT_POSTABLE',
        message: `A conta ${account.code} não é movimentável ou está inactiva.`,
      })
    const amountKey = text(l?.amountKey)
    if (!AMOUNT_KEY.test(amountKey))
      issues.push({
        path: `${path}.amountKey`,
        code: 'INVALID',
        message: 'Chave do montante: letras e números, começa por minúscula (ex.: total).',
      })
    const costCenterId =
      typeof l?.costCenterId === 'string' && l.costCenterId ? l.costCenterId : null
    if (costCenterId) {
      const cc = centers.get(costCenterId)
      if (!cc || cc.legalEntityId !== legalEntityId || cc.status !== 'ACTIVE')
        issues.push({
          path: `${path}.costCenterId`,
          code: 'NOT_FOUND',
          message: 'Centro de custo activo desta entidade.',
        })
    }
    for (const k of ['useEventCostCenter', 'useEventThirdParty'])
      if (l?.[k] !== undefined && typeof l[k] !== 'boolean')
        issues.push({ path: `${path}.${k}`, code: 'INVALID', message: 'Sim ou não.' })
    lines.push({
      lineNo: i + 1,
      side,
      accountId: l?.accountId,
      amountKey,
      description: text(l?.description).slice(0, 300) || null,
      costCenterId,
      useEventCostCenter: l?.useEventCostCenter === true,
      useEventThirdParty: l?.useEventThirdParty === true,
    })
  })
  if (!lines.some((l) => l.side === 'DEBIT') || !lines.some((l) => l.side === 'CREDIT'))
    issues.push({
      path: 'lines',
      code: 'ONE_SIDED',
      message: 'A regra precisa de linhas a débito e a crédito.',
    })
  return { issues, lines }
}

async function validateRule(
  scope: TenantScope,
  input: Record<string, unknown>,
  current: Row | null
) {
  const issues: ErrorDetail[] = []
  const values: Record<string, unknown> = {}
  const take = (k: string, v: unknown) => {
    if (input[k] !== undefined) values[k] = v
  }
  const used = current ? await ruleInUse(scope, current.id) : false
  for (const k of ['legalEntityId', 'code'])
    if (current && input[k] !== undefined && input[k] !== current[k])
      issues.push({ path: k, code: 'IMMUTABLE', message: 'Não se altera depois de criada.' })
  if (used)
    for (const k of ['source', 'event', 'journalId', 'validFrom', 'lines'])
      if (input[k] !== undefined && (k === 'lines' || input[k] !== current![k]))
        issues.push({
          path: k,
          code: 'RULE_IN_USE',
          message:
            'A regra já contabilizou eventos: feche a vigência (data fim) e crie uma nova regra.',
        })
  const legalEntityId = current ? (current.legalEntityId as string) : text(input.legalEntityId)
  const le = legalEntityId ? await legalEntityFacts(scope, legalEntityId) : null
  if (!le) {
    issues.push({
      path: 'legalEntityId',
      code: 'NOT_FOUND',
      message: 'Entidade legal inexistente.',
    })
    return { issues, values, lines: null }
  }
  const required = (k: string, ok: boolean, message: string) => {
    if (!current && (input[k] === undefined || input[k] === null || input[k] === ''))
      issues.push({ path: k, code: 'REQUIRED', message: 'Campo obrigatório.' })
    else if (input[k] !== undefined && !ok) issues.push({ path: k, code: 'INVALID', message })
  }
  if (!current) {
    values.legalEntityId = le.id
    required('code', /^[A-Za-z0-9._-]{1,30}$/.test(text(input.code)), 'Código: até 30 caracteres.')
    take('code', text(input.code))
  }
  required('name', text(input.name).length >= 2, 'Nome de 2 a 160 caracteres.')
  take('name', text(input.name).slice(0, 160))
  required(
    'source',
    SOURCE.test(text(input.source).toUpperCase()),
    'Origem: maiúsculas, números e _ (ex.: SALES_INVOICE).'
  )
  take('source', text(input.source).toUpperCase())
  required(
    'event',
    EVENT.test(text(input.event).toUpperCase()),
    'Evento: maiúsculas, números e _ (ex.: ISSUED).'
  )
  take('event', text(input.event).toUpperCase())
  if (input.journalId !== undefined || !current) {
    const j = await scope.trx.rawQuery(
      'select legal_entity_id, status from journals where tenant_id = ? and id = ?',
      [
        scope.context.tenantId,
        UUID.test(text(input.journalId))
          ? text(input.journalId)
          : '00000000-0000-0000-0000-000000000000',
      ]
    )
    const journal = j.rows[0] as { legal_entity_id: string; status: string } | undefined
    if (!journal || journal.legal_entity_id !== le.id || journal.status !== 'ACTIVE')
      issues.push({
        path: 'journalId',
        code: 'NOT_FOUND',
        message: 'Diário activo desta entidade legal.',
      })
    take('journalId', input.journalId)
  }
  if (input.autoPost !== undefined && typeof input.autoPost !== 'boolean')
    issues.push({ path: 'autoPost', code: 'INVALID', message: 'Sim ou não.' })
  take('autoPost', input.autoPost)
  take(
    'descriptionTemplate',
    input.descriptionTemplate === undefined
      ? undefined
      : text(input.descriptionTemplate).slice(0, 300) || null
  )
  required('validFrom', ISO.test(text(input.validFrom)), 'Data AAAA-MM-DD.')
  take('validFrom', text(input.validFrom))
  if (
    input.validTo !== undefined &&
    input.validTo !== null &&
    input.validTo !== '' &&
    !ISO.test(text(input.validTo))
  )
    issues.push({ path: 'validTo', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  take('validTo', input.validTo === '' ? null : input.validTo)
  const from = (values.validFrom ?? current?.validFrom) as string | undefined
  const to = (values.validTo !== undefined ? values.validTo : current?.validTo) as
    string | null | undefined
  if (from && to && to < from)
    issues.push({ path: 'validTo', code: 'RANGE', message: 'A data fim é anterior à data início.' })
  if (input.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(input.status as string))
    issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
  take('status', input.status)
  let lines: RuleLine[] | null = null
  if (input.lines !== undefined || !current) {
    const v = await validateRuleLines(scope, le.id, input.lines)
    issues.push(...v.issues)
    lines = v.lines
  }
  return { issues, values, lines }
}

async function writeRuleLines(scope: TenantScope, ruleId: string, lines: RuleLine[]) {
  await scope.trx.rawQuery('delete from posting_rule_lines where tenant_id = ? and rule_id = ?', [
    scope.context.tenantId,
    ruleId,
  ])
  for (const l of lines)
    await scope.trx.rawQuery(
      `insert into posting_rule_lines (tenant_id, created_by, updated_by, rule_id, line_no, side, account_id, amount_key,
         description, cost_center_id, use_event_cost_center, use_event_third_party)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        scope.context.userId,
        scope.context.userId,
        ruleId,
        l.lineNo,
        l.side,
        l.accountId,
        l.amountKey,
        l.description,
        l.costCenterId,
        l.useEventCostCenter,
        l.useEventThirdParty,
      ] as never[]
    )
}

export class PostingRuleService {
  list(
    context: TenantContext,
    filter: { equals: Record<string, unknown>; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, ({ trx }) => crudList(crud(context, trx), RULE_SPEC, filter))
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const row = await crudFind(crud(context, scope.trx), RULE_SPEC, id)
      if (!row) throw ApiError.notFound()
      return { ...row, inUse: await ruleInUse(scope, id), lines: await ruleLines(scope, id) }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { issues, values, lines } = await validateRule(scope, input, null)
      if (issues.length > 0) throw ApiError.validation(issues)
      const row = await crudInsert(crud(context, scope.trx), RULE_SPEC, values)
      await writeRuleLines(scope, row.id, lines!)
      await audit(scope, {
        action: 'posting_rule.created',
        entityType: 'posting_rule',
        entityId: row.id,
        changes: diff(null, row, Object.keys(RULE_SPEC.columns)),
        metadata: { lines: lines!.map((l) => `${l.side} ${l.amountKey}`) },
      })
      return { ...row, inUse: false, lines: await ruleLines(scope, row.id) }
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown> & { expectedVersion: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const current = await crudFind(s, RULE_SPEC, id, true)
      if (!current) throw ApiError.notFound()
      const { issues, values, lines } = await validateRule(scope, input, current)
      if (issues.length > 0) throw ApiError.validation(issues)
      const row =
        Object.keys(values).length > 0 || lines
          ? await crudUpdate(s, RULE_SPEC, id, input.expectedVersion, values)
          : current
      if (lines) await writeRuleLines(scope, id, lines)
      await audit(scope, {
        action: 'posting_rule.updated',
        entityType: 'posting_rule',
        entityId: id,
        changes: diff(current, row, Object.keys(RULE_SPEC.columns)),
        metadata: lines ? { lines: lines.map((l) => `${l.side} ${l.amountKey}`) } : undefined,
      })
      return { ...row, inUse: await ruleInUse(scope, id), lines: await ruleLines(scope, id) }
    })
  }
}

// ---------------------------------------------------------------- motor

export interface PostingEventInput {
  legalEntityId: string
  source: string
  event: string
  sourceRef: string
  occurredOn: string
  amounts: Record<string, unknown>
  currency?: string | null
  exchangeRate?: string | null
  costCenterId?: string | null
  thirdPartyRef?: string | null
  description?: string | null
  idempotencyKey?: string | null
}

function normalizeEvent(raw: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const e: PostingEventInput = {
    legalEntityId: text(raw.legalEntityId),
    source: text(raw.source).toUpperCase(),
    event: text(raw.event).toUpperCase(),
    sourceRef: text(raw.sourceRef).slice(0, 120),
    occurredOn: text(raw.occurredOn),
    amounts:
      raw.amounts && typeof raw.amounts === 'object' && !Array.isArray(raw.amounts)
        ? (raw.amounts as Record<string, unknown>)
        : {},
    currency: text(raw.currency).toUpperCase() || null,
    exchangeRate: text(raw.exchangeRate) || null,
    costCenterId: text(raw.costCenterId) || null,
    thirdPartyRef: text(raw.thirdPartyRef).slice(0, 60) || null,
    description: text(raw.description).slice(0, 500) || null,
    idempotencyKey: text(raw.idempotencyKey).slice(0, 120) || null,
  }
  if (!UUID.test(e.legalEntityId))
    issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade legal.' })
  if (!SOURCE.test(e.source))
    issues.push({ path: 'source', code: 'INVALID', message: 'Origem: maiúsculas, números e _.' })
  if (!EVENT.test(e.event))
    issues.push({ path: 'event', code: 'INVALID', message: 'Evento: maiúsculas, números e _.' })
  if (!e.sourceRef)
    issues.push({
      path: 'sourceRef',
      code: 'REQUIRED',
      message: 'Referência do documento de origem.',
    })
  if (!ISO.test(e.occurredOn))
    issues.push({ path: 'occurredOn', code: 'REQUIRED', message: 'Data do evento (AAAA-MM-DD).' })
  if (Object.keys(e.amounts).length === 0)
    issues.push({ path: 'amounts', code: 'REQUIRED', message: 'Montantes do evento.' })
  return { e, issues }
}

async function findRule(scope: TenantScope, e: PostingEventInput) {
  const r = await scope.trx.rawQuery(
    `select id, journal_id, auto_post, description_template from posting_rules
      where tenant_id = ? and legal_entity_id = ? and source = ? and event = ? and status = 'ACTIVE'
        and valid_from <= ?::date and (valid_to is null or valid_to >= ?::date)`,
    [scope.context.tenantId, e.legalEntityId, e.source, e.event, e.occurredOn, e.occurredOn]
  )
  return (
    (r.rows[0] as
      | { id: string; journal_id: string; auto_post: boolean; description_template: string | null }
      | undefined) ?? null
  )
}

/** Rascunho do lançamento que a regra produziria (sem gravar), com os problemas encontrados. */
async function plan(scope: TenantScope, e: PostingEventInput) {
  const rule = await findRule(scope, e)
  if (!rule)
    return {
      rule: null,
      input: null,
      issues: [
        {
          path: 'event',
          code: 'NO_RULE',
          message: `Não há regra activa para ${e.source}/${e.event} nesta entidade em ${e.occurredOn}.`,
        },
      ] as ErrorDetail[],
    }
  const settings = await tenantSettings(scope)
  const lines = await ruleLines(scope, rule.id)
  const event: PostingEvent = { ...e }
  const built = buildLines(lines, event, settings.amountScale)
  const description =
    e.description ??
    fillTemplate(rule.description_template ?? '{source} {event} {sourceRef}', event)
  return {
    rule,
    lines,
    issues: built.issues,
    input: {
      legalEntityId: e.legalEntityId,
      journalId: rule.journal_id,
      entryDate: e.occurredOn,
      reference: e.sourceRef,
      description,
      ...(e.currency ? { currency: e.currency } : {}),
      ...(e.exchangeRate ? { exchangeRate: e.exchangeRate } : {}),
      lines: built.lines,
      sourceRef: `${e.event}:${e.sourceRef}`,
    } as Record<string, unknown>,
  }
}

async function recordEvent(
  scope: TenantScope,
  e: PostingEventInput,
  key: string,
  outcome: {
    status: 'POSTED' | 'DRAFTED' | 'FAILED'
    ruleId: string | null
    entryId: string | null
    error: unknown
  }
) {
  const payload = JSON.stringify({
    amounts: e.amounts,
    currency: e.currency,
    exchangeRate: e.exchangeRate,
    costCenterId: e.costCenterId,
    thirdPartyRef: e.thirdPartyRef,
    description: e.description,
  })
  const r = await scope.trx.rawQuery(
    `insert into posting_events (tenant_id, created_by, updated_by, legal_entity_id, rule_id, source, event, source_ref,
       idempotency_key, occurred_on, status, entry_id, payload, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
     on conflict (tenant_id, idempotency_key) do update set status = excluded.status, rule_id = excluded.rule_id,
       entry_id = excluded.entry_id, payload = excluded.payload, error = excluded.error, attempts = posting_events.attempts + 1,
       updated_at = now(), updated_by = excluded.updated_by, version = posting_events.version + 1
     returning id`,
    [
      scope.context.tenantId,
      scope.context.userId,
      scope.context.userId,
      e.legalEntityId,
      outcome.ruleId,
      e.source,
      e.event,
      e.sourceRef,
      key,
      e.occurredOn,
      outcome.status,
      outcome.entryId,
      payload,
      outcome.error === null ? null : JSON.stringify(outcome.error),
    ] as never[]
  )
  return (r.rows[0] as { id: string }).id
}

async function eventView(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select p.id, p.version, p.legal_entity_id as "legalEntityId", p.rule_id as "ruleId", r.code as "ruleCode",
            p.source, p.event, p.source_ref as "sourceRef", p.idempotency_key as "idempotencyKey",
            p.occurred_on::text as "occurredOn", p.status, p.entry_id as "entryId", e.number as "entryNumber",
            e.status as "entryStatus", p.payload, p.error, p.attempts, p.created_at as "createdAt", p.updated_at as "updatedAt"
       from posting_events p
       left join posting_rules r on r.tenant_id = p.tenant_id and r.id = p.rule_id
       left join journal_entries e on e.tenant_id = p.tenant_id and e.id = p.entry_id
      where p.tenant_id = ? and p.id = ?`,
    [scope.context.tenantId, id]
  )
  return r.rows[0] as Record<string, unknown>
}

/**
 * Contabiliza um evento de negócio na transacção de quem chama (contrato para os outros módulos). Idempotente: o
 * mesmo evento (chave) devolve o resultado já registado sem novo lançamento. Lança `ApiError` se não houver regra ou
 * se o lançamento não for válido — quem chama decide se a sua operação falha com ele.
 */
export async function postAccountingEvent(scope: TenantScope, raw: Record<string, unknown>) {
  const { e, issues } = normalizeEvent(raw)
  if (issues.length > 0) throw ApiError.validation(issues)
  const key = e.idempotencyKey ?? defaultKey(e)
  await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
    `${scope.context.tenantId}:pe:${key}`,
  ])
  const existing = await scope.trx.rawQuery(
    `select id, status from posting_events where tenant_id = ? and idempotency_key = ?`,
    [scope.context.tenantId, key]
  )
  const previous = existing.rows[0] as { id: string; status: string } | undefined
  if (previous && previous.status !== 'FAILED')
    return { event: await eventView(scope, previous.id), replay: true }

  const p = await plan(scope, e)
  if (!p.rule || p.issues.length > 0) throw ApiError.validation(p.issues)
  const { entry } = await createEntryInScope(
    scope,
    { ...p.input!, idempotencyKey: `pe:${key}` },
    e.source
  )
  let status: 'POSTED' | 'DRAFTED' = 'DRAFTED'
  let entryView = entry
  if (p.rule.auto_post) {
    const locked = await lockEntry(scope, entry.id, true)
    entryView = await postInScope(scope, locked!)
    status = 'POSTED'
  }
  const id = await recordEvent(scope, e, key, {
    status,
    ruleId: p.rule.id,
    entryId: entry.id,
    error: null,
  })
  await audit(scope, {
    action: 'posting_event.processed',
    entityType: 'posting_event',
    entityId: id,
    metadata: {
      source: e.source,
      event: e.event,
      sourceRef: e.sourceRef,
      status,
      entryId: entry.id,
      number: entryView.number,
    },
  })
  return { event: await eventView(scope, id), replay: false }
}

export class PostingEngineService {
  /** Evento recebido pela API: em caso de erro, o evento fica registado como FAILED com a mensagem (e o erro sobe). */
  async submit(context: TenantContext, raw: Record<string, unknown>) {
    try {
      return await runInTenant(context, (scope) => postAccountingEvent(scope, raw))
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) throw error
      const { e, issues } = normalizeEvent(raw)
      if (issues.length === 0) {
        const key = e.idempotencyKey ?? defaultKey(e)
        await runInTenant(context, async (scope) => {
          // Só se regista a falha de um evento ainda não contabilizado (nunca se sobrepõe a um sucesso).
          const ok = await scope.trx.rawQuery(
            `select 1 from posting_events where tenant_id = ? and idempotency_key = ? and status <> 'FAILED'`,
            [context.tenantId, key]
          )
          if (ok.rows.length > 0 || !(await legalEntityFacts(scope, e.legalEntityId))) return
          const id = await recordEvent(scope, e, key, {
            status: 'FAILED',
            ruleId: (await findRule(scope, e))?.id ?? null,
            entryId: null,
            error: { code: error.code, message: error.message, details: error.details },
          })
          await audit(scope, {
            action: 'posting_event.failed',
            entityType: 'posting_event',
            entityId: id,
            metadata: {
              source: e.source,
              event: e.event,
              sourceRef: e.sourceRef,
              code: error.code,
            },
          })
        })
      }
      throw error
    }
  }

  /** Reprocessa um evento FAILED com o mesmo conteúdo (depois de corrigida a regra, o período ou as contas). */
  async retry(context: TenantContext, id: string) {
    const stored = await runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select legal_entity_id, source, event, source_ref, idempotency_key, occurred_on::text as occurred_on, status, payload
           from posting_events where tenant_id = ? and id = ?`,
        [context.tenantId, id]
      )
      return r.rows[0] as Record<string, any> | undefined
    })
    if (!stored) throw ApiError.notFound()
    if (stored.status !== 'FAILED')
      throw ApiError.conflict('NOT_FAILED', 'Só se reprocessam eventos que falharam.')
    return this.submit(context, {
      ...stored.payload,
      legalEntityId: stored.legal_entity_id,
      source: stored.source,
      event: stored.event,
      sourceRef: stored.source_ref,
      occurredOn: stored.occurred_on,
      idempotencyKey: stored.idempotency_key,
    })
  }

  /** Simulação: linhas que a regra produziria e os problemas, sem gravar nada. */
  simulate(context: TenantContext, raw: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { e, issues } = normalizeEvent(raw)
      if (issues.length > 0) throw ApiError.validation(issues)
      const p = await plan(scope, e)
      const result = {
        ruleId: p.rule?.id ?? null,
        lines: [] as Record<string, unknown>[],
        issues: p.issues,
      }
      if (!p.rule || !p.input) return result
      const accounts = new Map((p.lines ?? []).map((l) => [l.accountId, l]))
      result.lines = (p.input.lines as Record<string, unknown>[]).map((l) => ({
        ...l,
        accountCode: accounts.get(l.accountId as string)?.accountCode,
        accountName: accounts.get(l.accountId as string)?.accountName,
      }))
      if (p.issues.length === 0) {
        // Mesmas regras de partidas dobradas que a contabilização (moeda funcional com câmbio 1 na simulação
        // quando não há câmbio indicado: o equilíbrio na moeda do lançamento é o que a regra controla).
        const settings = await tenantSettings(scope)
        const { lines } = normalizeLines(p.input.lines, settings.amountScale)
        const facts = await scope.trx.rawQuery(
          `select a.id, a.chart_id as "chartId", a.code, a.postable, a.status, a.requires_cost_center as "requiresCostCenter",
                  a.requires_third_party as "requiresThirdParty"
             from accounts a where a.tenant_id = ? and a.id = any(?::uuid[])`,
          [context.tenantId, [...accounts.keys()]]
        )
        const chartId = (facts.rows[0] as { chartId: string } | undefined)?.chartId ?? ''
        const rate = parseDecimal(e.exchangeRate ?? '1', RATE_SCALE) ?? 10n ** BigInt(RATE_SCALE)
        result.issues.push(
          ...checkBalancedEntry(
            lines,
            new Map((facts.rows as any[]).map((a) => [a.id, a])),
            chartId,
            {
              rate,
              scale: settings.amountScale,
              rounding: settings.roundingMode,
            }
          ).issues
        )
      }
      return result
    })
  }

  list(
    context: TenantContext,
    filter: {
      status?: string
      source?: string
      legalEntityId?: string
      q?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const where = ['p.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (filter.status) {
        where.push('p.status = ?')
        params.push(filter.status)
      }
      if (filter.source) {
        where.push('p.source = ?')
        params.push(filter.source.toUpperCase())
      }
      if (filter.legalEntityId) {
        where.push('p.legal_entity_id = ?')
        params.push(filter.legalEntityId)
      }
      if (filter.q) {
        where.push('lower(p.source_ref) like ?')
        params.push(`%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      }
      const clause = where.join(' and ')
      const ids = await scope.trx.rawQuery(
        `select p.id from posting_events p where ${clause} order by p.updated_at desc limit ? offset ?`,
        [...params, filter.limit, filter.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from posting_events p where ${clause}`,
        params as never[]
      )
      const items = []
      for (const row of ids.rows as { id: string }[]) items.push(await eventView(scope, row.id))
      return { items, total: (count.rows[0] as { n: number }).n }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const v = await eventView(scope, id)
      if (!v) throw ApiError.notFound()
      return v
    })
  }
}
