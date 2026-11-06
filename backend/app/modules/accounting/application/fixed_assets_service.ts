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
import { costCenterFacts } from '#modules/organization/index'
import { tenantSettings } from '#modules/settings/index'
import { crud } from '#modules/accounting/application/setup_service'
import {
  createEntryInScope,
  lockEntry,
  MANAGED_SOURCE,
  postInScope,
  reverseInScope,
} from '#modules/accounting/application/entries_service'
import { formatDecimal, parseDecimal, rescale } from '#modules/accounting/domain/decimal'
import {
  buildSchedule,
  disposalResult,
  FACTOR_SCALE,
  isMonth,
  METHODS,
  type Method,
  monthEnd,
} from '#modules/accounting/domain/fixed_assets'

/**
 * Activos fixos (6.6): classes (contas, diário, vida útil e método por omissão), fichas, aquisição, transferência,
 * depreciação mensal e abate. Os movimentos contabilísticos são lançamentos normais do razão criados e contabilizados
 * aqui (origem FIXED_ASSETS), sempre na mesma transacção que altera a ficha; só se estornam por aqui.
 */
const CODE = /^[A-Za-z0-9._/-]{1,30}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}$/
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const STORE = 6
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const optional = (v: unknown, max: number) => text(v).slice(0, max) || null
const monthOf = (date: string) => date.slice(0, 7)
const ACCOUNT_KEYS = [
  'assetAccountId',
  'accumulatedAccountId',
  'expenseAccountId',
  'gainAccountId',
  'lossAccountId',
] as const

export const CLASS_SPEC = {
  table: 'fixed_asset_classes',
  columns: {
    legalEntityId: 'legal_entity_id',
    code: 'code',
    name: 'name',
    method: 'method',
    usefulLifeMonths: 'useful_life_months',
    decliningFactor: 'declining_factor',
    journalId: 'journal_id',
    assetAccountId: 'asset_account_id',
    accumulatedAccountId: 'accumulated_account_id',
    expenseAccountId: 'expense_account_id',
    gainAccountId: 'gain_account_id',
    lossAccountId: 'loss_account_id',
    status: 'status',
  },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    fixed_asset_classes_code_unique: {
      code: 'CLASS_CODE_TAKEN',
      message: 'Já existe uma classe com este código nesta entidade.',
    },
  },
} satisfies CrudSpec

export const ASSET_SPEC = {
  table: 'fixed_assets',
  columns: {
    legalEntityId: 'legal_entity_id',
    classId: 'class_id',
    number: 'number',
    name: 'name',
    description: 'description',
    serialNumber: 'serial_number',
    supplierName: 'supplier_name',
    acquisitionDocument: 'acquisition_document',
    acquisitionDate: 'acquisition_date',
    cost: 'cost',
    residualValue: 'residual_value',
    usefulLifeMonths: 'useful_life_months',
    method: 'method',
    decliningFactor: 'declining_factor',
    depreciationStart: 'depreciation_start',
    location: 'location',
    costCenterId: 'cost_center_id',
    status: 'status',
    acquisitionEntryId: 'acquisition_entry_id',
    disposalDate: 'disposal_date',
    disposalProceeds: 'disposal_proceeds',
    disposalReason: 'disposal_reason',
    disposalEntryId: 'disposal_entry_id',
  },
  dateColumns: ['acquisition_date', 'depreciation_start', 'disposal_date'],
  searchColumns: ['number', 'name', 'serial_number', 'location'],
  orderBy: 'number',
  uniqueErrors: {
    fixed_assets_number_unique: {
      code: 'ASSET_NUMBER_TAKEN',
      message: 'Já existe um activo com este n.º de inventário nesta entidade.',
    },
    fixed_assets_serial_unique: {
      code: 'DUPLICATE_SERIAL',
      message: 'Já existe um activo com este n.º de série nesta entidade (possível duplicado).',
    },
  },
} satisfies CrudSpec

interface ClassRow extends Row {
  legalEntityId: string
  code: string
  name: string
  method: Method
  usefulLifeMonths: number
  decliningFactor: string | null
  journalId: string
  assetAccountId: string
  accumulatedAccountId: string
  expenseAccountId: string
  gainAccountId: string
  lossAccountId: string
  status: string
}

interface AssetRow extends Row {
  legalEntityId: string
  classId: string
  number: string
  name: string
  acquisitionDate: string
  cost: string
  residualValue: string
  usefulLifeMonths: number
  method: Method
  decliningFactor: string | null
  depreciationStart: string
  location: string | null
  costCenterId: string | null
  status: 'DRAFT' | 'ACTIVE' | 'DISPOSED'
  acquisitionEntryId: string | null
  disposalDate: string | null
  disposalProceeds: string | null
  disposalEntryId: string | null
}

const toInt = (v: string | null, scale: number) => (v === null ? 0n : parseDecimal(v, scale)!)
const money = (v: bigint, scale: number) => formatDecimal(v, scale)

function scheduleOf(a: AssetRow, scale: number) {
  return buildSchedule({
    cost: rescale(toInt(a.cost, STORE), STORE, scale, 'HALF_UP'),
    residual: rescale(toInt(a.residualValue, STORE), STORE, scale, 'HALF_UP'),
    lifeMonths: a.usefulLifeMonths,
    method: a.method,
    factor: a.decliningFactor ? parseDecimal(a.decliningFactor, FACTOR_SCALE) : null,
    startMonth: monthOf(a.depreciationStart),
  })
}

/** Ficha com os montantes na escala da empresa (a base guarda 6 casas). */
function present(a: Row, scale: number) {
  const out: Record<string, unknown> = { ...a }
  for (const k of ['cost', 'residualValue', 'disposalProceeds'])
    if (typeof a[k] === 'string')
      out[k] = money(rescale(toInt(a[k] as string, STORE), STORE, scale, 'HALF_UP'), scale)
  if (typeof a.depreciationStart === 'string') out.depreciationStart = monthOf(a.depreciationStart)
  return out
}

async function scaleOf(scope: TenantScope) {
  return (await tenantSettings(scope)).amountScale
}

/** Contas do plano activo da entidade (para validar as contas de uma classe). */
async function chartAccounts(scope: TenantScope, legalEntityId: string, ids: string[]) {
  const r = await scope.trx.rawQuery(
    `select a.id, a.code, a.postable, a.status from accounts a
       join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
      where a.tenant_id = ? and c.legal_entity_id = ? and c.status = 'ACTIVE' and a.id = any(?::uuid[])`,
    [scope.context.tenantId, legalEntityId, ids]
  )
  return new Map(
    (r.rows as { id: string; code: string; postable: boolean; status: string }[]).map((a) => [
      a.id,
      a,
    ])
  )
}

async function legalEntityOk(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    'select 1 from legal_entities where tenant_id = ? and id = ?',
    [scope.context.tenantId, id]
  )
  return r.rows.length > 0
}

async function classInUse(scope: TenantScope, classId: string) {
  const r = await scope.trx.rawQuery(
    `select 1 from fixed_assets where tenant_id = ? and class_id = ? and status <> 'DRAFT' limit 1`,
    [scope.context.tenantId, classId]
  )
  return r.rows.length > 0
}

function lifeIssue(v: unknown, path: string): ErrorDetail | null {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1200
    ? null
    : { path, code: 'INVALID', message: 'Vida útil em meses (1 a 1200).' }
}

/** Coeficiente degressivo: obrigatório (1,00 a 4,00) no método degressivo, ignorado na linha recta. */
function factorOf(method: unknown, raw: unknown, issues: ErrorDetail[], fallback: string | null) {
  if (method !== 'DECLINING_BALANCE') return null
  const value = raw === undefined || raw === null || raw === '' ? fallback : String(raw)
  const f = value === null ? null : parseDecimal(value, FACTOR_SCALE)
  if (f === null || f < 100n || f > 400n) {
    issues.push({
      path: 'decliningFactor',
      code: 'INVALID',
      message: 'Coeficiente degressivo entre 1,00 e 4,00.',
    })
    return null
  }
  return formatDecimal(f, FACTOR_SCALE)
}

export class FixedAssetSetupService {
  listClasses(
    context: TenantContext,
    filter: { equals: Record<string, unknown>; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, (scope) => crudList(crud(context, scope.trx), CLASS_SPEC, filter))
  }

  getClass(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const row = await crudFind(crud(context, scope.trx), CLASS_SPEC, id)
      if (!row) throw ApiError.notFound()
      return row
    })
  }

  /**
   * Classe: contas movimentáveis e activas do plano activo da entidade, diário activo da entidade. Com activos já
   * contabilizados, as contas do activo e das amortizações acumuladas deixam de mudar (o abate tem de sair de onde
   * a aquisição e a depreciação entraram).
   */
  saveClass(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const current = id ? ((await crudFind(s, CLASS_SPEC, id, true)) as ClassRow | null) : null
      if (id && !current) throw ApiError.notFound()
      const issues: ErrorDetail[] = []
      const values: Record<string, unknown> = {}
      const legalEntityId = current ? current.legalEntityId : text(input.legalEntityId)
      if (!current) {
        if (!UUID.test(legalEntityId) || !(await legalEntityOk(scope, legalEntityId)))
          issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade legal.' })
        values.legalEntityId = legalEntityId
        if (!CODE.test(text(input.code)))
          issues.push({ path: 'code', code: 'INVALID', message: 'Código: até 30 caracteres.' })
        values.code = text(input.code)
      } else {
        for (const k of ['legalEntityId', 'code'])
          if (input[k] !== undefined && input[k] !== current[k])
            issues.push({ path: k, code: 'IMMUTABLE', message: 'Não se altera depois de criada.' })
      }
      if (input.name !== undefined || !current) {
        if (text(input.name).length < 2)
          issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 160 caracteres.' })
        values.name = text(input.name).slice(0, 160)
      }
      const method = input.method ?? current?.method ?? 'STRAIGHT_LINE'
      if (!METHODS.includes(method as Method))
        issues.push({ path: 'method', code: 'INVALID', message: 'Linha recta ou degressivo.' })
      if (input.method !== undefined || !current) values.method = method
      if (input.usefulLifeMonths !== undefined || !current) {
        const issue = lifeIssue(input.usefulLifeMonths, 'usefulLifeMonths')
        if (issue) issues.push(issue)
        values.usefulLifeMonths = input.usefulLifeMonths
      }
      if (input.method !== undefined || input.decliningFactor !== undefined || !current)
        values.decliningFactor = factorOf(
          method,
          input.decliningFactor,
          issues,
          current?.decliningFactor ?? null
        )
      if (input.journalId !== undefined || !current) {
        const r = await scope.trx.rawQuery(
          `select 1 from journals where tenant_id = ? and id = ? and legal_entity_id = ? and status = 'ACTIVE'`,
          [
            context.tenantId,
            UUID.test(text(input.journalId)) ? text(input.journalId) : ZERO_UUID,
            legalEntityId,
          ]
        )
        if (r.rows.length === 0)
          issues.push({
            path: 'journalId',
            code: 'NOT_FOUND',
            message: 'Diário activo da entidade.',
          })
        values.journalId = input.journalId
      }
      const changed = ACCOUNT_KEYS.filter((k) => input[k] !== undefined || !current)
      if (changed.length > 0) {
        const ids = changed.map((k) => text(input[k])).filter((x) => UUID.test(x))
        const accounts = await chartAccounts(scope, legalEntityId, ids)
        const used = current ? await classInUse(scope, current.id) : false
        for (const k of changed) {
          const a = accounts.get(text(input[k]))
          if (!a)
            issues.push({
              path: k,
              code: 'NOT_FOUND',
              message: 'Conta do plano activo da entidade.',
            })
          else if (!a.postable || a.status !== 'ACTIVE')
            issues.push({
              path: k,
              code: 'NOT_POSTABLE',
              message: `A conta ${a.code} não é movimentável ou está inactiva.`,
            })
          if (
            used &&
            (k === 'assetAccountId' || k === 'accumulatedAccountId') &&
            input[k] !== current![k]
          )
            issues.push({
              path: k,
              code: 'IN_USE',
              message: 'Há activos contabilizados nesta classe: esta conta já não muda.',
            })
          values[k] = input[k]
        }
      }
      if (input.status !== undefined) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
        values.status = input.status
      }
      if (issues.length) throw ApiError.validation(issues)
      const row = current
        ? await crudUpdate(s, CLASS_SPEC, current.id, Number(input.expectedVersion), values)
        : await crudInsert(s, CLASS_SPEC, values)
      await audit(scope, {
        action: current ? 'fixed_asset_class.updated' : 'fixed_asset_class.created',
        entityType: 'fixed_asset_class',
        entityId: row.id,
        changes: diff(current, row, Object.keys(CLASS_SPEC.columns)),
      })
      return row
    })
  }
}

// ---------------------------------------------------------------- fichas

async function loadAsset(scope: TenantScope, id: string, lock = false) {
  return (await crudFind(crud(scope.context, scope.trx), ASSET_SPEC, id, lock)) as AssetRow | null
}

async function loadClass(scope: TenantScope, id: string) {
  return (await crudFind(crud(scope.context, scope.trx), CLASS_SPEC, id)) as ClassRow | null
}

function expectVersion(a: AssetRow, expected: unknown) {
  if (Number(expected) !== a.version) throw ApiError.versionConflict(a.version)
}

function expectAssetStatus(a: AssetRow, ...allowed: AssetRow['status'][]) {
  if (!allowed.includes(a.status))
    throw ApiError.conflict(
      'INVALID_STATUS',
      `Operação não permitida com o activo ${a.status === 'DRAFT' ? 'por contabilizar' : a.status === 'ACTIVE' ? 'em uso' : 'abatido'}.`
    )
}

async function depreciatedMonths(scope: TenantScope, assetIds: string[]) {
  const map = new Map<string, Map<string, { amount: string; entryId: string }>>()
  if (assetIds.length === 0) return map
  const r = await scope.trx.rawQuery(
    `select asset_id, to_char(month, 'YYYY-MM') as month, amount::text as amount, entry_id
       from fixed_asset_depreciations where tenant_id = ? and asset_id = any(?::uuid[])`,
    [scope.context.tenantId, assetIds]
  )
  for (const row of r.rows as {
    asset_id: string
    month: string
    amount: string
    entry_id: string
  }[]) {
    if (!map.has(row.asset_id)) map.set(row.asset_id, new Map())
    map.get(row.asset_id)!.set(row.month, { amount: row.amount, entryId: row.entry_id })
  }
  return map
}

async function costCenterOk(scope: TenantScope, legalEntityId: string, id: string) {
  const cc = (await costCenterFacts(scope, UUID.test(id) ? [id] : [])).get(id)
  return !!cc && cc.legalEntityId === legalEntityId && cc.status === 'ACTIVE'
}

async function movement(
  scope: TenantScope,
  assetId: string,
  m: {
    type: string
    date: string
    fromLocation?: string | null
    toLocation?: string | null
    fromCostCenterId?: string | null
    toCostCenterId?: string | null
    entryId?: string | null
    notes?: string | null
  }
) {
  await scope.trx.rawQuery(
    `insert into fixed_asset_movements (tenant_id, created_by, updated_by, asset_id, type, movement_date, from_location,
       to_location, from_cost_center_id, to_cost_center_id, entry_id, notes)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      scope.context.userId,
      scope.context.userId,
      assetId,
      m.type,
      m.date,
      m.fromLocation ?? null,
      m.toLocation ?? null,
      m.fromCostCenterId ?? null,
      m.toCostCenterId ?? null,
      m.entryId ?? null,
      m.notes ?? null,
    ] as never[]
  )
}

/** Cria e contabiliza um lançamento dos activos fixos (sem passar por aprovação: a permissão é a autorização). */
async function postEntry(scope: TenantScope, input: Record<string, unknown>) {
  const { entry } = await createEntryInScope(scope, input, MANAGED_SOURCE)
  const locked = await lockEntry(scope, entry.id, true)
  return postInScope(scope, locked!)
}

async function setAsset(scope: TenantScope, a: AssetRow, values: Record<string, unknown>) {
  return (await crudUpdate(
    crud(scope.context, scope.trx),
    ASSET_SPEC,
    a.id,
    a.version,
    values
  )) as AssetRow
}

export class FixedAssetService {
  list(
    context: TenantContext,
    filter: { equals: Record<string, unknown>; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const scale = await scaleOf(scope)
      const page = await crudList(crud(context, scope.trx), ASSET_SPEC, filter)
      const done = await depreciatedMonths(
        scope,
        page.items.map((a) => a.id)
      )
      return {
        total: page.total,
        items: page.items.map((a) => {
          const accumulated = [...(done.get(a.id)?.values() ?? [])].reduce(
            (sum, d) => sum + rescale(toInt(d.amount, STORE), STORE, scale, 'HALF_UP'),
            0n
          )
          const cost = rescale(toInt(a.cost as string, STORE), STORE, scale, 'HALF_UP')
          return {
            ...present(a, scale),
            accumulated: money(accumulated, scale),
            bookValue: money(a.status === 'DISPOSED' ? 0n : cost - accumulated, scale),
          }
        }),
      }
    })
  }

  /** Ficha com o mapa de depreciação (feito e previsto), movimentos e lançamentos. */
  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id)
      if (!a) throw ApiError.notFound()
      return detail(scope, a)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const values = await validateAsset(scope, input, null)
      const row = (await crudInsert(crud(context, scope.trx), ASSET_SPEC, values)) as AssetRow
      await audit(scope, {
        action: 'fixed_asset.created',
        entityType: 'fixed_asset',
        entityId: row.id,
        changes: diff(null, row, Object.keys(ASSET_SPEC.columns)),
      })
      return detail(scope, row)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id, true)
      if (!a) throw ApiError.notFound()
      expectVersion(a, input.expectedVersion)
      expectAssetStatus(a, 'DRAFT', 'ACTIVE')
      const values = await validateAsset(scope, input, a)
      const row = Object.keys(values).length ? await setAsset(scope, a, values) : a
      await audit(scope, {
        action: 'fixed_asset.updated',
        entityType: 'fixed_asset',
        entityId: a.id,
        changes: diff(a, row, Object.keys(ASSET_SPEC.columns)),
      })
      return detail(scope, row)
    })
  }

  /** Só fichas por contabilizar (sem lançamentos) se apagam; as outras ficam para o histórico. */
  delete(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id, true)
      if (!a) throw ApiError.notFound()
      expectAssetStatus(a, 'DRAFT')
      const used = await scope.trx.rawQuery(
        'select 1 from fixed_asset_movements where tenant_id = ? and asset_id = ? limit 1',
        [context.tenantId, a.id]
      )
      if (used.rows.length > 0)
        throw ApiError.conflict('HAS_HISTORY', 'O activo já teve movimentos: não se apaga.')
      await scope.trx.rawQuery('delete from fixed_assets where tenant_id = ? and id = ?', [
        context.tenantId,
        a.id,
      ])
      await audit(scope, {
        action: 'fixed_asset.deleted',
        entityType: 'fixed_asset',
        entityId: a.id,
        metadata: { number: a.number },
      })
    })
  }

  /**
   * Aquisição: débito da conta do activo, crédito da contrapartida (fornecedor, banco, imobilizado em curso…), pelo
   * custo, na data indicada (por omissão a da aquisição). O activo passa a "em uso".
   */
  acquire(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id, true)
      if (!a) throw ApiError.notFound()
      expectVersion(a, input.expectedVersion)
      expectAssetStatus(a, 'DRAFT')
      const cls = (await loadClass(scope, a.classId))!
      const date = text(input.date) || a.acquisitionDate
      const issues: ErrorDetail[] = []
      if (!ISO.test(date) || date < a.acquisitionDate)
        issues.push({
          path: 'date',
          code: 'INVALID',
          message: 'Data igual ou posterior à da aquisição.',
        })
      if (!UUID.test(text(input.counterpartAccountId)))
        issues.push({
          path: 'counterpartAccountId',
          code: 'REQUIRED',
          message: 'Conta de contrapartida (fornecedor, banco, …).',
        })
      if (cls.status !== 'ACTIVE')
        issues.push({ path: 'classId', code: 'INACTIVE', message: 'A classe está inactiva.' })
      if (issues.length) throw ApiError.validation(issues)
      const scale = await scaleOf(scope)
      const cost = money(rescale(toInt(a.cost, STORE), STORE, scale, 'HALF_UP'), scale)
      const entry = await postEntry(scope, {
        legalEntityId: a.legalEntityId,
        journalId: cls.journalId,
        entryDate: date,
        reference: a.number,
        description: `Aquisição do activo ${a.number} — ${a.name}`,
        sourceRef: `ACQ:${a.id}`,
        idempotencyKey: `fa:acq:${a.id}:${a.version}`,
        lines: [
          {
            accountId: cls.assetAccountId,
            debit: cost,
            credit: null,
            costCenterId: a.costCenterId,
            description: `${a.number} ${a.name}`.slice(0, 300),
          },
          {
            accountId: input.counterpartAccountId,
            debit: null,
            credit: cost,
            thirdPartyRef: optional(input.thirdPartyRef, 60),
            description: optional(a.acquisitionDocument, 60),
          },
        ],
      })
      const row = await setAsset(scope, a, { status: 'ACTIVE', acquisitionEntryId: entry.id })
      await movement(scope, a.id, {
        type: 'ACQUISITION',
        date,
        toLocation: a.location,
        toCostCenterId: a.costCenterId,
        entryId: entry.id,
      })
      await audit(scope, {
        action: 'fixed_asset.acquired',
        entityType: 'fixed_asset',
        entityId: a.id,
        changes: { status: { from: 'DRAFT', to: 'ACTIVE' } },
        metadata: { entryId: entry.id, number: entry.number, cost },
      })
      return detail(scope, row)
    })
  }

  /**
   * Transferência de localização e/ou centro de custo dentro da entidade. Não mexe no razão: as depreciações a partir
   * do mês da transferência vão para o novo centro. Não pode cair num mês já depreciado.
   */
  transfer(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id, true)
      if (!a) throw ApiError.notFound()
      expectVersion(a, input.expectedVersion)
      expectAssetStatus(a, 'ACTIVE')
      const issues: ErrorDetail[] = []
      const date = text(input.date)
      if (!ISO.test(date) || date < a.acquisitionDate)
        issues.push({
          path: 'date',
          code: 'INVALID',
          message: 'Data igual ou posterior à da aquisição.',
        })
      else {
        const last = await lastDepreciated(scope, a.id)
        if (last && monthOf(date) <= last)
          issues.push({
            path: 'date',
            code: 'MONTH_DEPRECIATED',
            message: `${last} já foi depreciado: a transferência tem de ser num mês posterior.`,
          })
      }
      const location = input.location === undefined ? a.location : optional(input.location, 160)
      const costCenterId =
        input.costCenterId === undefined ? a.costCenterId : text(input.costCenterId) || null
      if (costCenterId && costCenterId !== a.costCenterId)
        if (!(await costCenterOk(scope, a.legalEntityId, costCenterId)))
          issues.push({
            path: 'costCenterId',
            code: 'NOT_FOUND',
            message: 'Centro de custo activo desta entidade.',
          })
      if (location === a.location && costCenterId === a.costCenterId)
        issues.push({
          path: 'location',
          code: 'NO_CHANGE',
          message: 'Indique uma nova localização ou centro de custo.',
        })
      if (issues.length) throw ApiError.validation(issues)
      const row = await setAsset(scope, a, { location, costCenterId })
      await movement(scope, a.id, {
        type: 'TRANSFER',
        date,
        fromLocation: a.location,
        toLocation: location,
        fromCostCenterId: a.costCenterId,
        toCostCenterId: costCenterId,
        notes: optional(input.notes, 300),
      })
      await audit(scope, {
        action: 'fixed_asset.transferred',
        entityType: 'fixed_asset',
        entityId: a.id,
        changes: diff(a, row, ['location', 'costCenterId']),
        metadata: { date },
      })
      return detail(scope, row)
    })
  }

  /**
   * Abate (venda ou baixa). Exige as depreciações até ao mês anterior ao do abate e nenhuma depois; sai o custo, saem
   * as amortizações acumuladas, entra o valor de venda e a diferença vai a ganho ou perda.
   */
  dispose(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id, true)
      if (!a) throw ApiError.notFound()
      expectVersion(a, input.expectedVersion)
      expectAssetStatus(a, 'ACTIVE')
      const cls = (await loadClass(scope, a.classId))!
      const scale = await scaleOf(scope)
      const issues: ErrorDetail[] = []
      const date = text(input.date)
      const proceedsRaw =
        input.proceeds === undefined || input.proceeds === '' ? '0' : input.proceeds
      const proceeds = parseDecimal(proceedsRaw, scale)
      if (!ISO.test(date) || date < a.acquisitionDate)
        issues.push({
          path: 'date',
          code: 'INVALID',
          message: 'Data igual ou posterior à da aquisição.',
        })
      if (proceeds === null)
        issues.push({
          path: 'proceeds',
          code: 'INVALID',
          message: `Valor de venda: decimal positivo ou zero, até ${scale} casas.`,
        })
      if (proceeds && proceeds > 0n && !UUID.test(text(input.proceedsAccountId)))
        issues.push({
          path: 'proceedsAccountId',
          code: 'REQUIRED',
          message: 'Conta onde entra o valor de venda.',
        })
      if (text(input.reason).length < 3)
        issues.push({ path: 'reason', code: 'REQUIRED', message: 'Motivo do abate.' })
      if (issues.length) throw ApiError.validation(issues)
      const month = monthOf(date)
      const done = (await depreciatedMonths(scope, [a.id])).get(a.id) ?? new Map()
      const after = [...done.keys()].filter((m) => m >= month).sort()
      if (after.length > 0)
        throw ApiError.conflict(
          'DEPRECIATED_AFTER',
          `Já há depreciação em ${after[0]}, no mês do abate ou depois: anule-a primeiro.`
        )
      const missing = scheduleOf(a, scale)
        .filter((r) => r.month < month && !done.has(r.month))
        .map((r) => r.month)
      if (missing.length > 0)
        throw ApiError.validation([
          {
            path: 'date',
            code: 'DEPRECIATION_PENDING',
            message: `Faltam depreciações de ${missing.length} mês(es) antes do abate (primeiro: ${missing[0]}).`,
          },
        ])
      const cost = rescale(toInt(a.cost, STORE), STORE, scale, 'HALF_UP')
      const accumulated = [...done.values()].reduce(
        (sum, d) => sum + rescale(toInt(d.amount, STORE), STORE, scale, 'HALF_UP'),
        0n
      )
      const result = disposalResult(cost, accumulated, proceeds!)
      const line = (accountId: string, side: 'debit' | 'credit', amount: bigint, extra = {}) => ({
        accountId,
        debit: side === 'debit' ? money(amount, scale) : null,
        credit: side === 'credit' ? money(amount, scale) : null,
        costCenterId: a.costCenterId,
        ...extra,
      })
      const lines = [
        line(cls.assetAccountId, 'credit', cost),
        accumulated > 0n ? line(cls.accumulatedAccountId, 'debit', accumulated) : null,
        proceeds! > 0n
          ? line(text(input.proceedsAccountId), 'debit', proceeds!, {
              costCenterId: null,
              thirdPartyRef: optional(input.thirdPartyRef, 60),
            })
          : null,
        result.gain > 0n ? line(cls.gainAccountId, 'credit', result.gain) : null,
        result.loss > 0n ? line(cls.lossAccountId, 'debit', result.loss) : null,
      ].filter((l) => l !== null)
      const entry = await postEntry(scope, {
        legalEntityId: a.legalEntityId,
        journalId: cls.journalId,
        entryDate: date,
        reference: a.number,
        description: `Abate do activo ${a.number} — ${a.name}`,
        sourceRef: `DSP:${a.id}`,
        idempotencyKey: `fa:dsp:${a.id}:${a.version}`,
        lines,
      })
      const row = await setAsset(scope, a, {
        status: 'DISPOSED',
        disposalDate: date,
        disposalProceeds: money(proceeds!, scale),
        disposalReason: text(input.reason).slice(0, 300),
        disposalEntryId: entry.id,
      })
      await movement(scope, a.id, {
        type: 'DISPOSAL',
        date,
        fromLocation: a.location,
        fromCostCenterId: a.costCenterId,
        entryId: entry.id,
        notes: text(input.reason).slice(0, 300),
      })
      await audit(scope, {
        action: 'fixed_asset.disposed',
        entityType: 'fixed_asset',
        entityId: a.id,
        changes: { status: { from: 'ACTIVE', to: 'DISPOSED' } },
        metadata: {
          entryId: entry.id,
          number: entry.number,
          bookValue: money(result.bookValue, scale),
          proceeds: money(proceeds!, scale),
          gain: money(result.gain, scale),
          loss: money(result.loss, scale),
        },
      })
      return detail(scope, row)
    })
  }

  /** Anula a aquisição (estorno) enquanto não houver depreciações: a ficha volta a "por contabilizar". */
  reverseAcquisition(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id, true)
      if (!a) throw ApiError.notFound()
      expectVersion(a, input.expectedVersion)
      expectAssetStatus(a, 'ACTIVE')
      if (await lastDepreciated(scope, a.id))
        throw ApiError.conflict(
          'HAS_DEPRECIATION',
          'O activo já foi depreciado: anule primeiro as depreciações.'
        )
      const reversal = await reverseManaged(scope, a.acquisitionEntryId!, input)
      const row = await setAsset(scope, a, { status: 'DRAFT', acquisitionEntryId: null })
      await movement(scope, a.id, {
        type: 'ACQUISITION_REVERSED',
        date: reversal.entryDate as string,
        entryId: reversal.id as string,
        notes: optional(input.reason, 300),
      })
      await audit(scope, {
        action: 'fixed_asset.acquisition_reversed',
        entityType: 'fixed_asset',
        entityId: a.id,
        changes: { status: { from: 'ACTIVE', to: 'DRAFT' } },
        metadata: { reversalId: reversal.id, number: reversal.number },
      })
      return detail(scope, row)
    })
  }

  /** Anula o abate (estorno): o activo volta a "em uso" e as depreciações seguintes voltam a ser devidas. */
  reverseDisposal(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await loadAsset(scope, id, true)
      if (!a) throw ApiError.notFound()
      expectVersion(a, input.expectedVersion)
      expectAssetStatus(a, 'DISPOSED')
      const reversal = await reverseManaged(scope, a.disposalEntryId!, input)
      const row = await setAsset(scope, a, {
        status: 'ACTIVE',
        disposalDate: null,
        disposalProceeds: null,
        disposalReason: null,
        disposalEntryId: null,
      })
      await movement(scope, a.id, {
        type: 'DISPOSAL_REVERSED',
        date: reversal.entryDate as string,
        toLocation: a.location,
        toCostCenterId: a.costCenterId,
        entryId: reversal.id as string,
        notes: optional(input.reason, 300),
      })
      await audit(scope, {
        action: 'fixed_asset.disposal_reversed',
        entityType: 'fixed_asset',
        entityId: a.id,
        changes: { status: { from: 'DISPOSED', to: 'ACTIVE' } },
        metadata: { reversalId: reversal.id, number: reversal.number },
      })
      return detail(scope, row)
    })
  }
}

async function reverseManaged(scope: TenantScope, entryId: string, input: Record<string, unknown>) {
  const entry = await lockEntry(scope, entryId, true)
  const date = text(input.date)
  if (!ISO.test(date))
    throw ApiError.validation([
      { path: 'date', code: 'REQUIRED', message: 'Data do estorno (AAAA-MM-DD).' },
    ])
  return (await reverseInScope(scope, entry!, {
    date,
    description: optional(input.reason, 500),
  })) as Record<string, unknown>
}

async function lastDepreciated(scope: TenantScope, assetId: string) {
  const r = await scope.trx.rawQuery(
    `select to_char(max(month), 'YYYY-MM') as m from fixed_asset_depreciations where tenant_id = ? and asset_id = ?`,
    [scope.context.tenantId, assetId]
  )
  return (r.rows[0] as { m: string | null }).m
}

/**
 * Valida a ficha. Por contabilizar, tudo se altera; em uso, só os dados descritivos (os valores, a vida útil e o
 * método ficaram no razão e no mapa; a localização muda por transferência).
 */
async function validateAsset(
  scope: TenantScope,
  input: Record<string, unknown>,
  current: AssetRow | null
) {
  const scale = await scaleOf(scope)
  const issues: ErrorDetail[] = []
  const values: Record<string, unknown> = {}
  const has = (k: string) => input[k] !== undefined || !current
  const financial = [
    'classId',
    'acquisitionDate',
    'cost',
    'residualValue',
    'usefulLifeMonths',
    'method',
    'decliningFactor',
    'depreciationStart',
    'number',
  ]
  if (current?.status === 'ACTIVE') {
    for (const k of [...financial, 'location', 'costCenterId'])
      if (
        input[k] !== undefined &&
        String(input[k] ?? '') !== String(present(current, scale)[k] ?? '')
      )
        issues.push({
          path: k,
          code: 'IMMUTABLE',
          message:
            k === 'location' || k === 'costCenterId'
              ? 'Mude a localização por transferência.'
              : 'O activo já está contabilizado: este dado já não muda.',
        })
  }
  const editable = !current || current.status === 'DRAFT'
  let cls: ClassRow | null = current ? await loadClass(scope, current.classId) : null
  if (editable && has('classId')) {
    const id = text(input.classId)
    cls = UUID.test(id) ? await loadClass(scope, id) : null
    if (!cls || cls.status !== 'ACTIVE')
      issues.push({ path: 'classId', code: 'NOT_FOUND', message: 'Classe de activos activa.' })
    else {
      values.classId = cls.id
      values.legalEntityId = cls.legalEntityId
    }
  }
  if (editable && has('number')) {
    if (!CODE.test(text(input.number)))
      issues.push({
        path: 'number',
        code: 'INVALID',
        message: 'N.º de inventário: até 30 caracteres (letras, números, . _ / -).',
      })
    values.number = text(input.number)
  }
  if (has('name')) {
    if (text(input.name).length < 2)
      issues.push({ path: 'name', code: 'REQUIRED', message: 'Designação de 2 a 160 caracteres.' })
    values.name = text(input.name).slice(0, 160)
  }
  for (const [k, max] of [
    ['description', 2000],
    ['serialNumber', 80],
    ['supplierName', 160],
    ['acquisitionDocument', 60],
  ] as const)
    if (input[k] !== undefined) values[k] = optional(input[k], max)
  if (!editable) return finish(issues, values)

  const acquisitionDate = has('acquisitionDate')
    ? text(input.acquisitionDate)
    : current!.acquisitionDate
  if (!ISO.test(acquisitionDate))
    issues.push({ path: 'acquisitionDate', code: 'REQUIRED', message: 'Data de aquisição.' })
  if (has('acquisitionDate')) values.acquisitionDate = acquisitionDate
  const cost = parseDecimal(has('cost') ? input.cost : current!.cost, has('cost') ? scale : STORE)
  if (cost === null || cost <= 0n)
    issues.push({
      path: 'cost',
      code: 'INVALID',
      message: `Custo de aquisição: decimal positivo, até ${scale} casas.`,
    })
  else if (has('cost')) values.cost = money(cost, scale)
  const residualRaw = has('residualValue')
    ? input.residualValue === undefined || input.residualValue === ''
      ? '0'
      : input.residualValue
    : current!.residualValue
  const residual = parseDecimal(residualRaw, has('residualValue') ? scale : STORE)
  const costStore =
    cost === null ? null : has('cost') ? rescale(cost, scale, STORE, 'HALF_UP') : cost
  const residualStore =
    residual === null
      ? null
      : has('residualValue')
        ? rescale(residual, scale, STORE, 'HALF_UP')
        : residual
  if (residualStore === null || (costStore !== null && residualStore >= costStore))
    issues.push({
      path: 'residualValue',
      code: 'INVALID',
      message: 'Valor residual: zero ou positivo, menor do que o custo.',
    })
  else if (has('residualValue')) values.residualValue = money(residual!, scale)

  const method = input.method ?? (values.classId ? cls?.method : current?.method) ?? cls?.method
  if (!METHODS.includes(method as Method))
    issues.push({ path: 'method', code: 'INVALID', message: 'Linha recta ou degressivo.' })
  else values.method = method
  const life =
    input.usefulLifeMonths ??
    (values.classId ? cls?.usefulLifeMonths : current?.usefulLifeMonths) ??
    cls?.usefulLifeMonths
  const lifeError = lifeIssue(life, 'usefulLifeMonths')
  if (lifeError) issues.push(lifeError)
  else values.usefulLifeMonths = life
  values.decliningFactor = factorOf(
    method,
    input.decliningFactor,
    issues,
    (values.classId ? cls?.decliningFactor : current?.decliningFactor) ??
      cls?.decliningFactor ??
      null
  )
  const startRaw = text(input.depreciationStart)
  const start = startRaw
    ? startRaw.slice(0, 7)
    : current && input.acquisitionDate === undefined
      ? monthOf(current.depreciationStart)
      : monthOf(acquisitionDate)
  if (!isMonth(start) || (ISO.test(acquisitionDate) && start < monthOf(acquisitionDate)))
    issues.push({
      path: 'depreciationStart',
      code: 'INVALID',
      message: 'Início da depreciação (AAAA-MM), no mês da aquisição ou depois.',
    })
  else values.depreciationStart = `${start}-01`

  const legalEntityId = (values.legalEntityId as string) ?? current?.legalEntityId
  if (has('location')) values.location = optional(input.location, 160)
  if (has('costCenterId')) {
    const cc = text(input.costCenterId) || null
    if (cc && legalEntityId && !(await costCenterOk(scope, legalEntityId, cc)))
      issues.push({
        path: 'costCenterId',
        code: 'NOT_FOUND',
        message: 'Centro de custo activo desta entidade.',
      })
    values.costCenterId = cc
  }
  if (current && values.legalEntityId && values.legalEntityId !== current.legalEntityId)
    issues.push({
      path: 'classId',
      code: 'OTHER_ENTITY',
      message: 'A classe tem de ser da mesma entidade legal.',
    })
  return finish(issues, values)
}

function finish(issues: ErrorDetail[], values: Record<string, unknown>) {
  if (issues.length) throw ApiError.validation(issues)
  return values
}

async function detail(scope: TenantScope, a: AssetRow) {
  const scale = await scaleOf(scope)
  const cls = await loadClass(scope, a.classId)
  const done = (await depreciatedMonths(scope, [a.id])).get(a.id) ?? new Map()
  const entryIds = [
    a.acquisitionEntryId,
    a.disposalEntryId,
    ...[...done.values()].map((d) => d.entryId),
  ].filter((x): x is string => !!x)
  const movements = await scope.trx.rawQuery(
    `select m.id, m.type, m.movement_date::text as date, m.from_location as "fromLocation", m.to_location as "toLocation",
            m.from_cost_center_id as "fromCostCenterId", m.to_cost_center_id as "toCostCenterId", m.entry_id as "entryId",
            m.notes, m.created_at as "createdAt"
       from fixed_asset_movements m where m.tenant_id = ? and m.asset_id = ? order by m.movement_date, m.created_at`,
    [scope.context.tenantId, a.id]
  )
  for (const m of movements.rows as { entryId: string | null }[])
    if (m.entryId) entryIds.push(m.entryId)
  const numbers = await scope.trx.rawQuery(
    'select id, number from journal_entries where tenant_id = ? and id = any(?::uuid[])',
    [scope.context.tenantId, [...new Set(entryIds)]]
  )
  const numberOf = new Map(
    (numbers.rows as { id: string; number: string }[]).map((r) => [r.id, r.number])
  )
  const disposalMonth = a.disposalDate ? monthOf(a.disposalDate) : null
  let accumulated = 0n
  const schedule = scheduleOf(a, scale)
    .filter((r) => !disposalMonth || r.month < disposalMonth || done.has(r.month))
    .map((r) => {
      const posted = done.get(r.month)
      const amount = posted ? rescale(toInt(posted.amount, STORE), STORE, scale, 'HALF_UP') : null
      if (amount !== null) accumulated += amount
      return {
        month: r.month,
        amount: money(r.amount, scale),
        accumulated: money(r.accumulated, scale),
        bookValue: money(r.bookValue, scale),
        posted: !!posted,
        entryId: posted?.entryId ?? null,
        entryNumber: posted ? (numberOf.get(posted.entryId) ?? null) : null,
      }
    })
  const cost = rescale(toInt(a.cost, STORE), STORE, scale, 'HALF_UP')
  return {
    ...present(a, scale),
    class: cls ? { id: cls.id, code: cls.code, name: cls.name } : null,
    acquisitionEntryNumber: a.acquisitionEntryId
      ? (numberOf.get(a.acquisitionEntryId) ?? null)
      : null,
    disposalEntryNumber: a.disposalEntryId ? (numberOf.get(a.disposalEntryId) ?? null) : null,
    accumulated: money(accumulated, scale),
    bookValue: money(a.status === 'DISPOSED' ? 0n : cost - accumulated, scale),
    schedule,
    movements: (movements.rows as { entryId: string | null }[]).map((m) => ({
      ...m,
      entryNumber: m.entryId ? (numberOf.get(m.entryId) ?? null) : null,
    })),
  }
}

// ---------------------------------------------------------------- depreciação

interface PendingRow {
  assetId: string
  number: string
  name: string
  classId: string
  month: string
  amount: bigint
  costCenterId: string | null
}

/**
 * Depreciações devidas até `upTo` (inclusive) para os activos em uso da entidade: meses do mapa ainda sem
 * depreciação. O centro de custo de cada mês é o que estava em vigor no fim do mês (histórico de transferências).
 */
async function pendingDepreciation(
  scope: TenantScope,
  legalEntityId: string,
  upTo: string,
  lock: boolean
) {
  const scale = await scaleOf(scope)
  const s = crud(scope.context, scope.trx)
  const r = await scope.trx.rawQuery(
    `select id from fixed_assets where tenant_id = ? and legal_entity_id = ? and status = 'ACTIVE'
      order by number${lock ? ' for update' : ''}`,
    [scope.context.tenantId, legalEntityId]
  )
  const ids = (r.rows as { id: string }[]).map((x) => x.id)
  const done = await depreciatedMonths(scope, ids)
  const moves = await scope.trx.rawQuery(
    `select asset_id, movement_date::text as date, to_cost_center_id from fixed_asset_movements
      where tenant_id = ? and asset_id = any(?::uuid[]) and type in ('ACQUISITION','TRANSFER','DISPOSAL_REVERSED')
      order by movement_date, created_at`,
    [scope.context.tenantId, ids]
  )
  const history = new Map<string, { date: string; cc: string | null }[]>()
  for (const m of moves.rows as {
    asset_id: string
    date: string
    to_cost_center_id: string | null
  }[]) {
    if (!history.has(m.asset_id)) history.set(m.asset_id, [])
    history.get(m.asset_id)!.push({ date: m.date, cc: m.to_cost_center_id })
  }
  const rows: PendingRow[] = []
  for (const id of ids) {
    const a = (await crudFind(s, ASSET_SPEC, id)) as AssetRow
    const past = done.get(id) ?? new Map()
    for (const line of scheduleOf(a, scale)) {
      if (line.month > upTo) break
      if (past.has(line.month) || line.amount === 0n) continue
      const end = monthEnd(line.month)
      const h = (history.get(id) ?? []).filter((x) => x.date <= end)
      rows.push({
        assetId: id,
        number: a.number,
        name: a.name,
        classId: a.classId,
        month: line.month,
        amount: line.amount,
        costCenterId: h.length ? h[h.length - 1].cc : a.costCenterId,
      })
    }
  }
  return { rows, scale }
}

export class DepreciationService {
  /** Simulação: o que seria depreciado até ao mês indicado, sem gravar. */
  preview(context: TenantContext, legalEntityId: string, upTo: string) {
    return runInTenant(context, async (scope) => {
      await assertEntity(scope, legalEntityId, upTo)
      const { rows, scale } = await pendingDepreciation(scope, legalEntityId, upTo, false)
      return summarize(rows, scale)
    })
  }

  /**
   * Processa as depreciações devidas até `upTo`: um lançamento contabilizado por mês e diário (débito de gastos por
   * conta e centro de custo, crédito de amortizações acumuladas), e uma linha por activo e mês. Concorrência: uma
   * execução de cada vez por entidade e as fichas bloqueadas; a restrição única impede o mesmo mês duas vezes.
   */
  run(context: TenantContext, legalEntityId: string, upTo: string) {
    return runInTenant(context, async (scope) => {
      await assertEntity(scope, legalEntityId, upTo)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `${context.tenantId}:fa:dep:${legalEntityId}`,
      ])
      const { rows, scale } = await pendingDepreciation(scope, legalEntityId, upTo, true)
      if (rows.length === 0)
        throw ApiError.conflict(
          'NOTHING_TO_DEPRECIATE',
          `Não há depreciações por fazer até ${upTo}.`
        )
      const classes = new Map<string, ClassRow>()
      for (const id of new Set(rows.map((r) => r.classId)))
        classes.set(id, (await loadClass(scope, id))!)
      const groups = new Map<string, PendingRow[]>()
      for (const r of rows) {
        const key = `${r.month}|${classes.get(r.classId)!.journalId}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(r)
      }
      const entries: {
        id: string
        number: string
        month: string
        total: string
        assets: number
      }[] = []
      for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const [month, journalId] = key.split('|')
        const sums = new Map<
          string,
          { accountId: string; cc: string | null; side: 'debit' | 'credit'; v: bigint }
        >()
        const add = (accountId: string, cc: string | null, side: 'debit' | 'credit', v: bigint) => {
          const k = `${side}|${accountId}|${cc ?? ''}`
          const cur = sums.get(k) ?? { accountId, cc, side, v: 0n }
          cur.v += v
          sums.set(k, cur)
        }
        for (const r of group) {
          const cls = classes.get(r.classId)!
          add(cls.expenseAccountId, r.costCenterId, 'debit', r.amount)
          add(cls.accumulatedAccountId, r.costCenterId, 'credit', r.amount)
        }
        const total = group.reduce((s, r) => s + r.amount, 0n)
        const entry = await postEntry(scope, {
          legalEntityId,
          journalId,
          entryDate: monthEnd(month),
          reference: `DEP ${month}`,
          description: `Depreciações de ${month} (${group.length} activo(s))`,
          sourceRef: `DEP:${month}`,
          lines: [...sums.values()].map((x) => ({
            accountId: x.accountId,
            debit: x.side === 'debit' ? money(x.v, scale) : null,
            credit: x.side === 'credit' ? money(x.v, scale) : null,
            costCenterId: x.cc,
            description: `Depreciações ${month}`,
          })),
        })
        for (const r of group)
          await scope.trx.rawQuery(
            `insert into fixed_asset_depreciations (tenant_id, created_by, updated_by, asset_id, month, amount, cost_center_id, entry_id)
             values (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              context.tenantId,
              context.userId,
              context.userId,
              r.assetId,
              `${month}-01`,
              money(r.amount, scale),
              r.costCenterId,
              entry.id,
            ] as never[]
          )
        await audit(scope, {
          action: 'fixed_asset.depreciation_posted',
          entityType: 'journal_entry',
          entityId: entry.id,
          metadata: {
            legalEntityId,
            month,
            assets: group.length,
            total: money(total, scale),
            number: entry.number,
          },
        })
        entries.push({
          id: entry.id,
          number: entry.number as string,
          month,
          total: money(total, scale),
          assets: group.length,
        })
      }
      return { ...summarize(rows, scale), entries }
    })
  }

  /**
   * Anula as depreciações de um mês da entidade (estorno dos lançamentos na data indicada). Só o último mês
   * depreciado de cada activo envolvido, e nunca de activos já abatidos.
   */
  undo(
    context: TenantContext,
    legalEntityId: string,
    month: string,
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      await assertEntity(scope, legalEntityId, month)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `${context.tenantId}:fa:dep:${legalEntityId}`,
      ])
      const r = await scope.trx.rawQuery(
        `select d.id, d.asset_id, d.entry_id, a.status, a.number,
                exists (select 1 from fixed_asset_depreciations x where x.tenant_id = d.tenant_id and x.asset_id = d.asset_id
                         and x.month > d.month) as later
           from fixed_asset_depreciations d join fixed_assets a on a.tenant_id = d.tenant_id and a.id = d.asset_id
          where d.tenant_id = ? and a.legal_entity_id = ? and d.month = ?::date
          for update of d, a`,
        [context.tenantId, legalEntityId, `${month}-01`]
      )
      const rows = r.rows as {
        id: string
        asset_id: string
        entry_id: string
        status: string
        number: string
        later: boolean
      }[]
      if (rows.length === 0)
        throw ApiError.conflict(
          'NOTHING_TO_UNDO',
          `Não há depreciações de ${month} nesta entidade.`
        )
      const later = rows.find((x) => x.later)
      if (later)
        throw ApiError.conflict(
          'LATER_MONTHS',
          `O activo ${later.number} já tem meses seguintes depreciados: anule-os primeiro.`
        )
      const disposed = rows.find((x) => x.status === 'DISPOSED')
      if (disposed)
        throw ApiError.conflict(
          'ASSET_DISPOSED',
          `O activo ${disposed.number} foi abatido: anule primeiro o abate.`
        )
      const entryIds = [...new Set(rows.map((x) => x.entry_id))]
      const reversals: { id: string; number: string }[] = []
      await scope.trx.rawQuery(
        'delete from fixed_asset_depreciations where tenant_id = ? and id = any(?::uuid[])',
        [context.tenantId, rows.map((x) => x.id)]
      )
      for (const entryId of entryIds) {
        const rest = await scope.trx.rawQuery(
          'select 1 from fixed_asset_depreciations where tenant_id = ? and entry_id = ? limit 1',
          [context.tenantId, entryId]
        )
        if (rest.rows.length > 0)
          throw new Error('Lançamento de depreciação partilhado entre meses.')
        const reversal = await reverseManaged(scope, entryId, input)
        reversals.push({ id: reversal.id as string, number: reversal.number as string })
      }
      await audit(scope, {
        action: 'fixed_asset.depreciation_reversed',
        entityType: 'legal_entity',
        entityId: legalEntityId,
        metadata: { month, assets: rows.length, entries: entryIds, reversals },
      })
      return { month, assets: rows.length, reversals }
    })
  }

  /**
   * Mapa de depreciação de um exercício: por activo, custo, acumulado no início, depreciação contabilizada no
   * exercício, acumulado no fim e valor líquido, mais o previsto pelo mapa para o exercício; totais por classe.
   */
  map(context: TenantContext, fiscalYearId: string) {
    return runInTenant(context, async (scope) => {
      const fy = await scope.trx.rawQuery(
        `select legal_entity_id, code, start_date::text as start, end_date::text as "end" from fiscal_years where tenant_id = ? and id = ?`,
        [context.tenantId, fiscalYearId]
      )
      const year = fy.rows[0] as
        { legal_entity_id: string; code: string; start: string; end: string } | undefined
      if (!year) throw ApiError.notFound()
      const scale = await scaleOf(scope)
      const from = monthOf(year.start)
      const to = monthOf(year.end)
      const s = crud(context, scope.trx)
      const assets = (
        await scope.trx.rawQuery(
          `select id from fixed_assets where tenant_id = ? and legal_entity_id = ? and status <> 'DRAFT'
             and acquisition_date <= ?::date and (disposal_date is null or disposal_date >= ?::date) order by number`,
          [context.tenantId, year.legal_entity_id, year.end, year.start]
        )
      ).rows as { id: string }[]
      const done = await depreciatedMonths(
        scope,
        assets.map((x) => x.id)
      )
      const classCache = new Map<string, ClassRow>()
      const rows = []
      const totals = new Map<string, Record<string, bigint> & { label?: never }>()
      const zero = () => ({
        cost: 0n,
        opening: 0n,
        period: 0n,
        closing: 0n,
        bookValue: 0n,
        forecast: 0n,
      })
      const grand = zero()
      for (const { id } of assets) {
        const a = (await crudFind(s, ASSET_SPEC, id)) as AssetRow
        if (!classCache.has(a.classId))
          classCache.set(a.classId, (await loadClass(scope, a.classId))!)
        const cls = classCache.get(a.classId)!
        const past = [...(done.get(id)?.entries() ?? [])]
        const amt = (v: string) => rescale(toInt(v, STORE), STORE, scale, 'HALF_UP')
        const opening = past.filter(([m]) => m < from).reduce((x, [, d]) => x + amt(d.amount), 0n)
        const period = past
          .filter(([m]) => m >= from && m <= to)
          .reduce((x, [, d]) => x + amt(d.amount), 0n)
        const disposalMonth = a.disposalDate ? monthOf(a.disposalDate) : null
        const forecast = scheduleOf(a, scale)
          .filter(
            (r) => r.month >= from && r.month <= to && (!disposalMonth || r.month < disposalMonth)
          )
          .reduce((x, r) => x + r.amount, 0n)
        const cost = amt(a.cost)
        const closing = opening + period
        const disposed = a.status === 'DISPOSED' && a.disposalDate! <= year.end
        const v = {
          cost,
          opening,
          period,
          closing,
          bookValue: disposed ? 0n : cost - closing,
          forecast,
        }
        const t = totals.get(cls.id) ?? zero()
        for (const k of Object.keys(v) as (keyof typeof v)[]) {
          t[k] += v[k]
          grand[k] += v[k]
        }
        totals.set(cls.id, t)
        rows.push({
          assetId: a.id,
          number: a.number,
          name: a.name,
          classCode: cls.code,
          status: a.status,
          acquisitionDate: a.acquisitionDate,
          disposalDate: a.disposalDate,
          method: a.method,
          usefulLifeMonths: a.usefulLifeMonths,
          ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, money(x, scale)])),
        })
      }
      const fmt = (t: Record<string, bigint>) =>
        Object.fromEntries(Object.entries(t).map(([k, x]) => [k, money(x, scale)]))
      return {
        fiscalYearId,
        fiscalYear: year.code,
        legalEntityId: year.legal_entity_id,
        from,
        to,
        rows,
        classes: [...totals.entries()].map(([id, t]) => ({
          classId: id,
          code: classCache.get(id)!.code,
          name: classCache.get(id)!.name,
          ...fmt(t),
        })),
        totals: fmt(grand),
      }
    })
  }
}

async function assertEntity(scope: TenantScope, legalEntityId: string, month: string) {
  // Entidade de outra empresa (ou inexistente): 404, como qualquer registo fora do tenant.
  if (UUID.test(legalEntityId) && !(await legalEntityOk(scope, legalEntityId)))
    throw ApiError.notFound()
  const issues: ErrorDetail[] = []
  if (!UUID.test(legalEntityId))
    issues.push({ path: 'legalEntityId', code: 'INVALID', message: 'Entidade legal.' })
  if (!isMonth(month)) issues.push({ path: 'month', code: 'INVALID', message: 'Mês AAAA-MM.' })
  if (issues.length) throw ApiError.validation(issues)
}

function summarize(rows: PendingRow[], scale: number) {
  const byMonth = new Map<string, { assets: number; total: bigint }>()
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? { assets: 0, total: 0n }
    m.assets += 1
    m.total += r.amount
    byMonth.set(r.month, m)
  }
  return {
    rows: rows.map((r) => ({
      assetId: r.assetId,
      number: r.number,
      name: r.name,
      month: r.month,
      amount: money(r.amount, scale),
      costCenterId: r.costCenterId,
    })),
    months: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({ month, assets: m.assets, total: money(m.total, scale) })),
    total: money(
      rows.reduce((s, r) => s + r.amount, 0n),
      scale
    ),
  }
}
