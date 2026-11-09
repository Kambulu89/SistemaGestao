import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { workingDaysBetween } from '#modules/settings/index'
import { covers, findRow, placementOf, scopeClause } from '#modules/hr/application/employee_service'
import { normalizeFields } from '#modules/hr/domain/recruitment'
import {
  calendarDays,
  carryover,
  COUNTING,
  daysCents,
  daysText,
  entitlementFor,
  FIRST_YEAR_RULES,
  type FirstYearRule,
  LEAVE_CATEGORIES,
  requestIssues,
  ROUNDING,
  type Rounding,
} from '#modules/hr/domain/leave'

/*
 * Férias e ausências (7.4). Ver: o próprio, a chefia directa ou `hr.leave.read` no âmbito; pedir: o próprio com
 * `hr.leave.request` ou `hr.leave.manage` no âmbito; decidir: a chefia directa ou `hr.leave.approve` no âmbito, nunca o
 * próprio; ajustar e gerar direitos: `hr.leave.manage`. Tipos confidenciais (ex.: doença) só mostram tipo e motivo ao
 * próprio e a quem tem `hr.sensitive`.
 */

const today = () => new Date().toISOString().slice(0, 10)
const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const hasAny = (p: PermissionScope) =>
  p.tenant || p.own || p.legalEntityIds.size > 0 || p.branchIds.size > 0 || p.departmentIds.size > 0
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}
const CONFIDENTIAL_LABEL = 'Ausência justificada (confidencial)'

interface LeaveScopes {
  read: PermissionScope
  request: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
  sensitive: PermissionScope
}

async function leaveScopes(scope: TenantScope): Promise<LeaveScopes> {
  const [read, request, manage, approve, sensitive] = await Promise.all(
    [
      'hr.leave.read',
      'hr.leave.request',
      'hr.leave.manage',
      'hr.leave.approve',
      'hr.sensitive',
    ].map((p) => permissionScope(scope, p))
  )
  return { read, request, manage, approve, sensitive }
}

/** O que o actor pode fazer quanto às ausências deste colaborador. */
async function accessTo(scope: TenantScope, s: LeaveScopes, e: any) {
  const me = scope.context.membershipId
  const place = placementOf(e)
  const self = !!e.membership_id && e.membership_id === me
  let manager = false
  if (e.manager_id) {
    const r = await scope.trx.rawQuery(
      `select membership_id from employees where tenant_id = ? and id = ?`,
      [scope.context.tenantId, e.manager_id]
    )
    manager = (r.rows[0] as any)?.membership_id === me
  }
  const manage = covers(noOwn(s.manage), place, me)
  const approve = !self && (manager || covers(noOwn(s.approve), place, me))
  return {
    self,
    manager,
    manage,
    approve,
    see: self || manager || manage || approve || covers(s.read, place, me),
    request: (self && hasAny(s.request)) || manage,
    confidential: self || covers(s.sensitive, place, me),
  }
}

async function employeeWithAccess(scope: TenantScope, s: LeaveScopes, id: string, lock = false) {
  const e = isUuid(id) ? await findRow(scope, id, lock) : null
  if (!e) throw ApiError.notFound()
  const access = await accessTo(scope, s, e)
  if (!access.see) throw ApiError.notFound()
  return { e, access }
}

// ---------------------------------------------------------------------------------------------------------------
// Configuração: tipos e políticas
// ---------------------------------------------------------------------------------------------------------------

const TYPE_FIELDS = {
  code: { kind: 'code', label: 'Código' },
  name: { kind: 'text', min: 2, max: 120, label: 'Nome' },
  maxDaysPerRequest: { kind: 'money', label: 'Máximo de dias por pedido' },
} as const
const TYPE_COLUMNS: Record<string, string> = {
  code: 'code',
  name: 'name',
  category: 'category',
  paid: 'paid',
  deductsBalance: 'deducts_balance',
  counting: 'counting',
  requiresDocument: 'requires_document',
  confidential: 'confidential',
  maxDaysPerRequest: 'max_days_per_request',
  status: 'status',
}

function typeView(t: any) {
  return {
    id: t.id as string,
    version: Number(t.version),
    code: t.code as string,
    name: t.name as string,
    category: t.category as string,
    paid: Boolean(t.paid),
    deductsBalance: Boolean(t.deducts_balance),
    counting: t.counting as string,
    requiresDocument: Boolean(t.requires_document),
    confidential: Boolean(t.confidential),
    maxDaysPerRequest: (t.max_days_per_request as string) ?? null,
    status: t.status as string,
  }
}

function typeValues(input: Record<string, unknown>, creating: boolean) {
  const { values: v, issues } = normalizeFields(input, TYPE_FIELDS)
  const out: Record<string, unknown> = { ...v }
  const enumOf = (key: string, list: readonly string[], label: string) => {
    if (!(key in input)) {
      if (creating) issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      return
    }
    if (!list.includes(input[key] as string))
      issues.push({ path: key, code: 'INVALID', message: `${label} inválido(a).` })
    else out[key] = input[key]
  }
  enumOf('category', LEAVE_CATEGORIES, 'Categoria')
  enumOf('counting', COUNTING, 'Contagem')
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else out.status = input.status
  }
  for (const key of ['paid', 'deductsBalance', 'requiresDocument', 'confidential']) {
    if (!(key in input)) {
      if (creating && (key === 'paid' || key === 'deductsBalance'))
        issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      continue
    }
    if (typeof input[key] !== 'boolean')
      issues.push({ path: key, code: 'INVALID', message: 'Sim ou não.' })
    else out[key] = input[key]
  }
  if (creating)
    for (const k of ['code', 'name'])
      if (!out[k]) issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
  return { values: out, issues }
}

const POLICY_FIELDS = {
  code: { kind: 'code', label: 'Código' },
  name: { kind: 'text', min: 3, max: 160, label: 'Nome' },
  legalEntityId: { kind: 'uuid', label: 'Entidade legal' },
  calendarId: { kind: 'uuid', label: 'Calendário' },
  annualDays: { kind: 'money', label: 'Dias anuais' },
  firstYearDaysPerMonth: { kind: 'money', label: 'Dias por mês no primeiro ano' },
  carryoverMaxDays: { kind: 'money', label: 'Transporte máximo' },
  legalReference: { kind: 'longtext', min: 5, max: 2000, label: 'Fonte legal' },
  validFrom: { kind: 'date', label: 'Em vigor desde' },
} as const
const POLICY_COLUMNS: Record<string, string> = {
  code: 'code',
  name: 'name',
  legalEntityId: 'legal_entity_id',
  calendarId: 'calendar_id',
  annualDays: 'annual_days',
  firstYearRule: 'first_year_rule',
  firstYearDaysPerMonth: 'first_year_days_per_month',
  rounding: 'rounding',
  carryoverMaxDays: 'carryover_max_days',
  legalReference: 'legal_reference',
  validFrom: 'valid_from',
}
const POLICY_REQUIRED = [
  'code',
  'name',
  'calendarId',
  'annualDays',
  'firstYearRule',
  'legalReference',
  'validFrom',
]

const P_SELECT = `select p.*, p.valid_from::text as from_text, p.valid_to::text as to_text, c.code as calendar_code,
    le.code as le_code
  from leave_policies p
  join calendars c on c.tenant_id = p.tenant_id and c.id = p.calendar_id
  left join legal_entities le on le.tenant_id = p.tenant_id and le.id = p.legal_entity_id`

function policyView(p: any) {
  return {
    id: p.id as string,
    version: Number(p.version),
    code: p.code as string,
    policyVersion: Number(p.policy_version),
    name: p.name as string,
    legalEntityId: (p.legal_entity_id as string) ?? null,
    legalEntityCode: (p.le_code as string) ?? null,
    calendarId: p.calendar_id as string,
    calendarCode: p.calendar_code as string,
    annualDays: p.annual_days as string,
    firstYearRule: p.first_year_rule as FirstYearRule,
    firstYearDaysPerMonth: (p.first_year_days_per_month as string) ?? null,
    rounding: p.rounding as Rounding,
    carryoverMaxDays: p.carryover_max_days as string,
    legalReference: p.legal_reference as string,
    validFrom: p.from_text as string,
    validTo: (p.to_text as string) ?? null,
    status: p.status as string,
    publishedAt: p.published_at ?? null,
  }
}

function policyValues(input: Record<string, unknown>) {
  const { values: v, issues } = normalizeFields(input, POLICY_FIELDS)
  const out: Record<string, unknown> = { ...v }
  if ('firstYearRule' in input) {
    if (!FIRST_YEAR_RULES.includes(input.firstYearRule as never))
      issues.push({
        path: 'firstYearRule',
        code: 'INVALID',
        message: 'Regra do primeiro ano inválida.',
      })
    else out.firstYearRule = input.firstYearRule
  }
  if ('rounding' in input) {
    if (!ROUNDING.includes(input.rounding as never))
      issues.push({ path: 'rounding', code: 'INVALID', message: 'Arredondamento inválido.' })
    else out.rounding = input.rounding
  }
  for (const k of ['annualDays', 'firstYearDaysPerMonth', 'carryoverMaxDays'])
    if (typeof out[k] === 'string' && (daysCents(out[k]) ?? 0n) > 36600n)
      issues.push({ path: k, code: 'INVALID', message: 'No máximo 366 dias.' })
  return { values: out, issues }
}

function policyRuleIssues(p: Record<string, unknown>): ErrorDetail[] {
  if (p.firstYearRule === 'DAYS_PER_MONTH' && !p.firstYearDaysPerMonth)
    return [
      {
        path: 'firstYearDaysPerMonth',
        code: 'REQUIRED',
        message: 'Indique os dias por mês completo no primeiro ano.',
      },
    ]
  return []
}

async function findPolicy(scope: TenantScope, id: string, lock = false) {
  const r = await scope.trx.rawQuery(
    `${P_SELECT} where p.tenant_id = ? and p.id = ?${lock ? ' for update of p' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/** Política em vigor numa data para uma entidade legal (a específica antes da geral). */
async function policyFor(scope: TenantScope, legalEntityId: string, date: string) {
  const r = await scope.trx.rawQuery(
    `${P_SELECT} where p.tenant_id = ? and p.status in ('ACTIVE','RETIRED') and p.published_at is not null
       and (p.legal_entity_id = ? or p.legal_entity_id is null)
       and p.valid_from <= ?::date and (p.valid_to is null or p.valid_to >= ?::date)
     order by (p.legal_entity_id is null), p.valid_from desc limit 1`,
    [scope.context.tenantId, legalEntityId, date, date]
  )
  return (r.rows[0] as any) ?? null
}

async function checkPolicyRefs(scope: TenantScope, v: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const r = await scope.trx.rawQuery(
    `select status from calendars where tenant_id = ? and id = ?`,
    [scope.context.tenantId, v.calendarId as string]
  )
  if (!r.rows.length)
    issues.push({ path: 'calendarId', code: 'NOT_FOUND', message: 'Calendário inexistente.' })
  if (v.legalEntityId) {
    const l = await scope.trx.rawQuery(
      `select 1 from legal_entities where tenant_id = ? and id = ?`,
      [scope.context.tenantId, v.legalEntityId as string]
    )
    if (!l.rows.length)
      issues.push({
        path: 'legalEntityId',
        code: 'NOT_FOUND',
        message: 'Entidade legal inexistente.',
      })
  }
  fail(issues)
}

export class LeaveSettingsService {
  listTypes(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select * from leave_types where tenant_id = ? order by name`,
        [context.tenantId]
      )
      return (r.rows as any[]).map(typeView)
    })
  }

  createType(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { values: v, issues } = typeValues(input, true)
      fail(issues)
      const keys = Object.keys(v)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into leave_types (tenant_id, created_by, updated_by, ${keys.map((k) => TYPE_COLUMNS[k]).join(', ')})
           values (?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
          [context.tenantId, context.userId, context.userId, ...keys.map((k) => v[k])] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        typeCodeTaken(error)
      }
      await audit(scope, {
        action: 'hr.leave_type.created',
        entityType: 'leave_type',
        entityId: id,
        changes: Object.fromEntries(keys.map((k) => [k, { from: null, to: v[k] }])),
      })
      const r = await scope.trx.rawQuery(
        `select * from leave_types where tenant_id = ? and id = ?`,
        [context.tenantId, id]
      )
      return typeView(r.rows[0])
    })
  }

  updateType(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select * from leave_types where tenant_id = ? and id = ? for update`,
        [context.tenantId, id]
      )
      const t = r.rows[0] as any
      if (!t) throw ApiError.notFound()
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      const { values: v, issues } = typeValues(input, false)
      // As regras de contagem e de saldo não mudam depois de haver pedidos (mudariam o passado).
      const used = await scope.trx.rawQuery(
        `select 1 from leave_requests where tenant_id = ? and leave_type_id = ? limit 1`,
        [context.tenantId, id]
      )
      if (used.rows.length)
        for (const k of ['counting', 'deductsBalance', 'paid', 'category'])
          if (k in v && v[k] !== typeView(t)[k as 'paid'])
            issues.push({
              path: k,
              code: 'IN_USE',
              message: 'Já há pedidos deste tipo: crie outro tipo.',
            })
      fail(issues)
      const before = typeView(t) as Record<string, unknown>
      const changed = Object.keys(v).filter((k) => (before[k] ?? null) !== (v[k] ?? null))
      if (changed.length) {
        try {
          await scope.trx.rawQuery(
            `update leave_types set ${changed.map((k) => `${TYPE_COLUMNS[k]} = ?`).join(', ')}, version = version + 1,
               updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
            [...changed.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
          )
        } catch (error) {
          typeCodeTaken(error)
        }
        await audit(scope, {
          action: 'hr.leave_type.updated',
          entityType: 'leave_type',
          entityId: id,
          changes: Object.fromEntries(
            changed.map((k) => [k, { from: before[k] ?? null, to: v[k] }])
          ),
        })
      }
      const fresh = await scope.trx.rawQuery(
        `select * from leave_types where tenant_id = ? and id = ?`,
        [context.tenantId, id]
      )
      return typeView(fresh.rows[0])
    })
  }

  listPolicies(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `${P_SELECT} where p.tenant_id = ? order by p.code, p.policy_version desc`,
        [context.tenantId]
      )
      return (r.rows as any[]).map(policyView)
    })
  }

  getPolicy(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const p = await findPolicy(scope, id)
      if (!p) throw ApiError.notFound()
      return policyView(p)
    })
  }

  /** Nova política (versão 1) ou nova versão de uma existente (`fromId`): fica em rascunho. */
  createPolicy(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      let base: Record<string, unknown> = {}
      let policyVersion = 1
      if (typeof input.fromId === 'string') {
        const from = isUuid(input.fromId) ? await findPolicy(scope, input.fromId) : null
        if (!from) fail([{ path: 'fromId', code: 'NOT_FOUND', message: 'Política inexistente.' }])
        const fv = policyView(from)
        base = { ...fv, validFrom: undefined }
        const max = await scope.trx.rawQuery(
          `select max(policy_version)::int as n from leave_policies where tenant_id = ? and code = ?`,
          [context.tenantId, fv.code]
        )
        policyVersion = (max.rows[0] as { n: number }).n + 1
        delete input.code
      }
      const { values: v, issues } = policyValues(input)
      const all: Record<string, unknown> = {
        rounding: 'NONE',
        carryoverMaxDays: '0.00',
        ...base,
        ...v,
      }
      for (const k of POLICY_REQUIRED)
        if (all[k] === undefined || all[k] === null)
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...policyRuleIssues(all))
      fail(issues)
      await checkPolicyRefs(scope, all)
      const keys = Object.keys(POLICY_COLUMNS).filter((k) => all[k] !== undefined)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into leave_policies (tenant_id, created_by, updated_by, policy_version,
             ${keys.map((k) => POLICY_COLUMNS[k]).join(', ')})
           values (?, ?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
          [
            context.tenantId,
            context.userId,
            context.userId,
            policyVersion,
            ...keys.map((k) => all[k]),
          ] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        if (constraintOf(error) === 'leave_policies_version_unique')
          throw ApiError.conflict('CODE_TAKEN', 'Já existe uma política com este código.')
        throw error
      }
      await audit(scope, {
        action: 'hr.leave_policy.created',
        entityType: 'leave_policy',
        entityId: id,
        metadata: { code: all.code, policyVersion },
      })
      return policyView(await findPolicy(scope, id))
    })
  }

  updatePolicy(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const p = await findPolicy(scope, id, true)
      if (!p) throw ApiError.notFound()
      if (Number(p.version) !== expectedVersion) throw ApiError.versionConflict(Number(p.version))
      if (p.status !== 'DRAFT')
        wrongState('Uma política publicada não se altera: crie uma nova versão.')
      if ('code' in input && input.code !== p.code)
        fail([{ path: 'code', code: 'IMMUTABLE', message: 'O código não se altera.' }])
      const { values: v, issues } = policyValues(input)
      const before = policyView(p) as Record<string, unknown>
      const after = { ...before, ...v }
      for (const k of POLICY_REQUIRED)
        if (k in v && v[k] === null)
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...policyRuleIssues(after))
      fail(issues)
      await checkPolicyRefs(scope, after)
      const changed = Object.keys(v).filter(
        (k) => k !== 'code' && (before[k] ?? null) !== (v[k] ?? null)
      )
      if (changed.length) {
        await scope.trx.rawQuery(
          `update leave_policies set ${changed.map((k) => `${POLICY_COLUMNS[k]} = ?`).join(', ')},
             version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [...changed.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
        )
        await audit(scope, {
          action: 'hr.leave_policy.updated',
          entityType: 'leave_policy',
          entityId: id,
          changes: Object.fromEntries(
            changed.map((k) => [k, { from: before[k] ?? null, to: v[k] }])
          ),
        })
      }
      return policyView(await findPolicy(scope, id))
    })
  }

  /**
   * Publicar: a versão passa a vigorar desde `validFrom` e a versão anterior do mesmo código fecha na véspera. Não pode
   * começar antes da anterior nem sobrepor-se a outra política da mesma entidade legal.
   */
  publishPolicy(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const p = await findPolicy(scope, id, true)
      if (!p) throw ApiError.notFound()
      if (Number(p.version) !== expectedVersion) throw ApiError.versionConflict(Number(p.version))
      if (p.status !== 'DRAFT') wrongState('Só um rascunho se publica.')
      const prev = await scope.trx.rawQuery(
        `select id, valid_from::text as from_text from leave_policies where tenant_id = ? and code = ?
           and status = 'ACTIVE' and valid_to is null for update`,
        [context.tenantId, p.code]
      )
      const open = prev.rows[0] as any
      if (open && open.from_text >= p.from_text)
        fail([
          {
            path: 'validFrom',
            code: 'NOT_AFTER_PREVIOUS',
            message: `A nova versão tem de começar depois da actual (${open.from_text}).`,
          },
        ])
      const conflict = await scope.trx.rawQuery(
        `select code from leave_policies where tenant_id = ? and code <> ? and status = 'ACTIVE'
           and legal_entity_id is not distinct from ?
           and (valid_to is null or valid_to >= ?::date) limit 1`,
        [context.tenantId, p.code, p.legal_entity_id, p.from_text]
      )
      if (conflict.rows.length)
        throw ApiError.conflict(
          'POLICY_CONFLICT',
          `Já há uma política em vigor para este âmbito (${(conflict.rows[0] as any).code}).`
        )
      if (open) {
        const d = new Date(`${p.from_text}T00:00:00Z`)
        d.setUTCDate(d.getUTCDate() - 1)
        await scope.trx.rawQuery(
          `update leave_policies set valid_to = ?, status = 'RETIRED', version = version + 1, updated_by = ?,
             updated_at = now() where tenant_id = ? and id = ?`,
          [d.toISOString().slice(0, 10), context.userId, context.tenantId, open.id]
        )
      }
      await scope.trx.rawQuery(
        `update leave_policies set status = 'ACTIVE', published_at = now(), version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.leave_policy.published',
        entityType: 'leave_policy',
        entityId: id,
        metadata: {
          code: p.code,
          policyVersion: Number(p.policy_version),
          validFrom: p.from_text,
          replaces: open?.id ?? null,
        },
      })
      return policyView(await findPolicy(scope, id))
    })
  }
}

function typeCodeTaken(error: unknown): never {
  if (constraintOf(error) === 'leave_types_code_unique')
    throw new ApiError(409, 'CODE_TAKEN', 'Já existe um tipo com este código.', [
      { path: 'code', code: 'CODE_TAKEN', message: 'Já existe um tipo com este código.' },
    ])
  throw error
}

// ---------------------------------------------------------------------------------------------------------------
// Saldos, direitos e ajustes
// ---------------------------------------------------------------------------------------------------------------

async function balanceOf(scope: TenantScope, employeeId: string, year: number) {
  const r = await scope.trx.rawQuery(
    `select kind, coalesce(sum(days), 0)::text as days from leave_ledger
      where tenant_id = ? and employee_id = ? and year = ? group by kind`,
    [scope.context.tenantId, employeeId, year]
  )
  const by: Record<string, bigint> = {}
  for (const row of r.rows as any[]) by[row.kind] = daysCents(row.days) ?? 0n
  const pending = await scope.trx.rawQuery(
    `select coalesce(sum(r.days), 0)::text as days from leave_requests r
       join leave_types t on t.tenant_id = r.tenant_id and t.id = r.leave_type_id
      where r.tenant_id = ? and r.employee_id = ? and r.year = ? and r.status = 'PENDING' and t.deducts_balance`,
    [scope.context.tenantId, employeeId, year]
  )
  const get = (k: string) => by[k] ?? 0n
  const entitled = get('ACCRUAL') + get('CARRYOVER') + get('ADJUSTMENT') + get('EXPIRY')
  const taken = -(get('TAKEN') + get('REVERSAL'))
  const balance = Object.values(by).reduce((a, b) => a + b, 0n)
  const pend = daysCents((pending.rows[0] as any).days) ?? 0n
  return {
    year,
    accrued: daysText(get('ACCRUAL')),
    carriedOver: daysText(get('CARRYOVER')),
    expired: daysText(-get('EXPIRY')),
    adjustments: daysText(get('ADJUSTMENT')),
    entitled: daysText(entitled),
    taken: daysText(taken),
    pending: daysText(pend),
    balance: daysText(balance),
    available: daysText(balance - pend),
    raw: { balance, pending: pend },
  }
}

async function ledgerInsert(
  scope: TenantScope,
  row: {
    employeeId: string
    year: number
    kind: string
    days: bigint
    effectiveDate: string
    requestId?: string | null
    policyId?: string | null
    reason?: string | null
  }
) {
  await scope.trx.rawQuery(
    `insert into leave_ledger (tenant_id, employee_id, year, kind, days, effective_date, leave_request_id, policy_id,
       reason, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      row.employeeId,
      row.year,
      row.kind,
      daysText(row.days),
      row.effectiveDate,
      row.requestId ?? null,
      row.policyId ?? null,
      row.reason ?? null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

/** Direito do ano e transporte do ano anterior para um colaborador (idempotente; recálculo vira ajuste). */
async function accrue(scope: TenantScope, e: any, year: number) {
  const policy =
    (await policyFor(scope, e.legal_entity_id, `${year}-01-01`)) ??
    (await policyFor(scope, e.legal_entity_id, `${year}-12-31`))
  if (!policy) return { status: 'NO_POLICY' as const }
  const due = entitlementFor(
    {
      annualDays: policy.annual_days,
      firstYearRule: policy.first_year_rule,
      firstYearDaysPerMonth: policy.first_year_days_per_month,
      rounding: policy.rounding,
    },
    e.hire_date_text,
    year
  )
  const effective = e.hire_date_text > `${year}-01-01` ? e.hire_date_text : `${year}-01-01`
  const existing = await scope.trx.rawQuery(
    `select coalesce(sum(days), 0)::text as days, count(*) filter (where kind = 'ACCRUAL')::int as n
       from leave_ledger where tenant_id = ? and employee_id = ? and year = ?
        and (kind = 'ACCRUAL' or (kind = 'ADJUSTMENT' and policy_id is not null))`,
    [scope.context.tenantId, e.id, year]
  )
  const ex = existing.rows[0] as { days: string; n: number }
  let result: 'CREATED' | 'ADJUSTED' | 'UNCHANGED' = 'UNCHANGED'
  if (ex.n === 0) {
    await ledgerInsert(scope, {
      employeeId: e.id,
      year,
      kind: 'ACCRUAL',
      days: due,
      effectiveDate: effective,
      policyId: policy.id,
      reason: `Direito de ${year} (${policy.code} v${policy.policy_version})`,
    })
    result = 'CREATED'
  } else {
    const diff = due - (daysCents(ex.days) ?? 0n)
    if (diff !== 0n) {
      await ledgerInsert(scope, {
        employeeId: e.id,
        year,
        kind: 'ADJUSTMENT',
        days: diff,
        effectiveDate: today() < effective ? effective : today(),
        policyId: policy.id,
        reason: `Recálculo do direito de ${year} (${policy.code} v${policy.policy_version})`,
      })
      result = 'ADJUSTED'
    }
  }
  // Transporte do ano anterior (uma vez): saldo positivo até ao máximo; o resto expira no ano anterior.
  const carried = await scope.trx.rawQuery(
    `select 1 from leave_ledger where tenant_id = ? and employee_id = ? and year = ? and kind = 'CARRYOVER'`,
    [scope.context.tenantId, e.id, year]
  )
  const hasPrevious = await scope.trx.rawQuery(
    `select 1 from leave_ledger where tenant_id = ? and employee_id = ? and year = ? limit 1`,
    [scope.context.tenantId, e.id, year - 1]
  )
  if (!carried.rows.length && hasPrevious.rows.length) {
    const prev = await balanceOf(scope, e.id, year - 1)
    const { carry, expire } = carryover(
      prev.raw.balance - prev.raw.pending,
      policy.carryover_max_days
    )
    if (carry > 0n)
      await ledgerInsert(scope, {
        employeeId: e.id,
        year,
        kind: 'CARRYOVER',
        days: carry,
        effectiveDate: `${year}-01-01`,
        policyId: policy.id,
        reason: `Transporte de ${year - 1}`,
      })
    if (expire > 0n)
      await ledgerInsert(scope, {
        employeeId: e.id,
        year: year - 1,
        kind: 'EXPIRY',
        days: -expire,
        effectiveDate: `${year}-01-01`,
        policyId: policy.id,
        reason: `Saldo de ${year - 1} acima do transporte máximo`,
      })
  }
  return { status: result, days: daysText(due) }
}

/** Saldo de férias de um ano (para a cessação, 7.11). */
export async function leaveBalanceOf(scope: TenantScope, employeeId: string, year: number) {
  const b = await balanceOf(scope, employeeId, year)
  return { ...b, raw: undefined, balanceCents: b.raw.balance, pendingCents: b.raw.pending }
}

/**
 * Encerra o saldo de férias de um ano na cessação (7.11): um ajuste que leva o saldo a zero, com a referência do
 * processo (os dias pagos vão na liquidação). Devolve os dias ajustados (cêntimos de dia).
 */
export async function closeLeaveBalance(
  scope: TenantScope,
  employeeId: string,
  year: number,
  effectiveDate: string,
  reason: string
) {
  const b = await balanceOf(scope, employeeId, year)
  if (b.raw.balance === 0n) return 0n
  await ledgerInsert(scope, {
    employeeId,
    year,
    kind: 'ADJUSTMENT',
    days: -b.raw.balance,
    effectiveDate,
    reason,
  })
  return -b.raw.balance
}

export class LeaveBalanceService {
  /** Self-service: a ficha ligada à conta do actor, com o saldo do ano (404 se a conta não tem ficha). */
  mine(context: TenantContext, year: number) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select id from employees where tenant_id = ? and membership_id = ?`,
        [context.tenantId, context.membershipId]
      )
      const row = r.rows[0] as { id: string } | undefined
      if (!row)
        throw new ApiError(
          404,
          'NOT_LINKED',
          'A sua conta não está ligada a uma ficha de colaborador.'
        )
      return this.summaryIn(scope, row.id, year)
    })
  }

  /** Saldo do ano, conta-corrente e pedidos de um colaborador. */
  summary(context: TenantContext, employeeId: string, year: number) {
    return runInTenant(context, (scope) => this.summaryIn(scope, employeeId, year))
  }

  private async summaryIn(scope: TenantScope, employeeId: string, year: number) {
    const context = scope.context
    const s = await leaveScopes(scope)
    const { e, access } = await employeeWithAccess(scope, s, employeeId)
    const b = await balanceOf(scope, e.id, year)
    const ledger = await scope.trx.rawQuery(
      `select l.*, l.effective_date::text as eff, l.days::text as days_text, u.full_name as actor
         from leave_ledger l left join users u on u.id = l.created_by
        where l.tenant_id = ? and l.employee_id = ? and l.year = ? order by l.effective_date, l.created_at`,
      [context.tenantId, e.id, year]
    )
    const policy =
      (await policyFor(scope, e.legal_entity_id, `${year}-12-31`)) ??
      (await policyFor(scope, e.legal_entity_id, today()))
    const { raw, ...balance } = b
    void raw
    return {
      employee: { id: e.id, code: e.code, fullName: e.full_name },
      balance,
      policy: policy ? policyView(policy) : null,
      ledger: (ledger.rows as any[]).map((l) => ({
        id: l.id,
        kind: l.kind,
        days: l.days_text,
        effectiveDate: l.eff,
        reason: l.reason ?? null,
        leaveRequestId: l.leave_request_id ?? null,
        actor: l.actor ?? null,
      })),
      access: { manage: access.manage, request: access.request },
    }
  }

  /** Ajuste manual (ex.: correcção acordada), só de acréscimo, com motivo. */
  adjust(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const { e, access } = await employeeWithAccess(scope, s, employeeId, true)
      if (!access.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere as ausências deste colaborador.')
      const issues: ErrorDetail[] = []
      const days = daysCents(input.days)
      if (days === null || days === 0n || days > 36600n || days < -36600n)
        issues.push({
          path: 'days',
          code: 'INVALID',
          message: 'Dias diferentes de zero (até 2 casas).',
        })
      const year = Number(input.year)
      if (!Number.isInteger(year) || year < 2000 || year > 2100)
        issues.push({ path: 'year', code: 'INVALID', message: 'Ano inválido.' })
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (reason.length < 3)
        issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' })
      fail(issues)
      await ledgerInsert(scope, {
        employeeId: e.id,
        year,
        kind: 'ADJUSTMENT',
        days: days!,
        effectiveDate: today(),
        reason,
      })
      await audit(scope, {
        action: 'hr.leave.adjusted',
        entityType: 'employee',
        entityId: e.id,
        metadata: { year, days: daysText(days!), reason },
      })
      const { raw, ...b } = await balanceOf(scope, e.id, year)
      void raw
      return b
    })
  }

  /** Gerar (ou recalcular) o direito do ano para os colaboradores no âmbito de quem gere. */
  accrue(context: TenantContext, input: { year: number; employeeIds?: string[] }) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const visible = scopeClause(noOwn(s.manage), context.membershipId)
      if (!visible) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere ausências.')
      const where = [
        `e.tenant_id = ?`,
        visible.sql,
        `e.status <> 'TERMINATED'`,
        `e.hire_date <= ?::date`,
      ]
      const params: unknown[] = [context.tenantId, ...visible.params, `${input.year}-12-31`]
      if (input.employeeIds?.length) {
        where.push(`e.id = any(?::uuid[])`)
        params.push(input.employeeIds)
      }
      const r = await scope.trx.rawQuery(
        `select e.*, e.hire_date::text as hire_date_text from employees e where ${where.join(' and ')}
          order by e.code for update of e`,
        params as never[]
      )
      const out = {
        created: 0,
        adjusted: 0,
        unchanged: 0,
        skipped: [] as { code: string; reason: string }[],
      }
      for (const e of r.rows as any[]) {
        const res = await accrue(scope, e, input.year)
        if (res.status === 'NO_POLICY')
          out.skipped.push({ code: e.code, reason: 'Sem política de férias em vigor.' })
        else if (res.status === 'CREATED') out.created++
        else if (res.status === 'ADJUSTED') out.adjusted++
        else out.unchanged++
      }
      await audit(scope, {
        action: 'hr.leave.accrued',
        entityType: 'leave_accrual',
        entityId: context.tenantId,
        metadata: { year: input.year, ...out, skipped: out.skipped.length },
      })
      return out
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------------------------------------------

const R_SELECT = `select r.*, r.start_date::text as start_text, r.end_date::text as end_text, r.days::text as days_text,
    t.code as type_code, t.name as type_name, t.confidential, t.deducts_balance, t.paid, t.counting, t.requires_document,
    e.code as employee_code, e.full_name as employee_name, e.membership_id as employee_membership_id,
    e.legal_entity_id, e.branch_id, e.department_id, e.manager_id,
    mgr.membership_id as manager_membership_id, du.full_name as decided_by_name
  from leave_requests r
  join leave_types t on t.tenant_id = r.tenant_id and t.id = r.leave_type_id
  join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
  left join employees mgr on mgr.tenant_id = e.tenant_id and mgr.id = e.manager_id
  left join tenant_memberships dm on dm.tenant_id = r.tenant_id and dm.id = r.decided_by_membership_id
  left join users du on du.id = dm.user_id`

function requestView(r: any, confidentialVisible: boolean) {
  const masked = r.confidential && !confidentialVisible
  return {
    id: r.id as string,
    version: Number(r.version),
    employee: {
      id: r.employee_id as string,
      code: r.employee_code as string,
      fullName: r.employee_name as string,
    },
    leaveType: masked
      ? { id: null, code: null, name: CONFIDENTIAL_LABEL, confidential: true }
      : {
          id: r.leave_type_id as string,
          code: r.type_code as string,
          name: r.type_name as string,
          confidential: Boolean(r.confidential),
        },
    paid: Boolean(r.paid),
    deductsBalance: Boolean(r.deducts_balance),
    startDate: r.start_text as string,
    endDate: r.end_text as string,
    days: r.days_text as string,
    year: Number(r.year),
    status: r.status as string,
    reason: masked ? null : ((r.reason as string) ?? null),
    decidedBy: (r.decided_by_name as string) ?? null,
    decidedAt: r.decided_at ?? null,
    decisionComment: (r.decision_comment as string) ?? null,
    cancelReason: (r.cancel_reason as string) ?? null,
    createdAt: r.created_at,
  }
}

async function findRequest(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${R_SELECT} where r.tenant_id = ? and r.id = ?${lock ? ' for update of r' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/** Dias do pedido segundo o tipo (úteis pelo calendário da política, ou de calendário). */
async function countDays(scope: TenantScope, t: any, e: any, start: string, end: string) {
  if (t.counting === 'CALENDAR_DAYS') return BigInt(calendarDays(start, end)) * 100n
  const policy = await policyFor(scope, e.legal_entity_id, start)
  if (!policy)
    throw ApiError.conflict(
      'NO_POLICY',
      'Não há política de férias em vigor para esta entidade (define o calendário de dias úteis).'
    )
  const n = await workingDaysBetween(scope, policy.calendar_id, start, end)
  return BigInt(n ?? 0) * 100n
}

export interface RequestFilter {
  status?: string
  employeeId?: string
  from?: string
  to?: string
  mine?: boolean
  toApprove?: boolean
  limit: number
  offset: number
}

/** Ausências aprovadas num intervalo (para assiduidade e processamento salarial). */
export async function approvedAbsences(
  scope: TenantScope,
  employeeId: string,
  from: string,
  to: string
) {
  const r = await scope.trx.rawQuery(
    `${R_SELECT} where r.tenant_id = ? and r.employee_id = ? and r.status = 'APPROVED'
       and r.start_date <= ?::date and r.end_date >= ?::date order by r.start_date`,
    [scope.context.tenantId, employeeId, to, from]
  )
  return (r.rows as any[]).map((x) => ({
    requestId: x.id as string,
    leaveTypeCode: x.type_code as string,
    paid: Boolean(x.paid),
    startDate: x.start_text as string,
    endDate: x.end_text as string,
    days: x.days_text as string,
  }))
}

export class LeaveRequestService {
  list(context: TenantContext, f: RequestFilter) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const me = context.membershipId
      const parts: string[] = [`e.membership_id = ?`, `mgr.membership_id = ?`]
      const params: unknown[] = [me, me]
      for (const p of [s.read, noOwn(s.manage), noOwn(s.approve)]) {
        const c = scopeClause(p, me)
        if (c) {
          parts.push(c.sql)
          params.push(...c.params)
        }
      }
      const where = [`r.tenant_id = ?`, `(${parts.join(' or ')})`]
      const all: unknown[] = [context.tenantId, ...params]
      if (f.status) {
        where.push('r.status = ?')
        all.push(f.status)
      }
      if (f.employeeId) {
        where.push('r.employee_id = ?')
        all.push(f.employeeId)
      }
      if (f.from) {
        where.push('r.end_date >= ?::date')
        all.push(f.from)
      }
      if (f.to) {
        where.push('r.start_date <= ?::date')
        all.push(f.to)
      }
      if (f.mine) {
        where.push('e.membership_id = ?')
        all.push(me)
      }
      if (f.toApprove) {
        const approve = scopeClause(noOwn(s.approve), me)
        where.push(`r.status = 'PENDING'`, `e.membership_id is distinct from ?`)
        all.push(me)
        where.push(approve ? `(mgr.membership_id = ? or ${approve.sql})` : `mgr.membership_id = ?`)
        all.push(me, ...(approve?.params ?? []))
      }
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${R_SELECT} where ${clause} order by r.start_date desc, r.created_at desc limit ? offset ?`,
        [...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from leave_requests r
           join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
           left join employees mgr on mgr.tenant_id = e.tenant_id and mgr.id = e.manager_id where ${clause}`,
        all as never[]
      )
      const items = []
      for (const r of rows.rows as any[]) {
        const visible = r.employee_membership_id === me || covers(s.sensitive, placementOf(r), me)
        items.push(requestView(r, visible))
      }
      return { items, total: (count.rows[0] as { n: number }).n }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const r = await findRequest(scope, id)
      if (!r) throw ApiError.notFound()
      const { access } = await employeeWithAccess(scope, s, r.employee_id)
      return {
        ...requestView(r, access.confidential),
        access: {
          approve: access.approve && r.status === 'PENDING' && r.created_by !== context.userId,
          cancel:
            (r.status === 'PENDING' && (access.self || access.manage)) ||
            (r.status === 'APPROVED' && access.manage),
          documents: !r.confidential || access.confidential,
        },
      }
    })
  }

  /** Simulação para o formulário: dias contados e saldo disponível, sem gravar nada. */
  preview(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const { e, t, start, end } = await this.validated(scope, s, input)
      const days = await countDays(scope, t, e, start, end)
      const { raw, ...balance } = await balanceOf(scope, e.id, Number(start.slice(0, 4)))
      void raw
      return { days: daysText(days), deductsBalance: Boolean(t.deducts_balance), balance }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const { e, t, start, end, access } = await this.validated(scope, s, input, true)
      if (!access.request)
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Não pode registar ausências para este colaborador.'
        )
      const days = await countDays(scope, t, e, start, end)
      if (days === 0n)
        fail([
          {
            path: 'endDate',
            code: 'ZERO_DAYS',
            message: 'O período não tem dias a contar (descanso ou feriados).',
          },
        ])
      if (t.max_days_per_request && days > (daysCents(t.max_days_per_request) ?? 0n))
        fail([
          {
            path: 'endDate',
            code: 'TOO_MANY_DAYS',
            message: `No máximo ${t.max_days_per_request} dias por pedido.`,
          },
        ])
      // Sem sobreposição com pedidos pendentes ou aprovados (o colaborador está bloqueado).
      const overlap = await scope.trx.rawQuery(
        `select 1 from leave_requests where tenant_id = ? and employee_id = ? and status in ('PENDING','APPROVED')
           and start_date <= ?::date and end_date >= ?::date limit 1`,
        [context.tenantId, e.id, end, start]
      )
      if (overlap.rows.length)
        throw ApiError.conflict('OVERLAP', 'Já há uma ausência pedida ou aprovada neste período.')
      const year = Number(start.slice(0, 4))
      if (t.deducts_balance) {
        const b = await balanceOf(scope, e.id, year)
        if (days > b.raw.balance - b.raw.pending)
          fail([
            {
              path: 'endDate',
              code: 'INSUFFICIENT_BALANCE',
              message: `Saldo disponível de ${daysText(b.raw.balance - b.raw.pending)} dias para ${daysText(days)} pedidos.`,
            },
          ])
      }
      const reason =
        typeof input.reason === 'string' ? input.reason.trim().slice(0, 2000) || null : null
      const r = await scope.trx.rawQuery(
        `insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, year, reason,
           created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          e.id,
          t.id,
          start,
          end,
          daysText(days),
          year,
          reason,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      // Ausências confidenciais: a auditoria não leva o tipo nem o motivo.
      await audit(scope, {
        action: 'hr.leave.requested',
        entityType: 'leave_request',
        entityId: id,
        metadata: {
          employeeId: e.id,
          startDate: start,
          endDate: end,
          days: daysText(days),
          leaveType: t.confidential ? '[RESERVADO]' : t.code,
        },
      })
      return requestView(await findRequest(scope, id), access.confidential)
    })
  }

  decide(
    context: TenantContext,
    id: string,
    approve: boolean,
    comment: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const r = await findRequest(scope, id, true)
      if (!r) throw ApiError.notFound()
      const { e, access } = await employeeWithAccess(scope, s, r.employee_id, true)
      if (!access.approve)
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Só a chefia directa ou quem aprova ausências neste âmbito decide.'
        )
      if (r.created_by === context.userId)
        throw ApiError.forbidden('SEGREGATION', 'Quem registou o pedido não o decide.')
      if (Number(r.version) !== expectedVersion) throw ApiError.versionConflict(Number(r.version))
      if (r.status !== 'PENDING') wrongState('O pedido já foi decidido ou cancelado.')
      if (!approve && !comment)
        fail([{ path: 'comment', code: 'REQUIRED', message: 'Indique o motivo da recusa.' }])
      if (approve && r.deducts_balance) {
        // O saldo pode ter mudado desde o pedido: volta a verificar-se, sem contar este pedido como pendente.
        const b = await balanceOf(scope, e.id, Number(r.year))
        const own = daysCents(r.days_text) ?? 0n
        if (own > b.raw.balance - (b.raw.pending - own))
          throw ApiError.conflict('INSUFFICIENT_BALANCE', 'O saldo já não chega para este pedido.')
      }
      await scope.trx.rawQuery(
        `update leave_requests set status = ?, decided_by_membership_id = ?, decided_at = now(), decision_comment = ?,
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [
          approve ? 'APPROVED' : 'REJECTED',
          context.membershipId,
          comment,
          context.userId,
          context.tenantId,
          id,
        ] as never[]
      )
      if (approve && r.deducts_balance)
        await ledgerInsert(scope, {
          employeeId: e.id,
          year: Number(r.year),
          kind: 'TAKEN',
          days: -(daysCents(r.days_text) ?? 0n),
          effectiveDate: r.start_text,
          requestId: id,
          reason: 'Gozo aprovado',
        })
      await audit(scope, {
        action: approve ? 'hr.leave.approved' : 'hr.leave.rejected',
        entityType: 'leave_request',
        entityId: id,
        changes: { status: { from: 'PENDING', to: approve ? 'APPROVED' : 'REJECTED' } },
        metadata: comment ? { comment } : null,
      })
      return requestView(await findRequest(scope, id), access.confidential)
    })
  }

  /** Cancelar: pendente pelo próprio ou por quem gere; aprovado só por quem gere (devolve os dias ao saldo). */
  cancel(context: TenantContext, id: string, reason: string | null, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const s = await leaveScopes(scope)
      const r = await findRequest(scope, id, true)
      if (!r) throw ApiError.notFound()
      const { e, access } = await employeeWithAccess(scope, s, r.employee_id, true)
      if (Number(r.version) !== expectedVersion) throw ApiError.versionConflict(Number(r.version))
      if (r.status === 'PENDING') {
        if (!access.self && !access.manage && r.created_by !== context.userId)
          throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode cancelar este pedido.')
      } else if (r.status === 'APPROVED') {
        if (!access.manage)
          throw ApiError.forbidden(
            'OUT_OF_SCOPE',
            'Uma ausência aprovada só é cancelada por quem gere ausências.'
          )
        if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      } else wrongState('O pedido já está encerrado.')
      await scope.trx.rawQuery(
        `update leave_requests set status = 'CANCELLED', cancel_reason = ?, version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [reason, context.userId, context.tenantId, id] as never[]
      )
      if (r.status === 'APPROVED' && r.deducts_balance)
        await ledgerInsert(scope, {
          employeeId: e.id,
          year: Number(r.year),
          kind: 'REVERSAL',
          days: daysCents(r.days_text) ?? 0n,
          effectiveDate: today(),
          requestId: id,
          reason: reason ?? 'Cancelamento',
        })
      await audit(scope, {
        action: 'hr.leave.cancelled',
        entityType: 'leave_request',
        entityId: id,
        changes: { status: { from: r.status, to: 'CANCELLED' } },
        metadata: reason ? { reason } : null,
      })
      return requestView(await findRequest(scope, id), access.confidential)
    })
  }

  private async validated(
    scope: TenantScope,
    s: LeaveScopes,
    input: Record<string, unknown>,
    lock = false
  ) {
    const issues: ErrorDetail[] = []
    if (typeof input.employeeId !== 'string' || !isUuid(input.employeeId))
      issues.push({ path: 'employeeId', code: 'REQUIRED', message: 'Indique o colaborador.' })
    if (typeof input.leaveTypeId !== 'string' || !isUuid(input.leaveTypeId))
      issues.push({ path: 'leaveTypeId', code: 'REQUIRED', message: 'Indique o tipo de ausência.' })
    issues.push(...requestIssues(input.startDate, input.endDate))
    fail(issues)
    const { e, access } = await employeeWithAccess(scope, s, input.employeeId as string, lock)
    if (e.status !== 'ACTIVE')
      throw ApiError.conflict('INVALID_STATE', 'O colaborador não está activo.')
    const t = (
      await scope.trx.rawQuery(`select * from leave_types where tenant_id = ? and id = ?`, [
        scope.context.tenantId,
        input.leaveTypeId as string,
      ])
    ).rows[0] as any
    if (!t || t.status !== 'ACTIVE')
      fail([
        {
          path: 'leaveTypeId',
          code: 'NOT_FOUND',
          message: 'Tipo de ausência inexistente ou inactivo.',
        },
      ])
    const start = input.startDate as string
    const end = input.endDate as string
    if (start < e.hire_date_text)
      fail([{ path: 'startDate', code: 'BEFORE_HIRE', message: 'Anterior à admissão.' }])
    return { e, t, start, end, access }
  }
}

/** Acesso aos documentos de uma ausência (anexos): confidenciais só para o próprio e `hr.sensitive`. */
export async function leaveRequestAccess(scope: TenantScope, id: string) {
  const r = await findRequest(scope, id)
  if (!r) return null
  const s = await leaveScopes(scope)
  const e = await findRow(scope, r.employee_id)
  const access = await accessTo(scope, s, e)
  if (!access.see) return null
  if (r.confidential && !access.confidential) return null
  return { read: true, write: access.self || access.manage }
}
