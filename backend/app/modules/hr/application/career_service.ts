import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import {
  covers,
  EmployeeService,
  findRow,
  placementOf,
} from '#modules/hr/application/employee_service'
import { normalizeFields } from '#modules/hr/domain/recruitment'
import {
  type Amendment,
  ASSIGNMENT_KINDS,
  CONTRACT_ACTIONS,
  CONTRACT_FIELDS,
  CONTRACT_REQUIRED,
  type ContractStatus,
  contractIssues,
  hoursIssues,
  PLACEMENT_KEYS,
  previousDay,
  termExceeded,
  type Terms,
  termsAt,
} from '#modules/hr/domain/contracts'

/*
 * Contratos e carreira (7.3). Os contratos são confidenciais: ver exige `hr.contracts.read` e gerir
 * `hr.contracts.manage`, no âmbito do colaborador (como em 7.1; o próprio pode ver os seus com âmbito OWN). O histórico
 * de colocação segue `hr.read` / `hr.manage`. A remuneração nunca vai para a auditoria (só que mudou).
 */

const today = () => new Date().toISOString().slice(0, 10)
const RESERVED = '[RESERVADO]'
const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}

/** Colaborador visível com a permissão de leitura dada, ou 404; devolve a linha e os âmbitos. */
async function employeeFor(
  scope: TenantScope,
  employeeId: string,
  read: string,
  manage: string,
  lock = false
) {
  const e = await findRow(scope, employeeId, lock)
  if (!e) throw ApiError.notFound()
  const [r, m] = await Promise.all([permissionScope(scope, read), permissionScope(scope, manage)])
  const me = scope.context.membershipId
  const place = placementOf(e)
  if (!covers(r, place, me) && !covers(noOwn(m), place, me)) throw ApiError.notFound()
  return { e, canManage: covers(noOwn(m), place, me) }
}

// ---------------------------------------------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------------------------------------------

const C_SELECT = `select c.*, c.start_date::text as start_text, c.end_date::text as end_text,
    c.probation_end_date::text as probation_text, c.suspended_from::text as suspended_text,
    c.termination_date::text as termination_text
  from employment_contracts c`

const C_COLUMNS: Record<string, string> = {
  code: 'code',
  contractType: 'contract_type',
  startDate: 'start_date',
  endDate: 'end_date',
  probationEndDate: 'probation_end_date',
  weeklyHours: 'weekly_hours',
  workSchedule: 'work_schedule',
  currency: 'currency',
  baseSalary: 'base_salary',
  notes: 'notes',
}

function contractValues(c: any): Record<string, unknown> {
  return {
    code: c.code,
    contractType: c.contract_type,
    startDate: c.start_text,
    endDate: c.end_text ?? null,
    probationEndDate: c.probation_text ?? null,
    weeklyHours: c.weekly_hours,
    workSchedule: c.work_schedule ?? null,
    currency: c.currency,
    baseSalary: c.base_salary,
    notes: c.notes ?? null,
  }
}

const baseTerms = (c: any): Terms => ({
  baseSalary: c.base_salary,
  weeklyHours: c.weekly_hours,
  workSchedule: c.work_schedule ?? null,
  endDate: c.end_text ?? null,
})

async function amendmentsOf(scope: TenantScope, contractId: string) {
  const r = await scope.trx.rawQuery(
    `select a.*, a.effective_date::text as effective_text, a.end_date::text as end_text
       from employment_contract_amendments a where a.tenant_id = ? and a.contract_id = ? order by a.sequence`,
    [scope.context.tenantId, contractId]
  )
  return (r.rows as any[]).map((a) => ({
    id: a.id as string,
    sequence: Number(a.sequence),
    kind: a.kind as 'CHANGE' | 'RENEWAL',
    effectiveDate: a.effective_text as string,
    baseSalary: (a.base_salary as string) ?? null,
    weeklyHours: (a.weekly_hours as string) ?? null,
    workSchedule: (a.work_schedule as string) ?? null,
    endDate: (a.end_text as string) ?? null,
    reason: a.reason as string,
    createdAt: a.created_at,
  }))
}

function contractView(c: any, amendments: Amendment[]) {
  const current = termsAt(baseTerms(c), amendments, today())
  return {
    id: c.id as string,
    version: Number(c.version),
    employeeId: c.employee_id as string,
    ...contractValues(c),
    status: c.status as ContractStatus,
    renewalCount: Number(c.renewal_count),
    suspendedFrom: (c.suspended_text as string) ?? null,
    terminationDate: (c.termination_text as string) ?? null,
    terminationReason: (c.termination_reason as string) ?? null,
    currentTerms: current,
    termExceeded: termExceeded(c.status, current.endDate, today()),
    createdAt: c.created_at,
  }
}

async function findContract(scope: TenantScope, id: string, lock = false) {
  const r = await scope.trx.rawQuery(
    `${C_SELECT} where c.tenant_id = ? and c.id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/** Contrato visível (pelo colaborador) com bloqueio opcional, ou 404. */
async function visibleContract(scope: TenantScope, id: string, lock = false) {
  const c = await findContract(scope, id, lock)
  if (!c) throw ApiError.notFound()
  const { e, canManage } = await employeeFor(
    scope,
    c.employee_id,
    'hr.contracts.read',
    'hr.contracts.manage'
  )
  return { c, e, canManage }
}

const assertCanManage = (canManage: boolean) => {
  if (!canManage) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere contratos deste colaborador.')
}

async function contractEvent(
  scope: TenantScope,
  contractId: string,
  kind: string,
  date: string,
  reason: string | null
) {
  await scope.trx.rawQuery(
    `insert into employment_contract_events (tenant_id, contract_id, kind, event_date, reason, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      contractId,
      kind,
      date,
      reason,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

/** Alterações para a auditoria: a remuneração só como "reservado". */
function auditChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of Object.keys(after)) {
    if ((before[k] ?? null) === (after[k] ?? null)) continue
    out[k] =
      k === 'baseSalary'
        ? {
            from: before[k] === null || before[k] === undefined ? null : RESERVED,
            to: after[k] === null || after[k] === undefined ? null : RESERVED,
          }
        : { from: before[k] ?? null, to: after[k] ?? null }
  }
  return out
}

const isoDate = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))

/**
 * Condições do contrato em vigor numa data para um colaborador (para o processamento salarial): o contrato activo,
 * suspenso ou terminado que cobre a data, com as adendas aplicadas. `null` se nenhum contrato cobre a data.
 */
export async function contractTermsAt(scope: TenantScope, employeeId: string, date: string) {
  const r = await scope.trx.rawQuery(
    `${C_SELECT} where c.tenant_id = ? and c.employee_id = ? and c.status in ('ACTIVE','SUSPENDED','ENDED')
       and c.start_date <= ?::date and (c.termination_date is null or c.termination_date >= ?::date)
     order by c.start_date desc limit 1`,
    [scope.context.tenantId, employeeId, date, date]
  )
  const c = r.rows[0] as any
  if (!c) return null
  const terms = termsAt(baseTerms(c), await amendmentsOf(scope, c.id), date)
  return { contractId: c.id as string, currency: c.currency as string, status: c.status, ...terms }
}

export class ContractService {
  list(context: TenantContext, employeeId: string) {
    return runInTenant(context, async (scope) => {
      const { canManage } = await employeeFor(
        scope,
        employeeId,
        'hr.contracts.read',
        'hr.contracts.manage'
      )
      const r = await scope.trx.rawQuery(
        `${C_SELECT} where c.tenant_id = ? and c.employee_id = ? order by c.start_date desc, c.created_at desc`,
        [context.tenantId, employeeId]
      )
      const items = []
      for (const c of r.rows as any[]) items.push(contractView(c, await amendmentsOf(scope, c.id)))
      return { items, canManage }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const { c, e, canManage } = await visibleContract(scope, id)
      const amendments = await amendmentsOf(scope, id)
      const events = await scope.trx.rawQuery(
        `select ev.kind, ev.event_date::text as event_date, ev.reason, ev.created_at, u.full_name as actor
           from employment_contract_events ev left join users u on u.id = ev.created_by
          where ev.tenant_id = ? and ev.contract_id = ? order by ev.created_at`,
        [context.tenantId, id]
      )
      return {
        ...contractView(c, amendments),
        employee: { id: e.id, code: e.code, fullName: e.full_name, status: e.status },
        amendments,
        events: (events.rows as any[]).map((x) => ({
          kind: x.kind,
          date: x.event_date,
          reason: x.reason ?? null,
          actor: x.actor ?? null,
          createdAt: x.created_at,
        })),
        access: { manage: canManage },
      }
    })
  }

  create(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { e, canManage } = await employeeFor(
        scope,
        employeeId,
        'hr.contracts.read',
        'hr.contracts.manage'
      )
      assertCanManage(canManage)
      if (e.status === 'TERMINATED') wrongState('O colaborador já cessou funções.')
      const { values: v, issues } = normalizeFields(input, CONTRACT_FIELDS)
      for (const k of CONTRACT_REQUIRED)
        if (v[k] === undefined || v[k] === null)
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...contractIssues(v))
      if (typeof v.startDate === 'string' && v.startDate < e.hire_date_text)
        issues.push({
          path: 'startDate',
          code: 'BEFORE_HIRE',
          message: 'O contrato não pode começar antes da admissão.',
        })
      fail(issues)
      const keys = Object.keys(v).filter((k) => v[k] !== undefined)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into employment_contracts (tenant_id, employee_id, created_by, updated_by,
             ${keys.map((k) => C_COLUMNS[k]).join(', ')})
           values (?, ?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
          [
            context.tenantId,
            employeeId,
            context.userId,
            context.userId,
            ...keys.map((k) => v[k]),
          ] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        codeTaken(error)
      }
      await audit(scope, {
        action: 'hr.contract.created',
        entityType: 'employment_contract',
        entityId: id,
        changes: auditChanges({}, v),
        metadata: { employeeId },
      })
      const c = await findContract(scope, id)
      return contractView(c, [])
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { c, e, canManage } = await visibleContract(scope, id, true)
      assertCanManage(canManage)
      if (Number(c.version) !== expectedVersion) throw ApiError.versionConflict(Number(c.version))
      if (c.status !== 'DRAFT')
        wrongState('Só um contrato em rascunho se altera; depois use uma adenda.')
      const { values: v, issues } = normalizeFields(input, CONTRACT_FIELDS)
      const before = contractValues(c)
      const after = { ...before, ...v }
      for (const k of CONTRACT_REQUIRED)
        if (k in v && v[k] === null)
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...contractIssues(after))
      if (typeof after.startDate === 'string' && after.startDate < e.hire_date_text)
        issues.push({
          path: 'startDate',
          code: 'BEFORE_HIRE',
          message: 'O contrato não pode começar antes da admissão.',
        })
      fail(issues)
      const changed = Object.keys(v).filter((k) => (before[k] ?? null) !== (v[k] ?? null))
      if (changed.length) {
        try {
          await scope.trx.rawQuery(
            `update employment_contracts set ${changed.map((k) => `${C_COLUMNS[k]} = ?`).join(', ')},
               version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
            [...changed.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
          )
        } catch (error) {
          codeTaken(error)
        }
        await audit(scope, {
          action: 'hr.contract.updated',
          entityType: 'employment_contract',
          entityId: id,
          changes: auditChanges(before, Object.fromEntries(changed.map((k) => [k, v[k]]))),
        })
      }
      return contractView(await findContract(scope, id), [])
    })
  }

  /**
   * Mudanças de estado: activar (rascunho → em vigor; um contrato em vigor por colaborador e sem sobreposição com os
   * anteriores), suspender e retomar (com data e motivo), terminar (data e motivo) e cancelar um rascunho.
   */
  transition(
    context: TenantContext,
    id: string,
    action: keyof typeof CONTRACT_ACTIONS,
    input: { date?: string; reason?: string },
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { c, e, canManage } = await visibleContract(scope, id, true)
      assertCanManage(canManage)
      if (Number(c.version) !== expectedVersion) throw ApiError.versionConflict(Number(c.version))
      const rule = CONTRACT_ACTIONS[action]
      if (!rule.from.includes(c.status))
        wrongState(`Não é possível ${ACTION_LABEL[action]} um contrato neste estado.`)
      const reason = input.reason?.trim() || null
      const issues: ErrorDetail[] = []
      const date = action === 'activate' ? c.start_text : action === 'cancel' ? today() : input.date
      if (['suspend', 'resume', 'terminate'].includes(action)) {
        if (!isoDate(date))
          issues.push({ path: 'date', code: 'INVALID_DATE', message: 'Indique a data.' })
        else if (date! < c.start_text)
          issues.push({
            path: 'date',
            code: 'BEFORE_START',
            message: 'A data é anterior ao início do contrato.',
          })
        else if (action === 'resume' && date! < c.suspended_text)
          issues.push({
            path: 'date',
            code: 'BEFORE_SUSPENSION',
            message: 'A retoma é anterior à suspensão.',
          })
      }
      if ((action === 'suspend' || action === 'terminate') && !reason)
        issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' })
      fail(issues)

      const sets: string[] = ['status = ?']
      const params: unknown[] = [rule.to]
      if (action === 'activate') {
        if (e.status !== 'ACTIVE') wrongState('Só se activa o contrato de um colaborador activo.')
        // Sem sobreposição com contratos anteriores já terminados.
        const overlap = await scope.trx.rawQuery(
          `select 1 from employment_contracts where tenant_id = ? and employee_id = ? and id <> ?
             and status = 'ENDED' and termination_date >= ?::date limit 1`,
          [context.tenantId, c.employee_id, id, c.start_text]
        )
        if (overlap.rows.length)
          throw ApiError.conflict(
            'CONTRACT_OVERLAP',
            'O início sobrepõe-se a um contrato anterior deste colaborador.'
          )
      }
      if (action === 'suspend') {
        sets.push('suspended_from = ?')
        params.push(date)
      }
      if (action === 'resume') sets.push('suspended_from = null')
      if (action === 'terminate') {
        sets.push('termination_date = ?', 'termination_reason = ?', 'suspended_from = null')
        params.push(date, reason)
      }
      try {
        await scope.trx.rawQuery(
          `update employment_contracts set ${sets.join(', ')}, version = version + 1, updated_by = ?,
             updated_at = now() where tenant_id = ? and id = ?`,
          [...params, context.userId, context.tenantId, id] as never[]
        )
      } catch (error) {
        if (constraintOf(error) === 'employment_contracts_open_unique')
          throw ApiError.conflict(
            'CONTRACT_OPEN',
            'Este colaborador já tem um contrato em vigor; termine-o primeiro.'
          )
        throw error
      }
      await contractEvent(scope, id, EVENT_OF[action], date!, reason)
      await audit(scope, {
        action: `hr.contract.${EVENT_OF[action].toLowerCase()}`,
        entityType: 'employment_contract',
        entityId: id,
        changes: { status: { from: c.status, to: rule.to } },
        metadata: { date, ...(reason ? { reason } : {}) },
      })
      return contractView(await findContract(scope, id), await amendmentsOf(scope, id))
    })
  }

  /**
   * Adenda ou renovação, só de acréscimo: muda remuneração, horas, horário ou termo a partir de uma data de efeito. Não
   * reescreve o passado: a data de efeito não pode ser anterior à última adenda nem ao início do contrato.
   */
  amend(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { c, canManage } = await visibleContract(scope, id, true)
      assertCanManage(canManage)
      if (Number(c.version) !== expectedVersion) throw ApiError.versionConflict(Number(c.version))
      if (!['ACTIVE', 'SUSPENDED'].includes(c.status))
        wrongState('Só um contrato em vigor recebe adendas.')
      const kind = input.kind === 'RENEWAL' ? 'RENEWAL' : 'CHANGE'
      const { values: v, issues } = normalizeFields(input, {
        effectiveDate: { kind: 'date', label: 'Data de efeito' },
        baseSalary: { kind: 'money', label: 'Remuneração base' },
        weeklyHours: { kind: 'money', label: 'Horas semanais' },
        workSchedule: { kind: 'text', max: 200, label: 'Horário' },
        endDate: { kind: 'date', label: 'Termo' },
        reason: { kind: 'longtext', max: 1000, min: 3, label: 'Motivo' },
      })
      if (!['CHANGE', 'RENEWAL'].includes(input.kind as string))
        issues.push({ path: 'kind', code: 'INVALID', message: 'Alteração ou renovação.' })
      if (!v.effectiveDate)
        issues.push({ path: 'effectiveDate', code: 'REQUIRED', message: 'Obrigatório.' })
      if (!v.reason) issues.push({ path: 'reason', code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...hoursIssues(v.weeklyHours))
      if (!v.baseSalary && !v.weeklyHours && !v.workSchedule && !v.endDate)
        issues.push({ path: 'baseSalary', code: 'NO_CHANGE', message: 'Indique o que muda.' })
      fail(issues)
      const amendments = await amendmentsOf(scope, id)
      const last = amendments.at(-1)
      const eff = v.effectiveDate as string
      if (eff < c.start_text)
        issues.push({
          path: 'effectiveDate',
          code: 'BEFORE_START',
          message: 'A data de efeito é anterior ao início do contrato.',
        })
      if (last && eff < last.effectiveDate)
        issues.push({
          path: 'effectiveDate',
          code: 'NOT_RETROACTIVE',
          message: `Não pode ser anterior à última adenda (${last.effectiveDate}).`,
        })
      const terms = termsAt(baseTerms(c), amendments, eff)
      if (v.endDate) {
        if (c.contract_type === 'PERMANENT')
          issues.push({
            path: 'endDate',
            code: 'PERMANENT',
            message: 'Um contrato sem termo não tem data de termo.',
          })
        else if ((v.endDate as string) < eff)
          issues.push({
            path: 'endDate',
            code: 'BEFORE_EFFECTIVE',
            message: 'O termo é anterior à data de efeito.',
          })
      }
      if (kind === 'RENEWAL') {
        if (c.contract_type !== 'FIXED_TERM')
          issues.push({
            path: 'kind',
            code: 'NOT_FIXED_TERM',
            message: 'Só um contrato a termo certo se renova.',
          })
        else if (!v.endDate || (terms.endDate && (v.endDate as string) <= terms.endDate))
          issues.push({
            path: 'endDate',
            code: 'NOT_EXTENDED',
            message: 'A renovação tem de estender o termo actual.',
          })
      }
      fail(issues)
      const sequence = (last?.sequence ?? 0) + 1
      await scope.trx.rawQuery(
        `insert into employment_contract_amendments (tenant_id, contract_id, sequence, kind, effective_date,
           base_salary, weekly_hours, work_schedule, end_date, reason, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          id,
          sequence,
          kind,
          eff,
          v.baseSalary ?? null,
          v.weeklyHours ?? null,
          v.workSchedule ?? null,
          v.endDate ?? null,
          v.reason,
          context.userId,
          context.userId,
        ] as never[]
      )
      await scope.trx.rawQuery(
        `update employment_contracts set renewal_count = renewal_count + ?, version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [kind === 'RENEWAL' ? 1 : 0, context.userId, context.tenantId, id]
      )
      await contractEvent(
        scope,
        id,
        kind === 'RENEWAL' ? 'RENEWED' : 'AMENDED',
        eff,
        v.reason as string
      )
      const changed = Object.fromEntries(
        ['baseSalary', 'weeklyHours', 'workSchedule', 'endDate']
          .filter((k) => v[k] !== undefined && v[k] !== null)
          .map((k) => [k, v[k]])
      )
      await audit(scope, {
        action: kind === 'RENEWAL' ? 'hr.contract.renewed' : 'hr.contract.amended',
        entityType: 'employment_contract',
        entityId: id,
        changes: auditChanges(terms as unknown as Record<string, unknown>, changed),
        metadata: { sequence, effectiveDate: eff },
      })
      return contractView(await findContract(scope, id), await amendmentsOf(scope, id))
    })
  }
}

const ACTION_LABEL: Record<string, string> = {
  activate: 'activar',
  suspend: 'suspender',
  resume: 'retomar',
  terminate: 'terminar',
  cancel: 'cancelar',
}
const EVENT_OF: Record<string, string> = {
  activate: 'ACTIVATED',
  suspend: 'SUSPENDED',
  resume: 'RESUMED',
  terminate: 'TERMINATED',
  cancel: 'CANCELLED',
}

function codeTaken(error: unknown): never {
  if (constraintOf(error) === 'employment_contracts_code_unique')
    throw new ApiError(409, 'CODE_TAKEN', 'Já existe um contrato com este número.', [
      { path: 'code', code: 'CODE_TAKEN', message: 'Já existe um contrato com este número.' },
    ])
  throw error
}

// ---------------------------------------------------------------------------------------------------------------
// Carreira (histórico de colocação)
// ---------------------------------------------------------------------------------------------------------------

const A_SELECT = `select a.*, a.valid_from::text as from_text, a.valid_to::text as to_text,
    b.name as branch_name, d.name as department_name, p.name as position_name, cc.code as cost_center_code,
    m.full_name as manager_name, u.full_name as actor
  from employment_assignments a
  left join branches b on b.tenant_id = a.tenant_id and b.id = a.branch_id
  left join departments d on d.tenant_id = a.tenant_id and d.id = a.department_id
  left join positions p on p.tenant_id = a.tenant_id and p.id = a.position_id
  left join cost_centers cc on cc.tenant_id = a.tenant_id and cc.id = a.cost_center_id
  left join employees m on m.tenant_id = a.tenant_id and m.id = a.manager_id
  left join users u on u.id = a.created_by`

function assignmentView(a: any) {
  return {
    id: a.id as string,
    kind: a.kind as string,
    validFrom: a.from_text as string,
    validTo: (a.to_text as string) ?? null,
    branchId: (a.branch_id as string) ?? null,
    departmentId: (a.department_id as string) ?? null,
    positionId: (a.position_id as string) ?? null,
    managerId: (a.manager_id as string) ?? null,
    costCenterId: (a.cost_center_id as string) ?? null,
    branchName: (a.branch_name as string) ?? null,
    departmentName: (a.department_name as string) ?? null,
    positionName: (a.position_name as string) ?? null,
    costCenterCode: (a.cost_center_code as string) ?? null,
    managerName: (a.manager_name as string) ?? null,
    reason: (a.reason as string) ?? null,
    actor: (a.actor as string) ?? null,
  }
}

/** Período em aberto; os colaboradores anteriores ao 7.3 ganham-no aqui a partir da colocação actual. */
async function currentAssignment(scope: TenantScope, e: any) {
  const r = await scope.trx.rawQuery(
    `select a.*, a.valid_from::text as from_text from employment_assignments a
      where a.tenant_id = ? and a.employee_id = ? and a.valid_to is null for update`,
    [scope.context.tenantId, e.id]
  )
  if (r.rows[0]) return r.rows[0] as any
  const ins = await scope.trx.rawQuery(
    `insert into employment_assignments (tenant_id, employee_id, kind, valid_from, legal_entity_id, branch_id,
       department_id, position_id, manager_id, cost_center_id, created_by, updated_by)
     values (?, ?, 'HIRE', ?, ?, ?, ?, ?, ?, ?, ?, ?) returning *, valid_from::text as from_text`,
    [
      scope.context.tenantId,
      e.id,
      e.hire_date_text,
      e.legal_entity_id,
      e.branch_id,
      e.department_id,
      e.position_id,
      e.manager_id,
      e.cost_center_id,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  return ins.rows[0] as any
}

const A_COLUMNS: Record<(typeof PLACEMENT_KEYS)[number], string> = {
  branchId: 'branch_id',
  departmentId: 'department_id',
  positionId: 'position_id',
  managerId: 'manager_id',
  costCenterId: 'cost_center_id',
}

export class CareerService {
  list(context: TenantContext, employeeId: string) {
    return runInTenant(context, async (scope) => {
      const { canManage } = await employeeFor(scope, employeeId, 'hr.read', 'hr.manage')
      const r = await scope.trx.rawQuery(
        `${A_SELECT} where a.tenant_id = ? and a.employee_id = ? order by a.valid_from desc`,
        [context.tenantId, employeeId]
      )
      return { items: (r.rows as any[]).map(assignmentView), canManage }
    })
  }

  /**
   * Movimento de carreira com data de efeito (até hoje): fecha o período corrente na véspera, abre o novo e actualiza
   * a colocação da ficha, na mesma transacção. A entidade legal não muda (isso é um novo contrato noutra entidade).
   */
  move(
    context: TenantContext,
    employeeId: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const e = await findRow(scope, employeeId, true)
      const hr = new EmployeeService()
      const [read, manage] = await Promise.all([
        permissionScope(scope, 'hr.read'),
        permissionScope(scope, 'hr.manage'),
      ])
      const me = context.membershipId
      if (!e || (!covers(read, placementOf(e), me) && !covers(noOwn(manage), placementOf(e), me)))
        throw ApiError.notFound()
      hr.assertManage({ manage }, placementOf(e), me)
      if (Number(e.version) !== expectedVersion) throw ApiError.versionConflict(Number(e.version))
      if (e.status === 'TERMINATED') wrongState('O colaborador já cessou funções.')
      const issues: ErrorDetail[] = []
      const kind = input.kind as string
      if (!ASSIGNMENT_KINDS.includes(kind as never))
        issues.push({
          path: 'kind',
          code: 'INVALID',
          message: 'Transferência, promoção ou alteração.',
        })
      const { values: v, issues: more } = normalizeFields(input, {
        effectiveDate: { kind: 'date', label: 'Data de efeito' },
        branchId: { kind: 'uuid', label: 'Filial' },
        departmentId: { kind: 'uuid', label: 'Departamento' },
        positionId: { kind: 'uuid', label: 'Cargo' },
        managerId: { kind: 'uuid', label: 'Superior' },
        costCenterId: { kind: 'uuid', label: 'Centro de custo' },
        reason: { kind: 'longtext', max: 1000, min: 3, label: 'Motivo' },
      })
      issues.push(...more)
      if ('legalEntityId' in input && input.legalEntityId !== e.legal_entity_id)
        issues.push({
          path: 'legalEntityId',
          code: 'USE_NEW_CONTRACT',
          message: 'A entidade legal não muda por movimento: termine o contrato e admita na outra.',
        })
      const eff = v.effectiveDate as string | undefined
      if (!eff) issues.push({ path: 'effectiveDate', code: 'REQUIRED', message: 'Obrigatório.' })
      else if (eff > today())
        issues.push({
          path: 'effectiveDate',
          code: 'FUTURE_DATE',
          message: 'Registe o movimento na data em que produz efeito (até hoje).',
        })
      if (!v.reason) issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' })
      fail(issues)
      const current = await currentAssignment(scope, e)
      if (eff! <= current.from_text)
        fail([
          {
            path: 'effectiveDate',
            code: 'NOT_AFTER_CURRENT',
            message: `O movimento tem de ser posterior ao início da colocação actual (${current.from_text}).`,
          },
        ])
      const before = Object.fromEntries(
        PLACEMENT_KEYS.map((k) => [k, (current[A_COLUMNS[k]] as string) ?? null])
      )
      const after = { ...before }
      for (const k of PLACEMENT_KEYS) if (k in v) after[k] = (v[k] as string) ?? null
      const changed = PLACEMENT_KEYS.filter((k) => before[k] !== after[k])
      if (!changed.length)
        fail([{ path: 'positionId', code: 'NO_CHANGE', message: 'A colocação não muda.' }])
      if (kind === 'PROMOTION' && !changed.includes('positionId'))
        fail([
          {
            path: 'positionId',
            code: 'POSITION_REQUIRED',
            message: 'Uma promoção muda o cargo.',
          },
        ])
      const place = {
        legalEntityId: e.legal_entity_id,
        branchId: after.branchId,
        departmentId: after.departmentId,
        membershipId: e.membership_id,
      }
      hr.assertManage({ manage }, place, me)
      await hr.checkReferences(
        scope,
        {
          legalEntityId: e.legal_entity_id,
          ...after,
          hireDate: e.hire_date_text,
          birthDate: null,
        },
        e.id
      )
      await scope.trx.rawQuery(
        `update employment_assignments set valid_to = ?, version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [previousDay(eff!), context.userId, context.tenantId, current.id]
      )
      const ins = await scope.trx.rawQuery(
        `insert into employment_assignments (tenant_id, employee_id, kind, valid_from, legal_entity_id, branch_id,
           department_id, position_id, manager_id, cost_center_id, reason, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          e.id,
          kind,
          eff,
          e.legal_entity_id,
          after.branchId,
          after.departmentId,
          after.positionId,
          after.managerId,
          after.costCenterId,
          v.reason,
          context.userId,
          context.userId,
        ] as never[]
      )
      await scope.trx.rawQuery(
        `update employees set ${PLACEMENT_KEYS.map((k) => `${A_COLUMNS[k]} = ?`).join(', ')}, version = version + 1,
           updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [...PLACEMENT_KEYS.map((k) => after[k]), context.userId, context.tenantId, e.id] as never[]
      )
      await audit(scope, {
        action: `hr.employee.${kind.toLowerCase()}`,
        entityType: 'employee',
        entityId: e.id,
        changes: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])),
        metadata: {
          assignmentId: (ins.rows[0] as { id: string }).id,
          effectiveDate: eff,
          reason: v.reason,
        },
      })
      const r = await scope.trx.rawQuery(
        `${A_SELECT} where a.tenant_id = ? and a.employee_id = ? order by a.valid_from desc`,
        [context.tenantId, e.id]
      )
      return {
        items: (r.rows as any[]).map(assignmentView),
        employeeVersion: Number(e.version) + 1,
      }
    })
  }
}
