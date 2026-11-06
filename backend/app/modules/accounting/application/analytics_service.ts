import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { crudFind, crudInsert, crudList, crudUpdate, type CrudSpec } from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit, diff } from '#modules/audit/index'
import { costCenterFacts, legalEntityFacts } from '#modules/organization/index'
import { tenantSettings } from '#modules/settings/index'
import { crud } from '#modules/accounting/application/setup_service'
import { checkPercents, distribute, PERCENT_SCALE } from '#modules/accounting/domain/analytics'
import { formatDecimal, parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Contabilidade analítica (6.5): dimensões e valores, chaves de repartição e imputações de linhas de lançamentos a
 * centros de custo e dimensões em percentagens que somam 100%. É uma camada sobre o razão: nunca cria nem altera
 * movimentos, e o relatório reparte cada linha exactamente (soma das partes = valor da linha).
 */
const CODE = /^[A-Za-z0-9._-]{1,30}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export const DIMENSION_SPEC = {
  table: 'analytic_dimensions',
  columns: { code: 'code', name: 'name', status: 'status' },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    analytic_dimensions_code_unique: {
      code: 'DIMENSION_CODE_TAKEN',
      message: 'Já existe uma dimensão com este código.',
    },
  },
} satisfies CrudSpec
export const VALUE_SPEC = {
  table: 'analytic_dimension_values',
  columns: { dimensionId: 'dimension_id', code: 'code', name: 'name', status: 'status' },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    analytic_values_code_unique: {
      code: 'VALUE_CODE_TAKEN',
      message: 'Já existe este valor na dimensão.',
    },
  },
} satisfies CrudSpec
export const KEY_SPEC = {
  table: 'allocation_keys',
  columns: { legalEntityId: 'legal_entity_id', code: 'code', name: 'name', status: 'status' },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    allocation_keys_code_unique: {
      code: 'KEY_CODE_TAKEN',
      message: 'Já existe uma chave com este código.',
    },
  },
} satisfies CrudSpec

export interface Target {
  percent: bigint
  costCenterId: string | null
  values: { dimensionId: string; valueId: string }[]
}

/** Normaliza `values` ({dimensão: valor} ou [{dimensionId, valueId}]). */
function valuePairs(raw: unknown): { dimensionId: string; valueId: string }[] {
  if (Array.isArray(raw))
    return raw.map((v: any) => ({ dimensionId: text(v?.dimensionId), valueId: text(v?.valueId) }))
  if (raw && typeof raw === 'object')
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && v)
      .map(([dimensionId, valueId]) => ({ dimensionId, valueId: valueId as string }))
  return []
}

/**
 * Destinos de uma repartição (chave ou imputação): percentagens a somar 100, centro de custo activo da entidade e
 * valores activos de dimensões activas (um por dimensão). Cada destino tem de dizer alguma coisa.
 */
async function validateTargets(
  scope: TenantScope,
  legalEntityId: string,
  raw: unknown,
  opts: { requireCostCenter?: boolean; allowEmpty?: boolean } = {}
) {
  const issues: ErrorDetail[] = []
  if (!Array.isArray(raw))
    return {
      issues: [{ path: 'allocations', code: 'INVALID', message: 'Lista de imputações.' }],
      targets: [] as Target[],
    }
  if (raw.length === 0) {
    if (!opts.allowEmpty)
      issues.push({ path: 'allocations', code: 'REQUIRED', message: 'Pelo menos um destino.' })
    return { issues, targets: [] as Target[] }
  }
  if (raw.length > 50)
    issues.push({ path: 'allocations', code: 'TOO_MANY', message: 'No máximo 50 destinos.' })
  const { issues: pIssues, percents } = checkPercents(raw.map((a: any) => a?.percent))
  issues.push(...pIssues)
  const centers = await costCenterFacts(
    scope,
    raw.map((a: any) => text(a?.costCenterId)).filter((x: string) => UUID.test(x))
  )
  const pairs = raw.map((a: any) => valuePairs(a?.values))
  const valueIds = [
    ...new Set(
      pairs
        .flat()
        .map((p) => p.valueId)
        .filter((x) => UUID.test(x))
    ),
  ]
  const values = valueIds.length
    ? new Map(
        (
          (
            await scope.trx.rawQuery(
              `select v.id, v.dimension_id, v.status, d.status as dimension_status, d.code as dimension_code, v.code
                 from analytic_dimension_values v join analytic_dimensions d on d.tenant_id = v.tenant_id and d.id = v.dimension_id
                where v.tenant_id = ? and v.id = any(?::uuid[])`,
              [scope.context.tenantId, valueIds]
            )
          ).rows as {
            id: string
            dimension_id: string
            status: string
            dimension_status: string
            code: string
          }[]
        ).map((v) => [v.id, v])
      )
    : new Map()
  const targets = raw.map((a: any, i: number) => {
    const path = `allocations.${i}`
    const costCenterId = text(a?.costCenterId) || null
    if (costCenterId) {
      const cc = centers.get(costCenterId)
      if (!cc || cc.legalEntityId !== legalEntityId)
        issues.push({
          path: `${path}.costCenterId`,
          code: 'NOT_FOUND',
          message: 'Centro de custo inexistente nesta entidade legal.',
        })
      else if (cc.status !== 'ACTIVE')
        issues.push({
          path: `${path}.costCenterId`,
          code: 'INACTIVE',
          message: `Centro de custo ${cc.code} inactivo.`,
        })
    } else if (opts.requireCostCenter)
      issues.push({
        path: `${path}.costCenterId`,
        code: 'COST_CENTER_REQUIRED',
        message: 'A conta exige centro de custo em cada imputação.',
      })
    const seen = new Set<string>()
    for (const p of pairs[i]) {
      const v = values.get(p.valueId)
      if (!v || v.dimension_id !== p.dimensionId)
        issues.push({
          path: `${path}.values`,
          code: 'VALUE_NOT_FOUND',
          message: 'Valor inexistente na dimensão indicada.',
        })
      else if (v.status !== 'ACTIVE' || v.dimension_status !== 'ACTIVE')
        issues.push({
          path: `${path}.values`,
          code: 'VALUE_INACTIVE',
          message: `Valor ${v.code} ou a sua dimensão estão inactivos.`,
        })
      if (seen.has(p.dimensionId))
        issues.push({
          path: `${path}.values`,
          code: 'DUPLICATE_DIMENSION',
          message: 'Um só valor por dimensão.',
        })
      seen.add(p.dimensionId)
    }
    if (!costCenterId && pairs[i].length === 0)
      issues.push({
        path,
        code: 'EMPTY_TARGET',
        message: 'Indique um centro de custo ou um valor de dimensão.',
      })
    return { percent: percents[i], costCenterId, values: pairs[i] }
  })
  return { issues, targets }
}

async function writeTargets(
  scope: TenantScope,
  table: 'allocation_key_lines' | 'journal_line_allocations',
  owner: Record<string, unknown>,
  targets: Target[]
) {
  const valuesTable =
    table === 'allocation_key_lines'
      ? 'allocation_key_line_values'
      : 'journal_line_allocation_values'
  const ownerColumn = table === 'allocation_key_lines' ? 'key_line_id' : 'allocation_id'
  const cols = Object.keys(owner)
  for (const [i, t] of targets.entries()) {
    const r = await scope.trx.rawQuery(
      `insert into ${table} (tenant_id, created_by, updated_by, ${cols.join(', ')}, seq, percent, cost_center_id)
       values (?, ?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?) returning id`,
      [
        scope.context.tenantId,
        scope.context.userId,
        scope.context.userId,
        ...cols.map((c) => owner[c]),
        i + 1,
        formatDecimal(t.percent, PERCENT_SCALE),
        t.costCenterId,
      ] as never[]
    )
    const id = (r.rows[0] as { id: string }).id
    for (const v of t.values)
      await scope.trx.rawQuery(
        `insert into ${valuesTable} (tenant_id, created_by, updated_by, ${ownerColumn}, dimension_id, value_id)
         values (?, ?, ?, ?, ?, ?)`,
        [
          scope.context.tenantId,
          scope.context.userId,
          scope.context.userId,
          id,
          v.dimensionId,
          v.valueId,
        ]
      )
  }
}

/** Destinos gravados (chave ou linha), com os valores de dimensões. */
async function readTargets(
  scope: TenantScope,
  table: 'allocation_key_lines' | 'journal_line_allocations',
  where: string,
  params: unknown[]
) {
  const valuesTable =
    table === 'allocation_key_lines'
      ? 'allocation_key_line_values'
      : 'journal_line_allocation_values'
  const ownerColumn = table === 'allocation_key_lines' ? 'key_line_id' : 'allocation_id'
  const r = await scope.trx.rawQuery(
    `select t.*, t.percent::text as percent_text,
            coalesce((select json_agg(json_build_object('dimensionId', v.dimension_id, 'valueId', v.value_id,
                       'valueCode', dv.code, 'valueName', dv.name) order by d.code)
                        from ${valuesTable} v
                        join analytic_dimension_values dv on dv.tenant_id = v.tenant_id and dv.id = v.value_id
                        join analytic_dimensions d on d.tenant_id = v.tenant_id and d.id = v.dimension_id
                       where v.tenant_id = t.tenant_id and v.${ownerColumn} = t.id), '[]') as values
       from ${table} t where t.tenant_id = ? and ${where} order by ${table === 'journal_line_allocations' ? 't.line_no, ' : ''}t.seq`,
    [scope.context.tenantId, ...params] as never[]
  )
  return (r.rows as any[]).map((x) => ({
    entryId: x.entry_id as string | undefined,
    lineNo: x.line_no as number | undefined,
    seq: x.seq as number,
    percent: (x.percent_text as string).replace(/\.?0+$/, '') || '0',
    costCenterId: x.cost_center_id as string | null,
    values: x.values as {
      dimensionId: string
      valueId: string
      valueCode: string
      valueName: string
    }[],
  }))
}

// ---------------------------------------------------------------- dimensões e chaves

export class AnalyticSetupService {
  listDimensions(context: TenantContext, filter: { q?: string; limit: number; offset: number }) {
    return runInTenant(context, async (scope) => {
      const page = await crudList(crud(context, scope.trx), DIMENSION_SPEC, {
        equals: {},
        ...filter,
      })
      const items = []
      for (const d of page.items) items.push({ ...d, values: await this.valuesOf(scope, d.id) })
      return { items, total: page.total }
    })
  }

  private async valuesOf(scope: TenantScope, dimensionId: string) {
    return (
      await crudList(crud(scope.context, scope.trx), VALUE_SPEC, {
        equals: { dimensionId },
        limit: 1000,
        offset: 0,
      })
    ).items
  }

  getDimension(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const d = await crudFind(crud(context, scope.trx), DIMENSION_SPEC, id)
      if (!d) throw ApiError.notFound()
      return { ...d, values: await this.valuesOf(scope, id) }
    })
  }

  saveDimension(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const current = id ? await crudFind(s, DIMENSION_SPEC, id, true) : null
      if (id && !current) throw ApiError.notFound()
      const issues: ErrorDetail[] = []
      const values: Record<string, unknown> = {}
      if (!current) {
        if (!CODE.test(text(input.code)))
          issues.push({ path: 'code', code: 'INVALID', message: 'Código: até 30 caracteres.' })
        values.code = text(input.code).toUpperCase()
      } else if (input.code !== undefined && input.code !== current.code)
        issues.push({ path: 'code', code: 'IMMUTABLE', message: 'Não se altera depois de criado.' })
      if (input.name !== undefined || !current) {
        if (text(input.name).length < 2)
          issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 120 caracteres.' })
        values.name = text(input.name).slice(0, 120)
      }
      if (input.status !== undefined) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
        values.status = input.status
      }
      if (issues.length) throw ApiError.validation(issues)
      const row = current
        ? await crudUpdate(s, DIMENSION_SPEC, current.id, Number(input.expectedVersion), values)
        : await crudInsert(s, DIMENSION_SPEC, values)
      await audit(scope, {
        action: current ? 'analytic_dimension.updated' : 'analytic_dimension.created',
        entityType: 'analytic_dimension',
        entityId: row.id,
        changes: diff(current, row, Object.keys(DIMENSION_SPEC.columns)),
      })
      return { ...row, values: await this.valuesOf(scope, row.id) }
    })
  }

  saveValue(
    context: TenantContext,
    dimensionId: string,
    id: string | null,
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      if (!(await crudFind(s, DIMENSION_SPEC, dimensionId))) throw ApiError.notFound()
      const current = id ? await crudFind(s, VALUE_SPEC, id, true) : null
      if (id && (!current || current.dimensionId !== dimensionId)) throw ApiError.notFound()
      const issues: ErrorDetail[] = []
      const values: Record<string, unknown> = {}
      if (!current) {
        if (!CODE.test(text(input.code)))
          issues.push({ path: 'code', code: 'INVALID', message: 'Código: até 30 caracteres.' })
        values.code = text(input.code)
        values.dimensionId = dimensionId
      } else if (input.code !== undefined && input.code !== current.code)
        issues.push({ path: 'code', code: 'IMMUTABLE', message: 'Não se altera depois de criado.' })
      if (input.name !== undefined || !current) {
        if (text(input.name).length < 2)
          issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 160 caracteres.' })
        values.name = text(input.name).slice(0, 160)
      }
      if (input.status !== undefined) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
        values.status = input.status
      }
      if (issues.length) throw ApiError.validation(issues)
      const row = current
        ? await crudUpdate(s, VALUE_SPEC, current.id, Number(input.expectedVersion), values)
        : await crudInsert(s, VALUE_SPEC, values)
      await audit(scope, {
        action: current ? 'analytic_value.updated' : 'analytic_value.created',
        entityType: 'analytic_dimension',
        entityId: dimensionId,
        changes: diff(current, row, Object.keys(VALUE_SPEC.columns)),
      })
      return this.valuesOf(scope, dimensionId)
    })
  }

  listKeys(
    context: TenantContext,
    filter: { equals: Record<string, unknown>; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, ({ trx }) => crudList(crud(context, trx), KEY_SPEC, filter))
  }

  getKey(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const k = await crudFind(crud(context, scope.trx), KEY_SPEC, id)
      if (!k) throw ApiError.notFound()
      return { ...k, lines: await readTargets(scope, 'allocation_key_lines', 't.key_id = ?', [id]) }
    })
  }

  saveKey(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const current = id ? await crudFind(s, KEY_SPEC, id, true) : null
      if (id && !current) throw ApiError.notFound()
      const issues: ErrorDetail[] = []
      const values: Record<string, unknown> = {}
      const legalEntityId = current ? (current.legalEntityId as string) : text(input.legalEntityId)
      if (!current) {
        if (!UUID.test(legalEntityId) || !(await legalEntityFacts(scope, legalEntityId)))
          issues.push({
            path: 'legalEntityId',
            code: 'NOT_FOUND',
            message: 'Entidade legal inexistente.',
          })
        values.legalEntityId = legalEntityId
        if (!CODE.test(text(input.code)))
          issues.push({ path: 'code', code: 'INVALID', message: 'Código: até 30 caracteres.' })
        values.code = text(input.code)
      }
      if (input.name !== undefined || !current) {
        if (text(input.name).length < 2)
          issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 160 caracteres.' })
        values.name = text(input.name).slice(0, 160)
      }
      if (input.status !== undefined) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
        values.status = input.status
      }
      let targets: Target[] | null = null
      if (input.lines !== undefined || !current) {
        const v = await validateTargets(scope, legalEntityId, input.lines)
        issues.push(
          ...v.issues.map((i) => ({ ...i, path: i.path.replace(/^allocations/, 'lines') }))
        )
        targets = v.targets
      }
      if (issues.length) throw ApiError.validation(issues)
      const row = current
        ? Object.keys(values).length || targets
          ? await crudUpdate(s, KEY_SPEC, current.id, Number(input.expectedVersion), values)
          : current
        : await crudInsert(s, KEY_SPEC, values)
      if (targets) {
        await scope.trx.rawQuery(
          'delete from allocation_key_lines where tenant_id = ? and key_id = ?',
          [context.tenantId, row.id]
        )
        await writeTargets(scope, 'allocation_key_lines', { key_id: row.id }, targets)
      }
      await audit(scope, {
        action: current ? 'allocation_key.updated' : 'allocation_key.created',
        entityType: 'allocation_key',
        entityId: row.id,
        changes: diff(current, row, Object.keys(KEY_SPEC.columns)),
        metadata: targets ? { lines: targets.length } : undefined,
      })
      return {
        ...row,
        lines: await readTargets(scope, 'allocation_key_lines', 't.key_id = ?', [row.id]),
      }
    })
  }
}

// ---------------------------------------------------------------- imputações de lançamentos

async function entryHeader(scope: TenantScope, id: string, lock = false) {
  const r = await scope.trx.rawQuery(
    `select id, legal_entity_id, status, number from journal_entries where tenant_id = ? and id = ?${lock ? ' for share' : ''}`,
    [scope.context.tenantId, id]
  )
  return (
    (r.rows[0] as
      { id: string; legal_entity_id: string; status: string; number: string | null } | undefined) ??
    null
  )
}

export class AllocationService {
  /** Linhas do lançamento com as imputações (vazio = 100% ao centro de custo da linha, se houver). */
  get(context: TenantContext, entryId: string) {
    return runInTenant(context, async (scope) => {
      if (!(await entryHeader(scope, entryId))) throw ApiError.notFound()
      return readTargets(scope, 'journal_line_allocations', 't.entry_id = ?', [entryId])
    })
  }

  /**
   * Substitui as imputações de uma linha (lista vazia apaga-as). Pode ser uma lista explícita ou uma chave de
   * repartição da mesma entidade. Não toca no lançamento: vale também para lançamentos já contabilizados.
   */
  set(
    context: TenantContext,
    entryId: string,
    lineNo: number,
    input: { allocations?: unknown; keyId?: unknown }
  ) {
    return runInTenant(context, async (scope) => {
      const entry = await entryHeader(scope, entryId, true)
      if (!entry) throw ApiError.notFound()
      const line = await scope.trx.rawQuery(
        `select l.line_no, a.requires_cost_center from journal_lines l join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
          where l.tenant_id = ? and l.entry_id = ? and l.line_no = ?`,
        [context.tenantId, entryId, lineNo]
      )
      const facts = line.rows[0] as { requires_cost_center: boolean } | undefined
      if (!facts) throw ApiError.notFound()
      let raw = input.allocations
      if (input.keyId !== undefined && input.keyId !== null) {
        const key = UUID.test(text(input.keyId))
          ? ((
              await scope.trx.rawQuery(
                'select id, legal_entity_id, status from allocation_keys where tenant_id = ? and id = ?',
                [context.tenantId, text(input.keyId)]
              )
            ).rows[0] as { id: string; legal_entity_id: string; status: string } | undefined)
          : undefined
        if (!key || key.legal_entity_id !== entry.legal_entity_id || key.status !== 'ACTIVE')
          throw ApiError.validation([
            {
              path: 'keyId',
              code: 'NOT_FOUND',
              message: 'Chave de repartição activa desta entidade.',
            },
          ])
        raw = (await readTargets(scope, 'allocation_key_lines', 't.key_id = ?', [key.id])).map(
          (t) => ({
            percent: t.percent,
            costCenterId: t.costCenterId,
            values: t.values.map((v) => ({ dimensionId: v.dimensionId, valueId: v.valueId })),
          })
        )
      }
      const { issues, targets } = await validateTargets(scope, entry.legal_entity_id, raw ?? [], {
        requireCostCenter: facts.requires_cost_center,
        allowEmpty: true,
      })
      if (issues.length) throw ApiError.validation(issues)
      const before = await readTargets(
        scope,
        'journal_line_allocations',
        't.entry_id = ? and t.line_no = ?',
        [entryId, lineNo]
      )
      await scope.trx.rawQuery(
        'delete from journal_line_allocations where tenant_id = ? and entry_id = ? and line_no = ?',
        [context.tenantId, entryId, lineNo]
      )
      await writeTargets(
        scope,
        'journal_line_allocations',
        { entry_id: entryId, line_no: lineNo },
        targets
      )
      const after = await readTargets(
        scope,
        'journal_line_allocations',
        't.entry_id = ? and t.line_no = ?',
        [entryId, lineNo]
      )
      const summary = (list: typeof after) =>
        list.map((t) =>
          `${t.percent}% ${t.costCenterId ?? ''} ${t.values.map((v) => v.valueCode).join('/')}`.trim()
        )
      await audit(scope, {
        action: 'journal_entry.allocated',
        entityType: 'journal_entry',
        entityId: entryId,
        changes: { [`line:${lineNo}`]: { from: summary(before), to: summary(after) } },
        metadata: { lineNo, entryStatus: entry.status, keyId: input.keyId ?? null },
      })
      return readTargets(scope, 'journal_line_allocations', 't.entry_id = ?', [entryId])
    })
  }
}

// ---------------------------------------------------------------- relatório

export interface AnalyticQuery {
  fiscalYearId: string
  fromPeriod: number
  toPeriod: number
  groupBy: 'costCenter' | 'dimension'
  dimensionId?: string
  natures?: string[]
}

export class AnalyticReportService {
  /**
   * Repartição dos movimentos contabilizados por centro de custo ou por valor de uma dimensão. Cada linha do razão é
   * repartida exactamente pelas suas imputações (ou vai inteira para o centro de custo da linha); o que não tem destino
   * aparece como "Sem imputação". Os totais do relatório coincidem com os do razão filtrado (`consistent`).
   */
  report(context: TenantContext, q: AnalyticQuery) {
    return runInTenant(context, async (scope) => {
      const y = await scope.trx.rawQuery(
        'select id, legal_entity_id, code from fiscal_years where tenant_id = ? and id = ?',
        [context.tenantId, q.fiscalYearId]
      )
      const year = y.rows[0] as { id: string; legal_entity_id: string; code: string } | undefined
      if (!year) throw ApiError.notFound()
      if (q.groupBy === 'dimension') {
        const d = q.dimensionId
          ? await crudFind(crud(context, scope.trx), DIMENSION_SPEC, q.dimensionId)
          : null
        if (!d)
          throw ApiError.validation([
            { path: 'dimensionId', code: 'REQUIRED', message: 'Indique a dimensão.' },
          ])
      }
      const scale = (await tenantSettings(scope)).amountScale
      const natureFilter = q.natures?.length ? ' and a.nature = any(?::text[])' : ''
      const lines = await scope.trx.rawQuery(
        `select l.entry_id, l.line_no, l.cost_center_id,
                round(l.debit_functional - l.credit_functional, ?::int)::text as amount
           from journal_lines l
           join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
           join fiscal_periods p on p.tenant_id = e.tenant_id and p.id = e.period_id
           join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
          where l.tenant_id = ? and e.fiscal_year_id = ? and e.status = 'POSTED' and p.number between ? and ?${natureFilter}`,
        [
          scale,
          context.tenantId,
          year.id,
          q.fromPeriod,
          q.toPeriod,
          ...(q.natures?.length ? [q.natures] : []),
        ] as never[]
      )
      // Uma só leitura das imputações dos lançamentos contabilizados do exercício, agrupadas por linha.
      const allocations = await readTargets(
        scope,
        'journal_line_allocations',
        `t.entry_id in (select e.id from journal_entries e where e.tenant_id = t.tenant_id and e.fiscal_year_id = ? and e.status = 'POSTED')`,
        [year.id]
      )
      const byLine = new Map<string, typeof allocations>()
      for (const a of allocations) {
        const key = `${a.entryId}:${a.lineNo}`
        byLine.set(key, [...(byLine.get(key) ?? []), a])
      }

      const buckets = new Map<string, { debit: bigint; credit: bigint }>()
      let ledgerDebit = 0n
      let ledgerCredit = 0n
      const add = (key: string, share: bigint) => {
        const b = buckets.get(key) ?? { debit: 0n, credit: 0n }
        if (share > 0n) b.debit += share
        else b.credit -= share
        buckets.set(key, b)
      }
      const toBig = (v: string) => {
        const neg = v.startsWith('-')
        const n = parseDecimal(neg ? v.slice(1) : v, scale) ?? 0n
        return neg ? -n : n
      }
      for (const l of lines.rows as {
        entry_id: string
        line_no: number
        cost_center_id: string | null
        amount: string
      }[]) {
        const amount = toBig(l.amount)
        if (amount > 0n) ledgerDebit += amount
        else ledgerCredit -= amount
        const targets = byLine.get(`${l.entry_id}:${l.line_no}`)
        if (!targets || targets.length === 0) {
          add(q.groupBy === 'costCenter' ? (l.cost_center_id ?? '') : '', amount)
          continue
        }
        const shares = distribute(
          amount,
          targets.map((t) => parseDecimal(t.percent, PERCENT_SCALE)!)
        )
        targets.forEach((t, i) => {
          const key =
            q.groupBy === 'costCenter'
              ? (t.costCenterId ?? '')
              : (t.values.find((v) => v.dimensionId === q.dimensionId)?.valueId ?? '')
          add(key, shares[i])
        })
      }

      const ids = [...buckets.keys()].filter(Boolean)
      const labels = new Map<string, string>()
      if (q.groupBy === 'costCenter') {
        for (const [id, c] of await costCenterFacts(scope, ids))
          labels.set(id, `${c.code} — ${c.name}`)
      } else if (ids.length) {
        const r = await scope.trx.rawQuery(
          'select id, code, name from analytic_dimension_values where tenant_id = ? and id = any(?::uuid[])',
          [context.tenantId, ids]
        )
        for (const v of r.rows as { id: string; code: string; name: string }[])
          labels.set(v.id, `${v.code} — ${v.name}`)
      }
      const out = (v: bigint) => formatDecimal(v, scale)
      const rows = [...buckets.entries()]
        .map(([key, b]) => ({
          key: key || null,
          label: key ? (labels.get(key) ?? key) : 'Sem imputação',
          debit: out(b.debit),
          credit: out(b.credit),
          net: out(b.debit - b.credit),
        }))
        .sort((a, b) => (a.key === null ? 1 : b.key === null ? -1 : a.label.localeCompare(b.label)))
      const totalDebit = [...buckets.values()].reduce((s, b) => s + b.debit, 0n)
      const totalCredit = [...buckets.values()].reduce((s, b) => s + b.credit, 0n)
      return {
        fiscalYear: { id: year.id, code: year.code, legalEntityId: year.legal_entity_id },
        groupBy: q.groupBy,
        dimensionId: q.dimensionId ?? null,
        rows,
        totals: {
          debit: out(totalDebit),
          credit: out(totalCredit),
          net: out(totalDebit - totalCredit),
        },
        ledger: { debit: out(ledgerDebit), credit: out(ledgerCredit) },
        consistent: totalDebit === ledgerDebit && totalCredit === ledgerCredit,
      }
    })
  }
}
