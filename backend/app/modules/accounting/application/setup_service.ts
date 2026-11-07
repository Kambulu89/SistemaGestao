import { ApiError, type ErrorDetail } from '#shared/http/api_error'
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
import { legalEntityFacts } from '#modules/organization/index'
import { documentSeriesFacts } from '#modules/settings/index'
import {
  buildPeriods,
  checkAccountPlacement,
  defaultNormalBalance,
  JOURNAL_TYPES,
  LEVELS,
  NATURES,
} from '#modules/accounting/domain/accounting'

export const crud = (context: TenantContext, trx: CrudScope['trx']): CrudScope => ({
  trx,
  tenantId: context.tenantId,
  userId: context.userId,
})

export const SPECS = {
  charts: {
    table: 'account_charts',
    columns: {
      legalEntityId: 'legal_entity_id',
      code: 'code',
      name: 'name',
      jurisdiction: 'jurisdiction',
      baseModel: 'base_model',
      status: 'status',
    },
    searchColumns: ['code', 'name'],
    orderBy: 'code',
    uniqueErrors: {
      account_charts_code_unique: {
        code: 'CHART_CODE_TAKEN',
        message: 'Já existe um plano com este código.',
      },
      account_charts_one_active: {
        code: 'ACTIVE_CHART_EXISTS',
        message: 'Esta entidade legal já tem um plano activo.',
      },
    },
  },
  accounts: {
    table: 'accounts',
    columns: {
      chartId: 'chart_id',
      parentId: 'parent_id',
      code: 'code',
      name: 'name',
      level: 'level',
      nature: 'nature',
      normalBalance: 'normal_balance',
      postable: 'postable',
      requiresCostCenter: 'requires_cost_center',
      requiresThirdParty: 'requires_third_party',
      statementLine: 'statement_line',
      status: 'status',
    },
    searchColumns: ['code', 'name'],
    orderBy: 'code',
    uniqueErrors: {
      accounts_code_unique: {
        code: 'ACCOUNT_CODE_TAKEN',
        message: 'Já existe esta conta no plano.',
      },
    },
  },
  fiscalYears: {
    table: 'fiscal_years',
    columns: {
      legalEntityId: 'legal_entity_id',
      code: 'code',
      startDate: 'start_date',
      endDate: 'end_date',
      status: 'status',
    },
    dateColumns: ['start_date', 'end_date'],
    searchColumns: ['code'],
    orderBy: 'start_date desc',
    uniqueErrors: {
      fiscal_years_code_unique: { code: 'FISCAL_YEAR_TAKEN', message: 'Já existe este exercício.' },
      fiscal_years_no_overlap: {
        code: 'FISCAL_YEAR_OVERLAP',
        message: 'As datas sobrepõem-se a outro exercício desta entidade legal.',
      },
    },
  },
  journals: {
    table: 'journals',
    columns: {
      legalEntityId: 'legal_entity_id',
      code: 'code',
      name: 'name',
      type: 'type',
      documentSeriesId: 'document_series_id',
      status: 'status',
    },
    searchColumns: ['code', 'name'],
    orderBy: 'code',
    uniqueErrors: {
      journals_code_unique: {
        code: 'JOURNAL_CODE_TAKEN',
        message: 'Já existe um diário com este código.',
      },
    },
  },
} satisfies Record<string, CrudSpec>

export type SetupKind = keyof typeof SPECS
const ENTITY: Record<SetupKind, string> = {
  charts: 'account_chart',
  accounts: 'account',
  fiscalYears: 'fiscal_year',
  journals: 'journal',
}

const CODE = /^[A-Za-z0-9._-]{1,30}$/
const ACCOUNT_CODE = /^[0-9A-Za-z.]{1,30}$/
const ISO = /^\d{4}-\d{2}-\d{2}$/
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

type Values = Record<string, unknown>

/** Validação por tipo. `current` é o registo existente (alteração) ou null (criação). */
async function validate(scope: TenantScope, kind: SetupKind, input: Values, current: Row | null) {
  const s = crud(scope.context, scope.trx)
  const issues: ErrorDetail[] = []
  const values: Values = {}
  const take = (k: string, v: unknown) => {
    if (input[k] !== undefined) values[k] = v
  }
  const immutable = (...keys: string[]) => {
    for (const k of keys)
      if (current && input[k] !== undefined && input[k] !== current[k])
        issues.push({ path: k, code: 'IMMUTABLE', message: 'Não se altera depois de criado.' })
  }
  const required = (k: string, ok: boolean, message: string) => {
    if (!current && (input[k] === undefined || input[k] === null || input[k] === ''))
      issues.push({ path: k, code: 'REQUIRED', message: 'Campo obrigatório.' })
    else if (input[k] !== undefined && !ok) issues.push({ path: k, code: 'INVALID', message })
  }
  const legalEntity = async () => {
    const le =
      typeof input.legalEntityId === 'string'
        ? await legalEntityFacts(scope, input.legalEntityId)
        : null
    if (!current) {
      if (!le)
        issues.push({
          path: 'legalEntityId',
          code: 'NOT_FOUND',
          message: 'Entidade legal inexistente.',
        })
      else take('legalEntityId', le.id)
    }
    return le
  }
  const status = (allowed: string[]) => {
    if (input.status !== undefined && !allowed.includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: `Estado: ${allowed.join(', ')}.` })
    take('status', input.status)
  }

  if (kind === 'charts') {
    immutable('legalEntityId', 'code')
    await legalEntity()
    if (!current) {
      required('code', CODE.test(text(input.code)), 'Código: até 30 caracteres.')
      take('code', text(input.code))
    }
    required('name', text(input.name).length >= 2, 'Nome de 2 a 160 caracteres.')
    take('name', text(input.name).slice(0, 160))
    required(
      'jurisdiction',
      /^[A-Z]{2}$/.test(text(input.jurisdiction).toUpperCase()),
      'País ISO (ex.: AO).'
    )
    take('jurisdiction', text(input.jurisdiction).toUpperCase())
    take(
      'baseModel',
      input.baseModel === undefined ? undefined : text(input.baseModel).slice(0, 160) || null
    )
    status(['ACTIVE', 'INACTIVE'])
  }

  if (kind === 'accounts') {
    immutable('chartId', 'code', 'parentId', 'level')
    let parent: Row | null = null
    if (!current) {
      const chart =
        typeof input.chartId === 'string' ? await crudFind(s, SPECS.charts, input.chartId) : null
      if (!chart) issues.push({ path: 'chartId', code: 'NOT_FOUND', message: 'Plano inexistente.' })
      take('chartId', input.chartId)
      required(
        'code',
        ACCOUNT_CODE.test(text(input.code)),
        'Código: dígitos, letras e pontos (até 30).'
      )
      take('code', text(input.code))
      required('level', LEVELS.includes(input.level as never), `Nível: ${LEVELS.join(', ')}.`)
      take('level', input.level)
      if (input.parentId) {
        parent =
          typeof input.parentId === 'string'
            ? await crudFind(s, SPECS.accounts, input.parentId)
            : null
        if (!parent || parent.chartId !== input.chartId)
          issues.push({
            path: 'parentId',
            code: 'NOT_FOUND',
            message: 'Conta-mãe inexistente neste plano.',
          })
        take('parentId', input.parentId)
      }
      if (issues.length === 0)
        issues.push(
          ...checkAccountPlacement(
            { code: text(input.code), level: input.level as string },
            parent
              ? {
                  code: parent.code as string,
                  level: parent.level as string,
                  postable: parent.postable as boolean,
                }
              : null
          )
        )
    }
    required('name', text(input.name).length >= 2, 'Nome de 2 a 200 caracteres.')
    take('name', text(input.name).slice(0, 200))
    required('nature', NATURES.includes(input.nature as never), `Natureza: ${NATURES.join(', ')}.`)
    take('nature', input.nature)
    if (
      input.normalBalance !== undefined &&
      !['DEBIT', 'CREDIT'].includes(input.normalBalance as string)
    )
      issues.push({ path: 'normalBalance', code: 'INVALID', message: 'DEBIT ou CREDIT.' })
    if (!current && input.normalBalance === undefined && NATURES.includes(input.nature as never))
      values.normalBalance = defaultNormalBalance(input.nature as string)
    else take('normalBalance', input.normalBalance)
    for (const k of ['postable', 'requiresCostCenter', 'requiresThirdParty'])
      if (input[k] !== undefined) {
        if (typeof input[k] !== 'boolean')
          issues.push({ path: k, code: 'INVALID', message: 'Sim ou não.' })
        else values[k] = input[k]
      }
    if (input.postable === true && (input.level ?? current?.level) === 'CLASS')
      issues.push({
        path: 'postable',
        code: 'CLASS_NOT_POSTABLE',
        message: 'Uma classe não é movimentável.',
      })
    take(
      'statementLine',
      input.statementLine === undefined ? undefined : text(input.statementLine).slice(0, 40) || null
    )
    status(['ACTIVE', 'INACTIVE'])
    if (current) {
      // Uma conta com subcontas não passa a movimentável; com movimentos não deixa de o ser nem muda de natureza.
      const children = await scope.trx.rawQuery(
        `select count(*)::int as n from accounts where tenant_id = ? and parent_id = ?`,
        [scope.context.tenantId, current.id]
      )
      const childCount = (children.rows[0] as { n: number }).n
      if (input.postable === true && childCount > 0)
        issues.push({
          path: 'postable',
          code: 'HAS_CHILDREN',
          message: 'Uma conta com subcontas não é movimentável.',
        })
      if (input.status === 'INACTIVE') {
        const active = await scope.trx.rawQuery(
          `select count(*)::int as n from accounts where tenant_id = ? and parent_id = ? and status = 'ACTIVE'`,
          [scope.context.tenantId, current.id]
        )
        if ((active.rows[0] as { n: number }).n > 0)
          issues.push({
            path: 'status',
            code: 'HAS_ACTIVE_CHILDREN',
            message: 'Inactive primeiro as subcontas.',
          })
      }
      const changesUsage =
        (input.postable === false && current.postable) ||
        (input.nature !== undefined && input.nature !== current.nature)
      if (changesUsage) {
        const used = await scope.trx.rawQuery(
          `select 1 from journal_lines where tenant_id = ? and account_id = ? limit 1`,
          [scope.context.tenantId, current.id]
        )
        if (used.rows.length > 0)
          issues.push({
            path: input.postable === false ? 'postable' : 'nature',
            code: 'ACCOUNT_IN_USE',
            message:
              'A conta já tem lançamentos: não muda de natureza nem deixa de ser movimentável.',
          })
      }
    }
  }

  if (kind === 'fiscalYears') {
    if (current)
      issues.push({
        path: 'status',
        code: 'USE_CLOSE',
        message: 'Os exercícios não se editam; fecham-se por período.',
      })
    await legalEntity()
    required('code', CODE.test(text(input.code)), 'Código: até 30 caracteres (ex.: 2026).')
    take('code', text(input.code))
    required('startDate', ISO.test(text(input.startDate)), 'Data AAAA-MM-DD.')
    required('endDate', ISO.test(text(input.endDate)), 'Data AAAA-MM-DD.')
    take('startDate', text(input.startDate))
    take('endDate', text(input.endDate))
    if (
      ISO.test(text(input.startDate)) &&
      ISO.test(text(input.endDate)) &&
      !buildPeriods(text(input.startDate), text(input.endDate))
    )
      issues.push({
        path: 'endDate',
        code: 'RANGE',
        message: 'Exercício de 1 a 24 meses, com fim depois do início.',
      })
  }

  if (kind === 'journals') {
    immutable('legalEntityId', 'code', 'documentSeriesId')
    const le = await legalEntity()
    if (!current) {
      required('code', CODE.test(text(input.code)), 'Código: até 30 caracteres.')
      take('code', text(input.code).slice(0, 20))
      const series =
        typeof input.documentSeriesId === 'string'
          ? await documentSeriesFacts(scope, input.documentSeriesId)
          : null
      if (!series)
        issues.push({
          path: 'documentSeriesId',
          code: 'REQUIRED',
          message: 'Indique a série documental do diário.',
        })
      else if (series.documentType !== 'JOURNAL' || (le && series.legalEntityId !== le.id))
        issues.push({
          path: 'documentSeriesId',
          code: 'WRONG_SERIES',
          message:
            'A série tem de ser do tipo "Lançamento contabilístico" e da mesma entidade legal.',
        })
      take('documentSeriesId', input.documentSeriesId)
    }
    required('name', text(input.name).length >= 2, 'Nome de 2 a 120 caracteres.')
    take('name', text(input.name).slice(0, 120))
    required(
      'type',
      JOURNAL_TYPES.includes(input.type as never),
      `Tipo: ${JOURNAL_TYPES.join(', ')}.`
    )
    take('type', input.type)
    status(['ACTIVE', 'INACTIVE'])
  }
  return { values, issues }
}

export class AccountingSetupService {
  list(
    context: TenantContext,
    kind: SetupKind,
    filter: { equals: Values; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, ({ trx }) => crudList(crud(context, trx), SPECS[kind], filter))
  }

  get(context: TenantContext, kind: SetupKind, id: string) {
    return runInTenant(context, async ({ trx }) => {
      const row = await crudFind(crud(context, trx), SPECS[kind], id)
      if (!row) throw ApiError.notFound()
      if (kind === 'fiscalYears')
        return { ...row, periods: await periodsOf(crud(context, trx), id) }
      return row
    })
  }

  create(context: TenantContext, kind: SetupKind, input: Values) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const { values, issues } = await validate(scope, kind, input, null)
      if (issues.length > 0) throw ApiError.validation(issues)
      const row = await crudInsert(s, SPECS[kind], values)
      if (kind === 'fiscalYears') {
        for (const p of buildPeriods(row.startDate as string, row.endDate as string)!)
          await scope.trx.rawQuery(
            `insert into fiscal_periods (tenant_id, created_by, updated_by, fiscal_year_id, number, kind, name, start_date, end_date)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              context.tenantId,
              context.userId,
              context.userId,
              row.id,
              p.number,
              p.kind,
              p.name,
              p.startDate,
              p.endDate,
            ]
          )
      }
      await audit(scope, {
        action: `${ENTITY[kind]}.created`,
        entityType: ENTITY[kind],
        entityId: row.id,
        changes: diff(null, row, Object.keys(SPECS[kind].columns)),
      })
      return kind === 'fiscalYears' ? { ...row, periods: await periodsOf(s, row.id) } : row
    })
  }

  update(
    context: TenantContext,
    kind: SetupKind,
    id: string,
    input: Values & { expectedVersion: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const current = await crudFind(s, SPECS[kind], id, true)
      if (!current) throw ApiError.notFound()
      const { values, issues } = await validate(scope, kind, input, current)
      if (issues.length > 0) throw ApiError.validation(issues)
      if (Object.keys(values).length === 0) return current
      const row = await crudUpdate(s, SPECS[kind], id, input.expectedVersion, values)
      await audit(scope, {
        action: `${ENTITY[kind]}.updated`,
        entityType: ENTITY[kind],
        entityId: id,
        changes: diff(current, row, Object.keys(SPECS[kind].columns)),
      })
      return row
    })
  }

  /** Fecha ou reabre um período. Fechar exige que não haja lançamentos submetidos ou aprovados por contabilizar. */
  setPeriodStatus(
    context: TenantContext,
    periodId: string,
    status: 'OPEN' | 'CLOSED',
    reason: string | null
  ) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select p.id, p.status, p.name, p.version, y.status as year_status, y.id as fiscal_year_id
           from fiscal_periods p join fiscal_years y on y.tenant_id = p.tenant_id and y.id = p.fiscal_year_id
          where p.tenant_id = ? and p.id = ? for update of p`,
        [context.tenantId, periodId]
      )
      const period = r.rows[0] as
        | { id: string; status: string; name: string; year_status: string; fiscal_year_id: string }
        | undefined
      if (!period) throw ApiError.notFound()
      if (period.status === status)
        throw ApiError.conflict(
          'PERIOD_ALREADY',
          status === 'CLOSED' ? 'O período já está fechado.' : 'O período já está aberto.'
        )
      if (period.year_status === 'CLOSED')
        throw ApiError.conflict('FISCAL_YEAR_CLOSED', 'O exercício está fechado.')
      if (status === 'CLOSED') {
        const pending = await scope.trx.rawQuery(
          `select count(*)::int as n from journal_entries where tenant_id = ? and period_id = ? and status in ('SUBMITTED','APPROVED')`,
          [context.tenantId, periodId]
        )
        const n = (pending.rows[0] as { n: number }).n
        if (n > 0)
          throw new ApiError(
            409,
            'PERIOD_HAS_PENDING',
            `Há ${n} lançamento(s) submetido(s) ou aprovado(s) por contabilizar neste período.`
          )
      } else if (!reason || reason.trim().length < 5) {
        throw ApiError.validation([
          { path: 'reason', code: 'REQUIRED', message: 'Indique o motivo da reabertura.' },
        ])
      }
      await scope.trx.rawQuery(
        `update fiscal_periods set status = ?, updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
        [status, context.userId, context.tenantId, periodId]
      )
      await audit(scope, {
        action: status === 'CLOSED' ? 'fiscal_period.closed' : 'fiscal_period.reopened',
        entityType: 'fiscal_year',
        entityId: period.fiscal_year_id,
        changes: { [`period:${period.name}`]: { from: period.status, to: status } },
        metadata: reason ? { reason: reason.trim() } : undefined,
      })
      return periodsOf(crud(context, scope.trx), period.fiscal_year_id)
    })
  }
}

export async function periodsOf(s: CrudScope, fiscalYearId: string) {
  const r = await s.trx.rawQuery(
    `select id, number, kind, name, start_date::text as "startDate", end_date::text as "endDate", status
       from fiscal_periods where tenant_id = ? and fiscal_year_id = ? order by number`,
    [s.tenantId, fiscalYearId]
  )
  return r.rows as {
    id: string
    number: number
    kind: string
    name: string
    startDate: string
    endDate: string
    status: string
  }[]
}
