import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import {
  crudFind,
  crudInsert,
  crudList,
  crudUpdate,
  type CrudScope,
  type CrudSpec,
  type Row,
} from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit, diff } from '#modules/audit/index'
import { entitlementsFor } from '#modules/subscription/index'
import { submitForSubject, type ApprovalOutcome } from '#modules/approvals/index'
import {
  CURRENCY,
  DOCUMENT_TYPE,
  ISO_DATE,
  formatDocumentNumber,
  normalizeRate,
} from '#modules/settings/domain/settings'
import {
  isValidIban,
  isValidSwift,
  maskIban,
  normalizeIban,
} from '#modules/settings/domain/banking'
import { tenantSettings } from '#modules/settings/application/company_service'

const crud = (context: TenantContext, trx: CrudScope['trx']): CrudScope => ({
  trx,
  tenantId: context.tenantId,
  userId: context.userId,
})

export const SETTINGS_SPECS = {
  exchangeRates: {
    table: 'exchange_rates',
    columns: {
      fromCurrency: 'from_currency',
      toCurrency: 'to_currency',
      rate: 'rate',
      validOn: 'valid_on',
      source: 'source',
    },
    dateColumns: ['valid_on'],
    searchColumns: ['from_currency', 'to_currency'],
    orderBy: 'valid_on desc, from_currency, to_currency',
    uniqueErrors: {
      exchange_rates_pair_date_unique: {
        code: 'RATE_EXISTS',
        message: 'Já existe câmbio para este par e data.',
      },
    },
  },
  documentSeries: {
    table: 'document_series',
    columns: {
      legalEntityId: 'legal_entity_id',
      branchId: 'branch_id',
      documentType: 'document_type',
      code: 'code',
      prefix: 'prefix',
      fiscalYear: 'fiscal_year',
      nextNumber: 'next_number',
      padding: 'padding',
      status: 'status',
      validFrom: 'valid_from',
      validTo: 'valid_to',
    },
    dateColumns: ['valid_from', 'valid_to'],
    searchColumns: ['code', 'document_type', 'prefix'],
    orderBy: 'document_type, code',
    uniqueErrors: {
      document_series_code_unique: {
        code: 'SERIES_CODE_TAKEN',
        message: 'Já existe esta série para o tipo e a entidade legal.',
      },
    },
  },
  calendars: {
    table: 'calendars',
    columns: {
      code: 'code',
      name: 'name',
      countryCode: 'country_code',
      province: 'province',
      legalEntityId: 'legal_entity_id',
      branchId: 'branch_id',
      weekendDays: 'weekend_days',
      status: 'status',
    },
    searchColumns: ['code', 'name'],
    orderBy: 'code',
    uniqueErrors: {
      calendars_code_unique: {
        code: 'CALENDAR_CODE_TAKEN',
        message: 'Já existe um calendário com este código.',
      },
    },
  },
  bankAccounts: {
    table: 'bank_accounts',
    columns: {
      legalEntityId: 'legal_entity_id',
      holderName: 'holder_name',
      bankName: 'bank_name',
      iban: 'iban',
      accountNumber: 'account_number',
      swiftBic: 'swift_bic',
      currency: 'currency',
      isDefault: 'is_default',
      status: 'status',
      approvalRequestId: 'approval_request_id',
    },
    searchColumns: ['holder_name', 'bank_name', 'iban', 'account_number'],
    orderBy: 'bank_name, holder_name',
    uniqueErrors: {
      bank_accounts_iban_unique: { code: 'IBAN_EXISTS', message: 'Este IBAN já está registado.' },
      bank_accounts_default_unique: {
        code: 'DEFAULT_EXISTS',
        message: 'Já existe uma conta por omissão nesta moeda.',
      },
    },
  },
} satisfies Record<string, CrudSpec>

export type SettingsKind = keyof typeof SETTINGS_SPECS
const ENTITY: Record<SettingsKind, string> = {
  exchangeRates: 'exchange_rate',
  documentSeries: 'document_series',
  calendars: 'calendar',
  bankAccounts: 'bank_account',
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const upper = (v: unknown) => text(v).toUpperCase()

async function existsIn(s: CrudScope, table: string, id: unknown) {
  if (!isUuid(id)) return false
  const r = await s.trx.rawQuery(
    `select legal_entity_id from ${table} where tenant_id = ? and id = ?`,
    [s.tenantId, id]
  )
  return (r.rows[0] as { legal_entity_id?: string } | undefined) ?? false
}

async function legalEntityExists(s: CrudScope, id: unknown) {
  if (!isUuid(id)) return false
  const r = await s.trx.rawQuery(
    `select status from legal_entities where tenant_id = ? and id = ?`,
    [s.tenantId, id]
  )
  return r.rows.length > 0
}

// ---------------------------------------------------------------- validações por tipo

async function validate(
  s: CrudScope,
  kind: SettingsKind,
  input: Record<string, unknown>,
  current: Row | null
) {
  const issues: ErrorDetail[] = []
  const values: Record<string, unknown> = {}
  const take = (key: string, value: unknown) => {
    if (input[key] !== undefined) values[key] = value
  }
  const immutable = (key: string) => {
    if (current && input[key] !== undefined && input[key] !== current[key])
      issues.push({ path: key, code: 'IMMUTABLE', message: 'Não se altera depois de criado.' })
  }
  const required = (key: string, ok: boolean, message: string) => {
    if (!current && input[key] === undefined)
      issues.push({ path: key, code: 'REQUIRED', message: 'Campo obrigatório.' })
    else if (input[key] !== undefined && !ok) issues.push({ path: key, code: 'INVALID', message })
  }

  if (kind === 'exchangeRates') {
    for (const k of ['fromCurrency', 'toCurrency', 'validOn']) immutable(k)
    if (!current) {
      required('fromCurrency', CURRENCY.test(upper(input.fromCurrency)), 'Moeda ISO 4217.')
      required('toCurrency', CURRENCY.test(upper(input.toCurrency)), 'Moeda ISO 4217.')
      required('validOn', ISO_DATE.test(text(input.validOn)), 'Data AAAA-MM-DD.')
      take('fromCurrency', upper(input.fromCurrency))
      take('toCurrency', upper(input.toCurrency))
      take('validOn', text(input.validOn))
      if (upper(input.fromCurrency) === upper(input.toCurrency))
        issues.push({
          path: 'toCurrency',
          code: 'SAME',
          message: 'As moedas têm de ser diferentes.',
        })
    }
    const rate = input.rate === undefined ? undefined : normalizeRate(input.rate)
    required('rate', rate !== null, 'Taxa positiva (até 10 casas decimais).')
    take('rate', rate)
    take('source', text(input.source).slice(0, 120) || null)
  }

  if (kind === 'documentSeries') {
    for (const k of ['legalEntityId', 'branchId', 'documentType', 'code', 'fiscalYear'])
      immutable(k)
    if (!current) {
      required(
        'legalEntityId',
        await legalEntityExists(s, input.legalEntityId),
        'Entidade legal inexistente.'
      )
      required(
        'documentType',
        DOCUMENT_TYPE.test(upper(input.documentType)),
        'Tipo: letras maiúsculas, números e _.'
      )
      required(
        'code',
        /^[A-Za-z0-9._/-]{1,30}$/.test(text(input.code)),
        'Código: até 30 caracteres.'
      )
      take('legalEntityId', input.legalEntityId)
      take('documentType', upper(input.documentType))
      take('code', text(input.code))
      if (input.branchId) {
        const branch = await existsIn(s, 'branches', input.branchId)
        if (!branch)
          issues.push({ path: 'branchId', code: 'NOT_FOUND', message: 'Filial inexistente.' })
        else if (branch.legal_entity_id !== input.legalEntityId)
          issues.push({
            path: 'branchId',
            code: 'OTHER_LEGAL_ENTITY',
            message: 'A filial é de outra entidade legal.',
          })
        take('branchId', input.branchId)
      }
      if (
        input.fiscalYear !== undefined &&
        input.fiscalYear !== null &&
        !(
          Number.isInteger(input.fiscalYear) &&
          (input.fiscalYear as number) >= 2000 &&
          (input.fiscalYear as number) <= 2100
        )
      )
        issues.push({ path: 'fiscalYear', code: 'INVALID', message: 'Ano de 2000 a 2100.' })
      take('fiscalYear', input.fiscalYear ?? null)
    }
    if (input.prefix !== undefined && !/^[A-Za-z0-9 ._/-]{0,20}$/.test(String(input.prefix)))
      issues.push({
        path: 'prefix',
        code: 'INVALID',
        message: 'Prefixo: até 20 caracteres (letras, números, . _ / -).',
      })
    take('prefix', input.prefix === undefined ? undefined : String(input.prefix))
    if (
      input.padding !== undefined &&
      !(
        Number.isInteger(input.padding) &&
        (input.padding as number) >= 1 &&
        (input.padding as number) <= 12
      )
    )
      issues.push({ path: 'padding', code: 'INVALID', message: 'Dígitos de 1 a 12.' })
    take('padding', input.padding)
    if (input.nextNumber !== undefined) {
      const n = input.nextNumber
      if (!Number.isInteger(n) || (n as number) < 1)
        issues.push({ path: 'nextNumber', code: 'INVALID', message: 'Número inteiro ≥ 1.' })
      // A numeração só avança: nunca se reutilizam números já emitidos.
      else if (current && (n as number) < (current.nextNumber as number))
        issues.push({
          path: 'nextNumber',
          code: 'NO_GOING_BACK',
          message: 'A numeração não pode recuar.',
        })
      take('nextNumber', n)
    }
    if (input.status !== undefined && !['ACTIVE', 'CLOSED'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou CLOSED.' })
    if (current?.status === 'CLOSED' && input.status === 'ACTIVE')
      issues.push({ path: 'status', code: 'CLOSED', message: 'Uma série fechada não se reabre.' })
    take('status', input.status)
    for (const k of ['validFrom', 'validTo'])
      if (input[k] !== undefined && input[k] !== null && !ISO_DATE.test(String(input[k])))
        issues.push({ path: k, code: 'INVALID', message: 'Data AAAA-MM-DD.' })
    take('validFrom', input.validFrom === '' ? null : input.validFrom)
    take('validTo', input.validTo === '' ? null : input.validTo)
  }

  if (kind === 'calendars') {
    immutable('code')
    if (!current) {
      required(
        'code',
        /^[A-Za-z0-9._-]{1,30}$/.test(text(input.code)),
        'Código: até 30 caracteres.'
      )
      take('code', text(input.code))
    }
    required(
      'name',
      text(input.name).length >= 2 && text(input.name).length <= 160,
      'Nome de 2 a 160 caracteres.'
    )
    take('name', text(input.name))
    required('countryCode', /^[A-Z]{2}$/.test(upper(input.countryCode)), 'País ISO 3166-1 alfa-2.')
    take('countryCode', upper(input.countryCode))
    take('province', input.province === undefined ? undefined : text(input.province) || null)
    if (input.legalEntityId !== undefined) {
      if (input.legalEntityId !== null && !(await legalEntityExists(s, input.legalEntityId)))
        issues.push({
          path: 'legalEntityId',
          code: 'NOT_FOUND',
          message: 'Não existe nesta empresa.',
        })
      take('legalEntityId', input.legalEntityId)
    }
    if (input.branchId !== undefined) {
      if (input.branchId !== null && !(await existsIn(s, 'branches', input.branchId)))
        issues.push({ path: 'branchId', code: 'NOT_FOUND', message: 'Não existe nesta empresa.' })
      take('branchId', input.branchId)
    }
    if (input.weekendDays !== undefined) {
      const days = input.weekendDays
      if (
        !Array.isArray(days) ||
        days.length > 6 ||
        days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
      )
        issues.push({
          path: 'weekendDays',
          code: 'INVALID',
          message: 'Dias de 1 (segunda) a 7 (domingo).',
        })
      else take('weekendDays', [...new Set(days as number[])].sort())
    }
    if (input.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
    take('status', input.status)
  }

  if (kind === 'bankAccounts') {
    // Dados bancários não se editam (protecção contra fraude): para mudar, cria-se outra conta e inactiva-se esta.
    for (const k of [
      'legalEntityId',
      'holderName',
      'bankName',
      'iban',
      'accountNumber',
      'swiftBic',
      'currency',
    ])
      immutable(k)
    if (!current) {
      required(
        'legalEntityId',
        await legalEntityExists(s, input.legalEntityId),
        'Entidade legal inexistente.'
      )
      required('holderName', text(input.holderName).length >= 2, 'Titular obrigatório.')
      required('bankName', text(input.bankName).length >= 2, 'Banco obrigatório.')
      required('currency', CURRENCY.test(upper(input.currency)), 'Moeda ISO 4217.')
      take('legalEntityId', input.legalEntityId)
      take('holderName', text(input.holderName).slice(0, 200))
      take('bankName', text(input.bankName).slice(0, 160))
      take('currency', upper(input.currency))
      const iban = input.iban ? normalizeIban(String(input.iban)) : null
      if (iban && !isValidIban(iban))
        issues.push({
          path: 'iban',
          code: 'INVALID_IBAN',
          message: 'IBAN inválido (dígitos de controlo).',
        })
      take('iban', iban)
      const account = text(input.accountNumber) || null
      if (account && !/^[0-9A-Za-z -]{4,40}$/.test(account))
        issues.push({
          path: 'accountNumber',
          code: 'INVALID',
          message: 'Número de conta inválido.',
        })
      take('accountNumber', account)
      if (!iban && !account)
        issues.push({
          path: 'iban',
          code: 'REQUIRED',
          message: 'Indique o IBAN ou o número de conta.',
        })
      const swift = text(input.swiftBic).toUpperCase() || null
      if (swift && !isValidSwift(swift))
        issues.push({
          path: 'swiftBic',
          code: 'INVALID',
          message: 'SWIFT/BIC com 8 ou 11 caracteres.',
        })
      take('swiftBic', swift)
    }
    if (input.isDefault !== undefined && typeof input.isDefault !== 'boolean')
      issues.push({ path: 'isDefault', code: 'INVALID', message: 'Sim ou não.' })
    take('isDefault', input.isDefault)
    if (current && input.status !== undefined) {
      if (input.status !== 'INACTIVE' || current.status !== 'ACTIVE')
        issues.push({
          path: 'status',
          code: 'INVALID',
          message: 'Só se inactiva uma conta activa.',
        })
      take('status', input.status)
    }
  }
  return { values, issues }
}

// ---------------------------------------------------------------- serviço

export class ReferenceService {
  list(
    context: TenantContext,
    kind: SettingsKind,
    filter: { equals: Record<string, unknown>; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async ({ trx }) => {
      const page = await crudList(crud(context, trx), SETTINGS_SPECS[kind], filter)
      return { ...page, items: page.items.map((r) => present(kind, r, true)) }
    })
  }

  get(context: TenantContext, kind: SettingsKind, id: string) {
    return runInTenant(context, async ({ trx }) => {
      const row = await crudFind(crud(context, trx), SETTINGS_SPECS[kind], id)
      if (!row) throw ApiError.notFound()
      const view = present(kind, row, false)
      if (kind === 'calendars') view.holidays = await holidaysOf(crud(context, trx), id)
      return view
    })
  }

  create(context: TenantContext, kind: SettingsKind, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const { values, issues } = await validate(s, kind, input, null)
      if (issues.length > 0) throw ApiError.validation(issues)
      if (kind === 'bankAccounts') return createBankAccount(scope, s, values)
      const row = await crudInsert(s, SETTINGS_SPECS[kind], values)
      await audit(scope, {
        action: `${ENTITY[kind]}.created`,
        entityType: ENTITY[kind],
        entityId: row.id,
        changes: diff(null, row, Object.keys(SETTINGS_SPECS[kind].columns)),
      })
      return present(kind, row, false)
    })
  }

  update(
    context: TenantContext,
    kind: SettingsKind,
    id: string,
    input: Record<string, unknown> & { expectedVersion: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const current = await crudFind(s, SETTINGS_SPECS[kind], id, true)
      if (!current) throw ApiError.notFound()
      const { expectedVersion, ...rest } = input
      const { values, issues } = await validate(s, kind, rest, current)
      if (kind === 'bankAccounts' && values.isDefault === true && current.status !== 'ACTIVE')
        issues.push({
          path: 'isDefault',
          code: 'NOT_ACTIVE',
          message: 'Só uma conta activa pode ser a conta por omissão.',
        })
      if (issues.length > 0) throw ApiError.validation(issues)
      if (kind === 'bankAccounts' && values.isDefault === true) await clearDefault(s, current, id)
      if (kind === 'bankAccounts' && values.status === 'INACTIVE') values.isDefault = false
      const row = await crudUpdate(s, SETTINGS_SPECS[kind], id, expectedVersion, values)
      const changes = diff(current, row, Object.keys(SETTINGS_SPECS[kind].columns))
      if (changes)
        await audit(scope, {
          action: `${ENTITY[kind]}.updated`,
          entityType: ENTITY[kind],
          entityId: id,
          changes,
        })
      return present(kind, row, false)
    })
  }

  // ---- câmbios
  /** Câmbio em vigor numa data: o registo mais recente até essa data (directo; não deriva pares inversos). */
  lookupRate(context: TenantContext, from: string, to: string, on: string) {
    return runInTenant(context, async ({ trx }) => {
      const r = await trx.rawQuery(
        `select rate::text as rate, valid_on::text as "validOn", source from exchange_rates
          where tenant_id = ? and from_currency = ? and to_currency = ? and valid_on <= ?
          order by valid_on desc limit 1`,
        [context.tenantId, from, to, on]
      )
      if (r.rows.length === 0)
        throw new ApiError(404, 'RATE_NOT_FOUND', `Sem câmbio ${from}→${to} até ${on}.`)
      return {
        from,
        to,
        ...(r.rows[0] as { rate: string; validOn: string; source: string | null }),
      }
    })
  }

  // ---- séries
  preview(context: TenantContext, id: string) {
    return runInTenant(context, async ({ trx }) => {
      const row = await crudFind(crud(context, trx), SETTINGS_SPECS.documentSeries, id)
      if (!row) throw ApiError.notFound()
      return {
        next: formatDocumentNumber(
          row.prefix as string,
          row.nextNumber as number,
          row.padding as number
        ),
      }
    })
  }

  // ---- calendários
  addHoliday(
    context: TenantContext,
    calendarId: string,
    input: { date: string; name: string; kind?: string }
  ) {
    const issues: ErrorDetail[] = []
    if (!ISO_DATE.test(input.date ?? ''))
      issues.push({ path: 'date', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
    if (!input.name || input.name.trim().length < 2)
      issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome do feriado.' })
    if (input.kind && !['NATIONAL', 'REGIONAL', 'COMPANY'].includes(input.kind))
      issues.push({ path: 'kind', code: 'INVALID', message: 'NATIONAL, REGIONAL ou COMPANY.' })
    if (issues.length > 0) throw ApiError.validation(issues)
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      if (!(await crudFind(s, SETTINGS_SPECS.calendars, calendarId))) throw ApiError.notFound()
      await scope.trx.rawQuery('savepoint holiday')
      try {
        const r = await scope.trx.rawQuery(
          `insert into calendar_holidays (tenant_id, created_by, updated_by, calendar_id, holiday_on, name, kind)
           values (?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            context.userId,
            context.userId,
            calendarId,
            input.date,
            input.name.trim().slice(0, 160),
            input.kind ?? 'NATIONAL',
          ]
        )
        await scope.trx.rawQuery('release savepoint holiday')
        await audit(scope, {
          action: 'calendar.holiday_added',
          entityType: 'calendar',
          entityId: calendarId,
          metadata: { date: input.date, name: input.name },
        })
        return { id: (r.rows[0] as { id: string }).id, holidays: await holidaysOf(s, calendarId) }
      } catch (error) {
        if ((error as { constraint?: string }).constraint === 'calendar_holidays_day_unique') {
          await scope.trx.rawQuery('rollback to savepoint holiday')
          throw ApiError.conflict('HOLIDAY_EXISTS', 'Já há um feriado nesse dia.')
        }
        throw error
      }
    })
  }

  removeHoliday(context: TenantContext, calendarId: string, holidayId: string) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        'delete from calendar_holidays where tenant_id = ? and calendar_id = ? and id = ? returning holiday_on::text as day, name',
        [context.tenantId, calendarId, holidayId]
      )
      if (r.rows.length === 0) throw ApiError.notFound()
      await audit(scope, {
        action: 'calendar.holiday_removed',
        entityType: 'calendar',
        entityId: calendarId,
        metadata: r.rows[0] as Record<string, unknown>,
      })
      return holidaysOf(crud(context, scope.trx), calendarId)
    })
  }

  /** Dias úteis entre duas datas (inclusive): exclui fim-de-semana do calendário e feriados (até 366 dias). */
  workingDays(context: TenantContext, calendarId: string, from: string, to: string) {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || to < from)
      throw ApiError.validation([
        { path: 'to', code: 'RANGE', message: 'Intervalo de datas inválido.' },
      ])
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000
    if (span > 366)
      throw ApiError.validation([{ path: 'to', code: 'TOO_LONG', message: 'No máximo 366 dias.' }])
    return runInTenant(context, async ({ trx }) => {
      const row = await crudFind(crud(context, trx), SETTINGS_SPECS.calendars, calendarId)
      if (!row) throw ApiError.notFound()
      const r = await trx.rawQuery(
        `select count(*)::int as n from generate_series(?::date, ?::date, interval '1 day') d
          where not (extract(isodow from d)::smallint = any(?::smallint[]))
            and not exists (select 1 from calendar_holidays h where h.tenant_id = ? and h.calendar_id = ? and h.holiday_on = d::date)`,
        [from, to, row.weekendDays as number[], context.tenantId, calendarId] as never[]
      )
      return { from, to, workingDays: (r.rows[0] as { n: number }).n }
    })
  }
}

async function holidaysOf(s: CrudScope, calendarId: string) {
  const r = await s.trx.rawQuery(
    `select id, holiday_on::text as date, name, kind from calendar_holidays
      where tenant_id = ? and calendar_id = ? order by holiday_on`,
    [s.tenantId, calendarId]
  )
  return r.rows as { id: string; date: string; name: string; kind: string }[]
}

function present(kind: SettingsKind, row: Row, list: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  if (kind === 'exchangeRates') out.rate = String(row.rate)
  if (kind === 'bankAccounts' && list) out.ibanMasked = maskIban(row.iban as string | null)
  if (kind === 'documentSeries')
    out.nextFormatted = formatDocumentNumber(
      row.prefix as string,
      row.nextNumber as number,
      row.padding as number
    )
  return out
}

async function clearDefault(s: CrudScope, current: Row, id: string) {
  await s.trx.rawQuery(
    `update bank_accounts set is_default = false, updated_at = now(), updated_by = ?, version = version + 1
      where tenant_id = ? and legal_entity_id = ? and currency = ? and is_default and id <> ?`,
    [s.userId, s.tenantId, current.legalEntityId, current.currency, id] as never[]
  )
}

/**
 * Conta bancária nova: se a empresa configurou um workflow para contas bancárias, fica `PENDING_APPROVAL` e é
 * submetida a aprovação na mesma transacção (sem a funcionalidade de aprovações contratada, é recusada em vez de
 * contornar o controlo); senão fica activa.
 */
async function createBankAccount(
  scope: TenantScope,
  s: CrudScope,
  values: Record<string, unknown>
) {
  const settings = await tenantSettings(scope)
  const needsApproval = settings.bankAccountWorkflowId !== null
  if (needsApproval) {
    const { features } = await entitlementsFor(scope.context.tenantId)
    if (!features.get('approvals')?.enabled)
      throw ApiError.conflict(
        'APPROVAL_UNAVAILABLE',
        'As contas bancárias exigem aprovação, mas as aprovações não estão contratadas.'
      )
  }
  const row = await crudInsert(s, SETTINGS_SPECS.bankAccounts, {
    ...values,
    isDefault: needsApproval ? false : values.isDefault === true,
    status: needsApproval ? 'PENDING_APPROVAL' : 'ACTIVE',
  })
  if (!needsApproval && values.isDefault === true) await clearDefault(s, row, row.id)
  let result = row
  if (needsApproval) {
    const requestId = await submitForSubject(scope, {
      workflowId: settings.bankAccountWorkflowId!,
      subjectType: 'bank_account',
      subjectId: row.id,
      title: `Conta bancária: ${row.bankName as string} ${maskIban(row.iban as string | null) ?? (row.accountNumber as string)}`,
      description: `Titular: ${row.holderName as string} · Moeda: ${row.currency as string}`,
    })
    result = await crudUpdate(s, SETTINGS_SPECS.bankAccounts, row.id, row.version, {
      approvalRequestId: requestId,
    })
  }
  await audit(scope, {
    action: 'bank_account.created',
    entityType: 'bank_account',
    entityId: row.id,
    changes: diff(null, result, Object.keys(SETTINGS_SPECS.bankAccounts.columns)),
  })
  return present('bankAccounts', result, false)
}

/** Efeito da aprovação de uma conta bancária (registado em `start/approval_subjects.ts`). */
export async function onBankAccountDecided(
  scope: TenantScope,
  accountId: string,
  outcome: ApprovalOutcome
) {
  const s: CrudScope = {
    trx: scope.trx,
    tenantId: scope.context.tenantId,
    userId: scope.context.userId,
  }
  const row = await crudFind(s, SETTINGS_SPECS.bankAccounts, accountId, true)
  if (!row || row.status !== 'PENDING_APPROVAL') return
  const status = outcome === 'APPROVED' ? 'ACTIVE' : 'REJECTED'
  await crudUpdate(s, SETTINGS_SPECS.bankAccounts, accountId, row.version, { status })
  await audit(scope, {
    action: outcome === 'APPROVED' ? 'bank_account.approved' : 'bank_account.rejected',
    entityType: 'bank_account',
    entityId: accountId,
    changes: { status: { from: 'PENDING_APPROVAL', to: status } },
  })
}

/**
 * Reserva o próximo número de uma série (contrato para a Facturação e outros módulos de documentos), na transacção de
 * quem emite: bloqueia a série, valida estado e vigência, devolve o número formatado e avança o contador. Se a
 * emissão falhar, a transacção desfaz também o avanço: não há saltos nem repetições.
 */
export async function reserveDocumentNumber(scope: TenantScope, seriesId: string, on: string) {
  const r = await scope.trx.rawQuery(
    `select id, prefix, next_number, padding, status, valid_from::text as valid_from, valid_to::text as valid_to
       from document_series where tenant_id = ? and id = ? for update`,
    [scope.context.tenantId, seriesId]
  )
  const row = r.rows[0] as
    | {
        prefix: string
        next_number: number
        padding: number
        status: string
        valid_from: string | null
        valid_to: string | null
      }
    | undefined
  if (!row) throw ApiError.notFound()
  if (row.status !== 'ACTIVE') throw ApiError.conflict('SERIES_CLOSED', 'A série está fechada.')
  if ((row.valid_from && on < row.valid_from) || (row.valid_to && on > row.valid_to))
    throw ApiError.conflict('SERIES_NOT_VALID', 'A série não está em vigor nesta data.')
  await scope.trx.rawQuery(
    `update document_series set next_number = next_number + 1, updated_at = now(), version = version + 1
      where tenant_id = ? and id = ?`,
    [scope.context.tenantId, seriesId]
  )
  return {
    number: row.next_number,
    formatted: formatDocumentNumber(row.prefix, row.next_number, row.padding),
  }
}
