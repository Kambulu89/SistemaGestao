import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { costCentersByCode } from '#modules/organization/index'
import { tenantSettings } from '#modules/settings/index'
import { createEntryInScope } from '#modules/accounting/application/entries_service'
import { formatDecimal, parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Importação de saldos de abertura (6.4): linhas por **código** de conta (como vêm de uma folha de cálculo ou do
 * sistema anterior), validadas todas de uma vez e equilibradas; geram um lançamento em rascunho no período de abertura
 * do exercício, que segue o fluxo normal (submeter, aprovar, contabilizar). Um por exercício.
 */
export interface OpeningLineInput {
  accountCode?: unknown
  debit?: unknown
  credit?: unknown
  costCenterCode?: unknown
  thirdPartyRef?: unknown
  description?: unknown
}

const text = (v: unknown) =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
const blank = (v: unknown) => v === undefined || v === null || text(v) === '' || text(v) === '0'

async function context(scope: TenantScope, fiscalYearId: string, journalId: string) {
  const y = await scope.trx.rawQuery(
    `select y.id, y.legal_entity_id, y.code, y.start_date::text as start_date, y.status, p.id as period_id, p.status as period_status
       from fiscal_years y join fiscal_periods p on p.tenant_id = y.tenant_id and p.fiscal_year_id = y.id and p.kind = 'OPENING'
      where y.tenant_id = ? and y.id = ?`,
    [scope.context.tenantId, fiscalYearId]
  )
  const year = y.rows[0] as
    | {
        id: string
        legal_entity_id: string
        code: string
        start_date: string
        status: string
        period_id: string
        period_status: string
      }
    | undefined
  if (!year) throw ApiError.notFound()
  const j = await scope.trx.rawQuery(
    'select id, legal_entity_id, status from journals where tenant_id = ? and id = ?',
    [scope.context.tenantId, journalId]
  )
  const journal = j.rows[0] as { id: string; legal_entity_id: string; status: string } | undefined
  if (!journal || journal.legal_entity_id !== year.legal_entity_id || journal.status !== 'ACTIVE')
    throw ApiError.validation([
      { path: 'journalId', code: 'NOT_FOUND', message: 'Diário activo da entidade do exercício.' },
    ])
  return { year, journal }
}

/** Valida todas as linhas e devolve-as resolvidas (ids) com os problemas por linha e os totais. */
async function resolve(scope: TenantScope, legalEntityId: string, raw: unknown) {
  const issues: ErrorDetail[] = []
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique as linhas a importar.' })
    return { issues, lines: [], debit: '0', credit: '0' }
  }
  if (raw.length > 5000)
    issues.push({
      path: 'lines',
      code: 'TOO_MANY',
      message: 'No máximo 5000 linhas por importação.',
    })
  const scale = (await tenantSettings(scope)).amountScale
  const accounts = await scope.trx.rawQuery(
    `select a.id, a.code, a.postable, a.status, a.requires_cost_center, a.requires_third_party
       from accounts a join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
      where a.tenant_id = ? and c.legal_entity_id = ? and c.status = 'ACTIVE'`,
    [scope.context.tenantId, legalEntityId]
  )
  const byCode = new Map(
    (
      accounts.rows as {
        id: string
        code: string
        postable: boolean
        status: string
        requires_cost_center: boolean
        requires_third_party: boolean
      }[]
    ).map((a) => [a.code, a])
  )
  if (byCode.size === 0)
    issues.push({
      path: 'lines',
      code: 'NO_CHART',
      message: 'A entidade legal não tem plano de contas activo.',
    })
  const centers = await costCentersByCode(scope, legalEntityId, [
    ...new Set((raw as OpeningLineInput[]).map((l) => text(l?.costCenterCode)).filter(Boolean)),
  ])
  const seen = new Map<string, number>()
  let debitTotal = 0n
  let creditTotal = 0n
  const lines = (raw as OpeningLineInput[]).slice(0, 5000).map((l, i) => {
    const path = `lines.${i}`
    const n = i + 1
    const code = text(l?.accountCode)
    const account = byCode.get(code)
    if (!account)
      issues.push({
        path: `${path}.accountCode`,
        code: 'ACCOUNT_NOT_FOUND',
        message: `Linha ${n}: conta "${code}" não existe no plano activo.`,
      })
    else if (!account.postable)
      issues.push({
        path: `${path}.accountCode`,
        code: 'NOT_POSTABLE',
        message: `Linha ${n}: a conta ${code} não é movimentável.`,
      })
    else if (account.status !== 'ACTIVE')
      issues.push({
        path: `${path}.accountCode`,
        code: 'ACCOUNT_INACTIVE',
        message: `Linha ${n}: a conta ${code} está inactiva.`,
      })
    const debit = blank(l?.debit) ? 0n : parseDecimal(text(l?.debit), scale)
    const credit = blank(l?.credit) ? 0n : parseDecimal(text(l?.credit), scale)
    if (debit === null || credit === null)
      issues.push({
        path: `${path}.${debit === null ? 'debit' : 'credit'}`,
        code: 'INVALID_AMOUNT',
        message: `Linha ${n}: valor positivo com até ${scale} casas decimais.`,
      })
    else if (debit > 0n === credit > 0n)
      issues.push({
        path: `${path}.debit`,
        code: 'ONE_SIDE',
        message: `Linha ${n}: saldo devedor ou credor (só um, maior que zero).`,
      })
    else {
      debitTotal += debit
      creditTotal += credit
    }
    const ccCode = text(l?.costCenterCode)
    const cc = ccCode ? centers.get(ccCode) : undefined
    if (ccCode && (!cc || cc.status !== 'ACTIVE'))
      issues.push({
        path: `${path}.costCenterCode`,
        code: 'NOT_FOUND',
        message: `Linha ${n}: centro de custo "${ccCode}" inexistente ou inactivo.`,
      })
    const thirdPartyRef = text(l?.thirdPartyRef).slice(0, 60) || null
    if (account?.requires_cost_center && !ccCode)
      issues.push({
        path: `${path}.costCenterCode`,
        code: 'COST_CENTER_REQUIRED',
        message: `Linha ${n}: a conta ${code} exige centro de custo.`,
      })
    if (account?.requires_third_party && !thirdPartyRef)
      issues.push({
        path: `${path}.thirdPartyRef`,
        code: 'THIRD_PARTY_REQUIRED',
        message: `Linha ${n}: a conta ${code} exige terceiro.`,
      })
    // A mesma conta, centro e terceiro repetidos são quase sempre um erro de exportação: avisa-se como erro.
    const dup = `${code}|${ccCode}|${thirdPartyRef ?? ''}`
    if (seen.has(dup))
      issues.push({
        path: `${path}.accountCode`,
        code: 'DUPLICATE',
        message: `Linha ${n}: repete a linha ${seen.get(dup)} (mesma conta, centro e terceiro).`,
      })
    else seen.set(dup, n)
    return {
      accountId: account?.id ?? null,
      accountCode: code,
      description: text(l?.description).slice(0, 300) || null,
      debit: debit && debit > 0n ? formatDecimal(debit, scale) : null,
      credit: credit && credit > 0n ? formatDecimal(credit, scale) : null,
      costCenterId: cc?.id ?? null,
      thirdPartyRef,
    }
  })
  if (debitTotal !== creditTotal)
    issues.push({
      path: 'lines',
      code: 'UNBALANCED',
      message: `Saldos desequilibrados: devedores ${formatDecimal(debitTotal, scale)}, credores ${formatDecimal(creditTotal, scale)}.`,
    })
  return {
    issues,
    lines,
    debit: formatDecimal(debitTotal, scale),
    credit: formatDecimal(creditTotal, scale),
  }
}

async function existingOpening(scope: TenantScope, fiscalYearId: string) {
  const r = await scope.trx.rawQuery(
    `select id, status, number from journal_entries
      where tenant_id = ? and fiscal_year_id = ? and source = 'OPENING_BALANCE' and reversed_by_id is null
      order by created_at desc limit 1`,
    [scope.context.tenantId, fiscalYearId]
  )
  return (r.rows[0] as { id: string; status: string; number: string | null } | undefined) ?? null
}

export class OpeningBalanceService {
  /** Verificação sem gravar: problemas por linha e totais. */
  validate(ctx: TenantContext, input: { fiscalYearId: string; journalId: string; lines: unknown }) {
    return runInTenant(ctx, async (scope) => {
      const { year } = await context(scope, input.fiscalYearId, input.journalId)
      const r = await resolve(scope, year.legal_entity_id, input.lines)
      const existing = await existingOpening(scope, year.id)
      if (existing)
        r.issues.unshift({
          path: 'fiscalYearId',
          code: 'OPENING_EXISTS',
          message: 'Este exercício já tem saldos de abertura importados.',
        })
      return { ...r, existingEntryId: existing?.id ?? null }
    })
  }

  /**
   * Importa (tudo ou nada) num lançamento em rascunho no período de abertura. Bloqueio consultivo por exercício: duas
   * importações simultâneas não criam dois lançamentos. Depois de estornado o anterior, pode importar-se de novo.
   */
  import(
    ctx: TenantContext,
    input: { fiscalYearId: string; journalId: string; lines: unknown; description?: string | null }
  ) {
    return runInTenant(ctx, async (scope) => {
      const { year, journal } = await context(scope, input.fiscalYearId, input.journalId)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `${ctx.tenantId}:opening:${year.id}`,
      ])
      const existing = await existingOpening(scope, year.id)
      if (existing)
        throw new ApiError(
          409,
          'OPENING_EXISTS',
          'Este exercício já tem saldos de abertura importados. Elimine o rascunho ou estorne o lançamento antes de importar de novo.',
          [{ path: 'fiscalYearId', code: 'OPENING_EXISTS', message: existing.id }]
        )
      const r = await resolve(scope, year.legal_entity_id, input.lines)
      if (r.issues.length > 0) throw ApiError.validation(r.issues)
      const { entry } = await createEntryInScope(
        scope,
        {
          legalEntityId: year.legal_entity_id,
          journalId: journal.id,
          entryDate: year.start_date,
          periodId: year.period_id,
          description: (input.description ?? '').trim() || `Saldos de abertura ${year.code}`,
          reference: `ABERTURA ${year.code}`,
          sourceRef: year.code,
          lines: r.lines,
        },
        'OPENING_BALANCE'
      )
      return entry
    })
  }
}
