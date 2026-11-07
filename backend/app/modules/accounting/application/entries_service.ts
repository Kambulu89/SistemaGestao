import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { costCenterFacts, legalEntityFacts } from '#modules/organization/index'
import { rateOn, reserveDocumentNumber, tenantSettings } from '#modules/settings/index'
import {
  checkBalancedEntry,
  normalizeLines,
  RATE_SCALE,
  STORAGE_SCALE,
  type AccountFacts,
  type Line,
} from '#modules/accounting/domain/accounting'
import { formatDecimal, multiply, parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Lançamentos: rascunho → submetido → aprovado → contabilizado. Só o rascunho se edita; contabilizado é imutável
 * (também por trigger) e corrige-se por estorno. O número vem da série do diário no momento da contabilização.
 */
export type EntryStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED'

const ISO = /^\d{4}-\d{2}-\d{2}$/
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

interface EntryRow {
  id: string
  version: number
  legal_entity_id: string
  chart_id: string
  fiscal_year_id: string
  period_id: string
  journal_id: string
  number: string | null
  entry_date: string
  currency: string
  exchange_rate: string
  status: EntryStatus
  created_by: string | null
  submitted_by: string | null
  reversal_of_id: string | null
  reversed_by_id: string | null
  description: string
}

const HEADER = `e.id, e.version, e.legal_entity_id, e.chart_id, e.fiscal_year_id, e.period_id, e.journal_id, e.number,
  e.entry_date::text as entry_date, e.document_date::text as document_date, e.reference, e.description, e.currency,
  e.exchange_rate::text as exchange_rate, e.source, e.source_ref, e.idempotency_key, e.status,
  round(e.total_debit, ?::int)::text as total_debit, round(e.total_credit, ?::int)::text as total_credit, e.created_by, e.created_at,
  e.submitted_by, e.submitted_at, e.approved_by, e.approved_at, e.posted_by, e.posted_at, e.rejection_reason,
  e.reversal_of_id, e.reversed_by_id, j.code as journal_code, j.name as journal_name, p.name as period_name,
  p.status as period_status, y.code as fiscal_year_code`

const FROM = `from journal_entries e
  join journals j on j.tenant_id = e.tenant_id and j.id = e.journal_id
  join fiscal_periods p on p.tenant_id = e.tenant_id and p.id = e.period_id
  join fiscal_years y on y.tenant_id = e.tenant_id and y.id = e.fiscal_year_id`

function view(r: Record<string, any>) {
  return {
    id: r.id,
    version: r.version,
    legalEntityId: r.legal_entity_id,
    chartId: r.chart_id,
    fiscalYearId: r.fiscal_year_id,
    fiscalYearCode: r.fiscal_year_code,
    periodId: r.period_id,
    periodName: r.period_name,
    periodStatus: r.period_status,
    journalId: r.journal_id,
    journalCode: r.journal_code,
    journalName: r.journal_name,
    number: r.number,
    entryDate: r.entry_date,
    documentDate: r.document_date,
    reference: r.reference,
    description: r.description,
    currency: r.currency,
    exchangeRate: r.exchange_rate,
    source: r.source,
    sourceRef: r.source_ref,
    idempotencyKey: r.idempotency_key,
    status: r.status as EntryStatus,
    totalDebit: r.total_debit,
    totalCredit: r.total_credit,
    createdBy: r.created_by,
    createdAt: r.created_at,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    postedBy: r.posted_by,
    postedAt: r.posted_at,
    rejectionReason: r.rejection_reason,
    reversalOfId: r.reversal_of_id,
    reversedById: r.reversed_by_id,
  }
}

/** Montantes devolvidos na precisão da empresa (guardados com 6 casas). */
async function scaleOf(scope: TenantScope) {
  return (await tenantSettings(scope)).amountScale
}

async function loadEntry(scope: TenantScope, id: string, lock = false) {
  const scale = await scaleOf(scope)
  const r = await scope.trx.rawQuery(
    `select ${HEADER} ${FROM} where e.tenant_id = ? and e.id = ?${lock ? ' for update of e' : ''}`,
    [scale, scale, scope.context.tenantId, id]
  )
  return (r.rows[0] as (EntryRow & Record<string, any>) | undefined) ?? null
}

async function linesOf(scope: TenantScope, entryId: string) {
  const r = await scope.trx.rawQuery(
    `select l.id, l.line_no as "lineNo", l.account_id as "accountId", a.code as "accountCode", a.name as "accountName",
            l.description, round(l.debit, ?::int)::text as debit, round(l.credit, ?::int)::text as credit,
            round(l.debit_functional, ?::int)::text as "debitFunctional",
            round(l.credit_functional, ?::int)::text as "creditFunctional",
            l.cost_center_id as "costCenterId", l.third_party_ref as "thirdPartyRef"
       from journal_lines l join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ? and l.entry_id = ? order by l.line_no`,
    [...Array(4).fill(await scaleOf(scope)), scope.context.tenantId, entryId]
  )
  return r.rows as {
    accountId: string
    debit: string
    credit: string
    costCenterId: string | null
    thirdPartyRef: string | null
    description: string | null
    lineNo: number
  }[]
}

async function detail(scope: TenantScope, id: string) {
  const row = await loadEntry(scope, id)
  if (!row) throw ApiError.notFound()
  return { ...view(row), lines: await linesOf(scope, id) }
}

/** Contas referidas pelas linhas (para as regras de submissão). */
async function accountFacts(scope: TenantScope, ids: string[]) {
  if (ids.length === 0) return new Map<string, AccountFacts>()
  const r = await scope.trx.rawQuery(
    `select id, chart_id as "chartId", code, postable, status, requires_cost_center as "requiresCostCenter",
            requires_third_party as "requiresThirdParty"
       from accounts where tenant_id = ? and id = any(?::uuid[])`,
    [scope.context.tenantId, ids]
  )
  return new Map((r.rows as AccountFacts[]).map((a) => [a.id, a]))
}

/** Período onde cabe a data: o indicado (tem de conter a data) ou o período normal que a contém. */
async function resolvePeriod(
  scope: TenantScope,
  legalEntityId: string,
  date: string,
  periodId?: string
) {
  const r = await scope.trx.rawQuery(
    `select p.id, p.status, p.kind, y.id as fiscal_year_id, y.status as year_status
       from fiscal_periods p join fiscal_years y on y.tenant_id = p.tenant_id and y.id = p.fiscal_year_id
      where p.tenant_id = ? and y.legal_entity_id = ? and ?::date between p.start_date and p.end_date
        and ${periodId ? 'p.id = ?' : `p.kind = 'NORMAL'`}`,
    (periodId
      ? [scope.context.tenantId, legalEntityId, date, periodId]
      : [scope.context.tenantId, legalEntityId, date]) as never[]
  )
  return (
    (r.rows[0] as
      { id: string; status: string; fiscal_year_id: string; year_status: string } | undefined) ??
    null
  )
}

async function assertPeriodOpen(scope: TenantScope, periodId: string) {
  const r = await scope.trx.rawQuery(
    `select p.status, y.status as year_status from fiscal_periods p
       join fiscal_years y on y.tenant_id = p.tenant_id and y.id = p.fiscal_year_id
      where p.tenant_id = ? and p.id = ?
      for share of p`,
    [scope.context.tenantId, periodId]
  )
  // FOR SHARE: fechar o período (FOR UPDATE, também no encerramento do exercício) espera por quem está a
  // contabilizar e vice-versa, por isso nunca fica um lançamento contabilizado num período que outra transacção acabou
  // de fechar.
  const p = r.rows[0] as { status: string; year_status: string } | undefined
  if (!p || p.status !== 'OPEN' || p.year_status !== 'OPEN')
    throw ApiError.conflict('PERIOD_CLOSED', 'O período do lançamento está fechado.')
}

interface Header {
  legalEntityId: string
  chartId: string
  fiscalYearId: string
  periodId: string
  journalId: string
  entryDate: string
  documentDate: string | null
  reference: string | null
  description: string
  currency: string
  exchangeRate: bigint
}

/** Valida e completa o cabeçalho (criação: tudo; alteração: sobre o actual). */
async function resolveHeader(
  scope: TenantScope,
  input: Record<string, unknown>,
  current: EntryRow | null
) {
  const issues: ErrorDetail[] = []
  const legalEntityId = current ? current.legal_entity_id : text(input.legalEntityId)
  if (
    current &&
    input.legalEntityId !== undefined &&
    input.legalEntityId !== current.legal_entity_id
  )
    issues.push({ path: 'legalEntityId', code: 'IMMUTABLE', message: 'A entidade legal não muda.' })
  const le = legalEntityId ? await legalEntityFacts(scope, legalEntityId) : null
  if (!le) {
    issues.push({
      path: 'legalEntityId',
      code: 'NOT_FOUND',
      message: 'Entidade legal inexistente.',
    })
    return { issues, header: null }
  }
  const chart = await scope.trx.rawQuery(
    `select id from account_charts where tenant_id = ? and legal_entity_id = ? and status = 'ACTIVE'`,
    [scope.context.tenantId, le.id]
  )
  const chartId = (chart.rows[0] as { id: string } | undefined)?.id
  if (!chartId)
    issues.push({
      path: 'legalEntityId',
      code: 'NO_CHART',
      message: 'A entidade legal não tem plano de contas activo.',
    })

  const journalId =
    input.journalId !== undefined ? text(input.journalId) : (current?.journal_id ?? '')
  const journal = journalId
    ? ((
        await scope.trx.rawQuery(
          `select id, legal_entity_id, status from journals where tenant_id = ? and id = ?`,
          [scope.context.tenantId, journalId]
        )
      ).rows[0] as { id: string; legal_entity_id: string; status: string } | undefined)
    : undefined
  if (!journal || journal.legal_entity_id !== le.id)
    issues.push({
      path: 'journalId',
      code: 'NOT_FOUND',
      message: 'Diário inexistente nesta entidade legal.',
    })
  else if (journal.status !== 'ACTIVE')
    issues.push({ path: 'journalId', code: 'INACTIVE', message: 'O diário está inactivo.' })

  const entryDate =
    input.entryDate !== undefined ? text(input.entryDate) : (current?.entry_date ?? '')
  let period: Awaited<ReturnType<typeof resolvePeriod>> = null
  if (!ISO.test(entryDate))
    issues.push({
      path: 'entryDate',
      code: 'REQUIRED',
      message: 'Data do lançamento (AAAA-MM-DD).',
    })
  else {
    const wanted = input.periodId !== undefined ? text(input.periodId) || undefined : undefined
    period = await resolvePeriod(scope, le.id, entryDate, wanted)
    if (!period)
      issues.push({
        path: wanted ? 'periodId' : 'entryDate',
        code: 'NO_PERIOD',
        message: wanted
          ? 'O período não contém esta data.'
          : 'Não há exercício aberto para esta data.',
      })
  }
  const documentDate =
    input.documentDate !== undefined
      ? text(input.documentDate) || null
      : ((current as any)?.document_date ?? null)
  if (documentDate && !ISO.test(documentDate))
    issues.push({ path: 'documentDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  const description =
    input.description !== undefined ? text(input.description) : (current?.description ?? '')
  if (description.length < 3 || description.length > 500)
    issues.push({
      path: 'description',
      code: 'REQUIRED',
      message: 'Descrição de 3 a 500 caracteres.',
    })
  const reference =
    input.reference !== undefined
      ? text(input.reference).slice(0, 80) || null
      : ((current as any)?.reference ?? null)

  const currency = (
    input.currency !== undefined
      ? text(input.currency)
      : (current?.currency ?? le.functionalCurrency)
  ).toUpperCase()
  let rate: bigint | null = null
  if (!/^[A-Z]{3}$/.test(currency))
    issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda ISO 4217.' })
  else if (currency === le.functionalCurrency) {
    rate = 10n ** BigInt(RATE_SCALE)
    if (
      input.exchangeRate !== undefined &&
      input.exchangeRate !== null &&
      parseDecimal(input.exchangeRate, RATE_SCALE) !== rate
    )
      issues.push({
        path: 'exchangeRate',
        code: 'MUST_BE_ONE',
        message: 'Na moeda funcional o câmbio é 1.',
      })
  } else if (
    input.exchangeRate !== undefined &&
    input.exchangeRate !== null &&
    input.exchangeRate !== ''
  ) {
    rate = parseDecimal(input.exchangeRate, RATE_SCALE)
    if (!rate)
      issues.push({
        path: 'exchangeRate',
        code: 'INVALID',
        message: 'Câmbio positivo (até 10 casas).',
      })
  } else if (current && input.currency === undefined) {
    rate = parseDecimal(current.exchange_rate, RATE_SCALE)
  } else if (ISO.test(entryDate)) {
    const found = await rateOn(scope, currency, le.functionalCurrency, entryDate)
    rate = found ? parseDecimal(found.rate, RATE_SCALE) : null
    if (!rate)
      issues.push({
        path: 'exchangeRate',
        code: 'RATE_NOT_FOUND',
        message: `Sem câmbio ${currency}→${le.functionalCurrency} em vigor; indique-o.`,
      })
  }
  if (issues.length > 0) return { issues, header: null }
  const header: Header = {
    legalEntityId: le.id,
    chartId: chartId!,
    fiscalYearId: period!.fiscal_year_id,
    periodId: period!.id,
    journalId: journal!.id,
    entryDate,
    documentDate,
    reference,
    description,
    currency,
    exchangeRate: rate!,
  }
  return { issues, header }
}

async function checkCostCenters(scope: TenantScope, lines: Line[], legalEntityId: string) {
  const ids = [...new Set(lines.map((l) => l.costCenterId).filter((x): x is string => !!x))]
  const facts = await costCenterFacts(scope, ids)
  const issues: ErrorDetail[] = []
  lines.forEach((l, i) => {
    if (!l.costCenterId) return
    const cc = facts.get(l.costCenterId)
    if (!cc || cc.legalEntityId !== legalEntityId)
      issues.push({
        path: `lines.${i}.costCenterId`,
        code: 'NOT_FOUND',
        message: 'Centro de custo inexistente nesta entidade legal.',
      })
    else if (cc.status !== 'ACTIVE')
      issues.push({
        path: `lines.${i}.costCenterId`,
        code: 'INACTIVE',
        message: 'Centro de custo inactivo.',
      })
  })
  return issues
}

async function conversion(scope: TenantScope, rate: bigint) {
  const settings = await tenantSettings(scope)
  return { rate, scale: settings.amountScale, rounding: settings.roundingMode }
}

async function writeLines(
  scope: TenantScope,
  entryId: string,
  lines: Line[],
  conv: { rate: bigint; scale: number; rounding: 'HALF_UP' | 'HALF_EVEN' }
) {
  await scope.trx.rawQuery('delete from journal_lines where tenant_id = ? and entry_id = ?', [
    scope.context.tenantId,
    entryId,
  ])
  let debit = 0n
  let credit = 0n
  for (const l of lines) {
    const df = multiply(l.debit, STORAGE_SCALE, conv.rate, RATE_SCALE, conv.scale, conv.rounding)
    const cf = multiply(l.credit, STORAGE_SCALE, conv.rate, RATE_SCALE, conv.scale, conv.rounding)
    debit += df
    credit += cf
    await scope.trx.rawQuery(
      `insert into journal_lines (tenant_id, created_by, updated_by, entry_id, line_no, account_id, description, debit, credit,
         debit_functional, credit_functional, cost_center_id, third_party_ref)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        scope.context.userId,
        scope.context.userId,
        entryId,
        l.lineNo,
        l.accountId,
        l.description,
        formatDecimal(l.debit, STORAGE_SCALE),
        formatDecimal(l.credit, STORAGE_SCALE),
        formatDecimal(df, conv.scale),
        formatDecimal(cf, conv.scale),
        l.costCenterId,
        l.thirdPartyRef,
      ] as never[]
    )
  }
  await scope.trx.rawQuery(
    `update journal_entries set total_debit = ?, total_credit = ? where tenant_id = ? and id = ?`,
    [
      formatDecimal(debit, conv.scale),
      formatDecimal(credit, conv.scale),
      scope.context.tenantId,
      entryId,
    ]
  )
}

/** Linhas gravadas → linhas do domínio (para validar antes de submeter/contabilizar). */
function storedLines(rows: Awaited<ReturnType<typeof linesOf>>): Line[] {
  return rows.map((r) => ({
    lineNo: r.lineNo,
    accountId: r.accountId,
    description: r.description,
    debit: parseDecimal(r.debit, STORAGE_SCALE)!,
    credit: parseDecimal(r.credit, STORAGE_SCALE)!,
    costCenterId: r.costCenterId,
    thirdPartyRef: r.thirdPartyRef,
  }))
}

async function assertPostingRules(scope: TenantScope, entry: EntryRow) {
  const lines = storedLines(await linesOf(scope, entry.id))
  const accounts = await accountFacts(scope, [...new Set(lines.map((l) => l.accountId))])
  const conv = await conversion(scope, parseDecimal(entry.exchange_rate, RATE_SCALE)!)
  const { issues } = checkBalancedEntry(lines, accounts, entry.chart_id, conv)
  issues.push(...(await checkCostCenters(scope, lines, entry.legal_entity_id)))
  if (issues.length > 0) throw ApiError.validation(issues)
  return { lines, conv }
}

function expectStatus(
  entry: EntryRow,
  expectedVersion: number | undefined,
  ...allowed: EntryStatus[]
) {
  if (!allowed.includes(entry.status))
    throw ApiError.conflict('INVALID_STATUS', `Operação impossível no estado ${entry.status}.`)
  if (expectedVersion !== undefined && expectedVersion !== entry.version)
    throw ApiError.versionConflict(entry.version)
}

async function setStatus(scope: TenantScope, id: string, sql: string, params: unknown[]) {
  await scope.trx.rawQuery(
    `update journal_entries set ${sql}, updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
    [...params, scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

export class JournalEntryService {
  list(
    context: TenantContext,
    filter: {
      legalEntityId?: string
      status?: string
      journalId?: string
      periodId?: string
      fiscalYearId?: string
      q?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const where = ['e.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      for (const [key, column] of [
        ['legalEntityId', 'e.legal_entity_id'],
        ['status', 'e.status'],
        ['journalId', 'e.journal_id'],
        ['periodId', 'e.period_id'],
        ['fiscalYearId', 'e.fiscal_year_id'],
      ] as const) {
        const v = filter[key]
        if (v) {
          where.push(`${column} = ?`)
          params.push(v)
        }
      }
      if (filter.q) {
        where.push(
          `(lower(e.description) like ? or lower(coalesce(e.reference,'')) like ? or lower(coalesce(e.number,'')) like ?)`
        )
        const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        params.push(like, like, like)
      }
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select ${HEADER} ${FROM} where ${clause} order by e.entry_date desc, e.created_at desc limit ? offset ?`,
        [...Array(2).fill(await scaleOf(scope)), ...params, filter.limit, filter.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from journal_entries e where ${clause}`,
        params as never[]
      )
      return { items: (rows.rows as any[]).map(view), total: (count.rows[0] as { n: number }).n }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  /**
   * Cria um rascunho. Com `idempotencyKey` repetida devolve o lançamento já criado com essa chave (`created: false`),
   * para que um pedido repetido (rede, integração) não duplique o lançamento.
   */
  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, (scope) => createEntryInScope(scope, input, 'MANUAL'))
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown> & { expectedVersion: number }
  ) {
    return runInTenant(context, async (scope) => {
      const entry = await loadEntry(scope, id, true)
      if (!entry) throw ApiError.notFound()
      expectStatus(entry, input.expectedVersion, 'DRAFT')
      const { issues, header } = await resolveHeader(scope, input, entry)
      const settings = await tenantSettings(scope)
      let lines: Line[] | null = null
      if (input.lines !== undefined) {
        const n = normalizeLines(input.lines, settings.amountScale)
        issues.push(...n.issues)
        lines = n.lines
        if (header) issues.push(...(await checkCostCenters(scope, lines, header.legalEntityId)))
      }
      if (issues.length > 0 || !header) throw ApiError.validation(issues)
      await setStatus(
        scope,
        id,
        `chart_id = ?, fiscal_year_id = ?, period_id = ?, journal_id = ?, entry_date = ?, document_date = ?, reference = ?,
         description = ?, currency = ?, exchange_rate = ?, rejection_reason = null`,
        [
          header.chartId,
          header.fiscalYearId,
          header.periodId,
          header.journalId,
          header.entryDate,
          header.documentDate,
          header.reference,
          header.description,
          header.currency,
          formatDecimal(header.exchangeRate, RATE_SCALE),
        ]
      )
      const conv = await conversion(scope, header.exchangeRate)
      // Linhas novas num rascunho: as imputações antigas (por n.º de linha) deixam de fazer sentido.
      if (lines)
        await scope.trx.rawQuery(
          'delete from journal_line_allocations where tenant_id = ? and entry_id = ?',
          [context.tenantId, id]
        )
      await writeLines(scope, id, lines ?? storedLines(await linesOf(scope, id)), conv)
      await audit(scope, {
        action: 'journal_entry.updated',
        entityType: 'journal_entry',
        entityId: id,
      })
      return detail(scope, id)
    })
  }

  remove(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const entry = await loadEntry(scope, id, true)
      if (!entry) throw ApiError.notFound()
      expectStatus(entry, undefined, 'DRAFT')
      await scope.trx.rawQuery('delete from journal_entries where tenant_id = ? and id = ?', [
        context.tenantId,
        id,
      ])
      await audit(scope, {
        action: 'journal_entry.deleted',
        entityType: 'journal_entry',
        entityId: id,
      })
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const entry = await loadEntry(scope, id, true)
      if (!entry) throw ApiError.notFound()
      expectStatus(entry, expectedVersion, 'DRAFT')
      await assertPeriodOpen(scope, entry.period_id)
      const { lines, conv } = await assertPostingRules(scope, entry)
      await writeLines(scope, id, lines, conv)
      await setStatus(scope, id, `status = 'SUBMITTED', submitted_by = ?, submitted_at = now()`, [
        context.userId,
      ])
      await audit(scope, {
        action: 'journal_entry.submitted',
        entityType: 'journal_entry',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'SUBMITTED' } },
      })
      return detail(scope, id)
    })
  }

  /** Segregação de funções: quem criou ou submeteu não aprova. */
  approve(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const entry = await loadEntry(scope, id, true)
      if (!entry) throw ApiError.notFound()
      expectStatus(entry, expectedVersion, 'SUBMITTED')
      if (entry.created_by === context.userId || entry.submitted_by === context.userId)
        throw ApiError.forbidden(
          'SEGREGATION_OF_DUTIES',
          'Quem criou ou submeteu o lançamento não o pode aprovar.'
        )
      await assertPeriodOpen(scope, entry.period_id)
      await setStatus(scope, id, `status = 'APPROVED', approved_by = ?, approved_at = now()`, [
        context.userId,
      ])
      await audit(scope, {
        action: 'journal_entry.approved',
        entityType: 'journal_entry',
        entityId: id,
        changes: { status: { from: 'SUBMITTED', to: 'APPROVED' } },
      })
      return detail(scope, id)
    })
  }

  reject(context: TenantContext, id: string, expectedVersion: number, reason: string) {
    return runInTenant(context, async (scope) => {
      const entry = await loadEntry(scope, id, true)
      if (!entry) throw ApiError.notFound()
      expectStatus(entry, expectedVersion, 'SUBMITTED', 'APPROVED')
      if (entry.created_by === context.userId || entry.submitted_by === context.userId)
        throw ApiError.forbidden(
          'SEGREGATION_OF_DUTIES',
          'Quem criou ou submeteu o lançamento não o pode rejeitar.'
        )
      if (reason.trim().length < 5)
        throw ApiError.validation([
          { path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (5 caracteres ou mais).' },
        ])
      await setStatus(
        scope,
        id,
        `status = 'DRAFT', rejection_reason = ?, submitted_by = null, submitted_at = null, approved_by = null, approved_at = null`,
        [reason.trim().slice(0, 500)]
      )
      await audit(scope, {
        action: 'journal_entry.rejected',
        entityType: 'journal_entry',
        entityId: id,
        changes: { status: { from: entry.status, to: 'DRAFT' } },
        metadata: { reason: reason.trim() },
      })
      return detail(scope, id)
    })
  }

  /** Contabiliza: valida de novo (contas e período podem ter mudado), numera pela série do diário e fica imutável. */
  post(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const entry = await loadEntry(scope, id, true)
      if (!entry) throw ApiError.notFound()
      expectStatus(entry, expectedVersion, 'APPROVED')
      return postInScope(scope, entry)
    })
  }

  /**
   * Estorno: novo lançamento contabilizado com débitos e créditos trocados, no mesmo diário, numa data com período
   * aberto. O original fica ligado ao estorno e nunca é alterado de outra forma; cada lançamento só se estorna uma vez.
   */
  reverse(
    context: TenantContext,
    id: string,
    input: { date: string; description?: string | null }
  ) {
    return runInTenant(context, async (scope) => {
      const entry = await loadEntry(scope, id, true)
      if (!entry) throw ApiError.notFound()
      if (entry.source === MANAGED_SOURCE)
        throw ApiError.conflict(
          'MANAGED_BY_FIXED_ASSETS',
          'Lançamento dos activos fixos: anule-o na ficha do activo ou nas depreciações.'
        )
      if (entry.source === 'YEAR_CLOSE' || entry.source === 'YEAR_OPENING')
        throw ApiError.conflict(
          'MANAGED_BY_YEAR_CLOSE',
          'Lançamento do encerramento do exercício: anule-o reabrindo o exercício.'
        )
      return reverseInScope(scope, entry, input)
    })
  }
}

/** Lançamentos gerados pelos activos fixos: só se estornam por lá, para a ficha e o razão nunca divergirem. */
export const MANAGED_SOURCE = 'FIXED_ASSETS'

/** Estorno na transacção de quem chama (manual ou pelos activos fixos). */
export async function reverseInScope(
  scope: TenantScope,
  entry: EntryRow,
  input: { date: string; description?: string | null; periodId?: string }
) {
  const context = scope.context
  expectStatus(entry, undefined, 'POSTED')
  if (entry.reversed_by_id)
    throw ApiError.conflict('ALREADY_REVERSED', 'O lançamento já foi estornado.')
  if (entry.reversal_of_id)
    throw ApiError.conflict('IS_REVERSAL', 'Um estorno não se estorna; faça um novo lançamento.')
  if (!ISO.test(input.date) || input.date < entry.entry_date)
    throw ApiError.validation([
      {
        path: 'date',
        code: 'INVALID',
        message: 'Data do estorno igual ou posterior à do lançamento.',
      },
    ])
  const period = await resolvePeriod(scope, entry.legal_entity_id, input.date, input.periodId)
  if (!period)
    throw ApiError.validation([
      { path: 'date', code: 'NO_PERIOD', message: 'Não há exercício para esta data.' },
    ])
  await assertPeriodOpen(scope, period.id)
  const description = (
    text(input.description) || `Estorno de ${entry.number}: ${entry.description}`
  ).slice(0, 500)
  const r = await scope.trx.rawQuery(
    `insert into journal_entries (tenant_id, created_by, updated_by, legal_entity_id, chart_id, fiscal_year_id, period_id,
         journal_id, entry_date, reference, description, currency, exchange_rate, source, source_ref, reversal_of_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REVERSAL', ?, ?) returning id`,
    [
      context.tenantId,
      context.userId,
      context.userId,
      entry.legal_entity_id,
      entry.chart_id,
      period.fiscal_year_id,
      period.id,
      entry.journal_id,
      input.date,
      entry.number,
      description,
      entry.currency,
      entry.exchange_rate,
      entry.id,
      entry.id,
    ] as never[]
  )
  const reversalId = (r.rows[0] as { id: string }).id
  const lines = storedLines(await linesOf(scope, entry.id)).map((l) => ({
    ...l,
    debit: l.credit,
    credit: l.debit,
  }))
  await writeLines(
    scope,
    reversalId,
    lines,
    await conversion(scope, parseDecimal(entry.exchange_rate, RATE_SCALE)!)
  )
  const number = await numberFor(scope, entry.journal_id, input.date)
  await setStatus(
    scope,
    reversalId,
    `status = 'POSTED', number = ?, submitted_by = ?, submitted_at = now(), approved_by = ?, approved_at = now(),
       posted_by = ?, posted_at = now()`,
    [number, context.userId, context.userId, context.userId]
  )
  await scope.trx.rawQuery(
    `update journal_entries set reversed_by_id = ?, updated_at = now(), updated_by = ?, version = version + 1
        where tenant_id = ? and id = ?`,
    [reversalId, context.userId, context.tenantId, entry.id]
  )
  await audit(scope, {
    action: 'journal_entry.reversed',
    entityType: 'journal_entry',
    entityId: entry.id,
    metadata: { reversalId, reversalNumber: number },
  })
  await audit(scope, {
    action: 'journal_entry.posted',
    entityType: 'journal_entry',
    entityId: reversalId,
    changes: { number: { from: null, to: number } },
    metadata: { reversalOf: entry.id },
  })
  return detail(scope, reversalId)
}

async function numberFor(scope: TenantScope, journalId: string, date: string) {
  const r = await scope.trx.rawQuery(
    'select document_series_id from journals where tenant_id = ? and id = ?',
    [scope.context.tenantId, journalId]
  )
  const seriesId = (r.rows[0] as { document_series_id: string }).document_series_id
  return (await reserveDocumentNumber(scope, seriesId, date)).formatted
}

/**
 * Cria um rascunho na transacção de quem chama (lançamento manual ou motor de contabilização). Com `idempotencyKey`
 * repetida devolve o lançamento já criado com essa chave (`created: false`).
 */
export async function createEntryInScope(
  scope: TenantScope,
  input: Record<string, unknown>,
  source: string
): Promise<{ entry: Awaited<ReturnType<typeof detail>>; created: boolean }> {
  const key = text(input.idempotencyKey).slice(0, 120) || null
  if (key) {
    await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
      `${scope.context.tenantId}:je:${key}`,
    ])
    const existing = await scope.trx.rawQuery(
      'select id from journal_entries where tenant_id = ? and idempotency_key = ?',
      [scope.context.tenantId, key]
    )
    if (existing.rows.length > 0)
      return {
        entry: await detail(scope, (existing.rows[0] as { id: string }).id),
        created: false,
      }
  }
  const { issues, header } = await resolveHeader(scope, input, null)
  const settings = await tenantSettings(scope)
  const { lines, issues: lineIssues } = normalizeLines(input.lines ?? [], settings.amountScale)
  issues.push(...lineIssues)
  if (header) issues.push(...(await checkCostCenters(scope, lines, header.legalEntityId)))
  if (issues.length > 0 || !header) throw ApiError.validation(issues)
  const r = await scope.trx.rawQuery(
    `insert into journal_entries (tenant_id, created_by, updated_by, legal_entity_id, chart_id, fiscal_year_id, period_id,
       journal_id, entry_date, document_date, reference, description, currency, exchange_rate, source, source_ref, idempotency_key)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    [
      scope.context.tenantId,
      scope.context.userId,
      scope.context.userId,
      header.legalEntityId,
      header.chartId,
      header.fiscalYearId,
      header.periodId,
      header.journalId,
      header.entryDate,
      header.documentDate,
      header.reference,
      header.description,
      header.currency,
      formatDecimal(header.exchangeRate, RATE_SCALE),
      source,
      text(input.sourceRef).slice(0, 120) || null,
      key,
    ] as never[]
  )
  const id = (r.rows[0] as { id: string }).id
  await writeLines(scope, id, lines, await conversion(scope, header.exchangeRate))
  await audit(scope, {
    action: 'journal_entry.created',
    entityType: 'journal_entry',
    entityId: id,
    metadata: { lines: lines.length, idempotencyKey: key, source },
  })
  return { entry: await detail(scope, id), created: true }
}

/**
 * Contabiliza na transacção de quem chama: valida de novo (contas e período podem ter mudado), numera pela série do
 * diário e fica imutável. Usado pelo fluxo manual (depois de aprovado) e pelo motor de contabilização automática.
 */
export async function postInScope(scope: TenantScope, entry: EntryRow) {
  await assertPeriodOpen(scope, entry.period_id)
  const { lines, conv } = await assertPostingRules(scope, entry)
  await writeLines(scope, entry.id, lines, conv)
  const number = await numberFor(scope, entry.journal_id, entry.entry_date)
  await setStatus(
    scope,
    entry.id,
    `status = 'POSTED', number = ?, posted_by = ?, posted_at = now()`,
    [number, scope.context.userId]
  )
  await audit(scope, {
    action: 'journal_entry.posted',
    entityType: 'journal_entry',
    entityId: entry.id,
    changes: { status: { from: entry.status, to: 'POSTED' }, number: { from: null, to: number } },
  })
  return detail(scope, entry.id)
}

/** Lançamento (cabeçalho bloqueado) para o motor de contabilização. */
export { loadEntry as lockEntry }
