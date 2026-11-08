import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts, orgReferenceFacts } from '#modules/organization/index'
import {
  isActiveWorkflowFor,
  submitForSubject,
  type ApprovalOutcome,
} from '#modules/approvals/index'
import { covers, EmployeeService, scopeClause } from '#modules/hr/application/employee_service'
import {
  type ApplicationStage,
  CANDIDATE_FIELDS,
  CLOSED_STAGES,
  INTERVIEW_FIELDS,
  INTERVIEW_MODES,
  ONBOARDING_CATEGORIES,
  ONBOARDING_FIELDS,
  OFFER_FIELDS,
  REQUISITION_FIELDS,
  REQUISITION_REQUIRED,
  STAGE_TRANSITIONS,
  normalizeFields,
  parseInstant,
  requisitionIssues,
  withinRange,
} from '#modules/hr/domain/recruitment'

/*
 * Recrutamento e onboarding (7.2). O âmbito vem da colocação da vaga (entidade legal, filial, departamento) e das
 * permissões `hr.recruitment.read|manage|approve`; quem não vê a vaga não vê as candidaturas, entrevistas nem
 * propostas dela (404). Aprovar exige `hr.recruitment.approve` no âmbito e nunca é quem pediu (segregação), ou o
 * workflow configurado em `hr_settings`, cujo resultado chega por `onRequisitionDecided` / `onOfferDecided`.
 */

const today = () => new Date().toISOString().slice(0, 10)

interface RecruitmentScopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}

async function rScopes(scope: TenantScope): Promise<RecruitmentScopes> {
  const [read, manage, approve] = await Promise.all([
    permissionScope(scope, 'hr.recruitment.read'),
    permissionScope(scope, 'hr.recruitment.manage'),
    permissionScope(scope, 'hr.recruitment.approve'),
  ])
  return { read, manage, approve }
}

const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const placeOf = (r: any) => ({
  legalEntityId: r.legal_entity_id as string,
  branchId: (r.branch_id as string) ?? null,
  departmentId: (r.department_id as string) ?? null,
  membershipId: null,
})
const coversReq = (s: PermissionScope, r: any, me: string) => covers(noOwn(s), placeOf(r), me)
const canSee = (s: RecruitmentScopes, r: any, me: string) =>
  coversReq(s.read, r, me) || coversReq(s.manage, r, me) || coversReq(s.approve, r, me)

/** Filtro SQL das vagas visíveis (alias da tabela de vagas); `null` se o actor não vê nenhuma. */
function visibleClause(s: RecruitmentScopes, me: string, alias: string) {
  const parts = [s.read, s.manage, s.approve]
    .map((p) => scopeClause(noOwn(p), me, alias))
    .filter((c): c is NonNullable<typeof c> => c !== null)
  if (!parts.length) return null
  return {
    sql: `(${parts.map((p) => p.sql).join(' or ')})`,
    params: parts.flatMap((p) => p.params),
  }
}

function assertManage(s: RecruitmentScopes, r: any, me: string) {
  if (!coversReq(s.manage, r, me))
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      'Não gere o recrutamento nesta entidade, filial ou departamento.'
    )
}

function expectVersion(row: any, expected: number) {
  if (Number(row.version) !== expected) throw ApiError.versionConflict(Number(row.version))
}

function wrongState(message: string): never {
  throw ApiError.conflict('INVALID_STATE', message)
}

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}

const like = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`

async function memberActive(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select 1 from tenant_memberships where tenant_id = ? and id = ? and status = 'ACTIVE'`,
    [scope.context.tenantId, id]
  )
  return r.rows.length > 0
}

// ---------------------------------------------------------------------------------------------------------------
// Configuração (workflows de aprovação)
// ---------------------------------------------------------------------------------------------------------------

/** Configuração de RH: workflows (recrutamento, compensação) e limites de adiantamentos/empréstimos (com fonte). */
const SETTINGS_COLUMNS = {
  requisitionWorkflowId: 'requisition_workflow_id',
  offerWorkflowId: 'offer_workflow_id',
  compensationWorkflowId: 'compensation_workflow_id',
  loanMaxInstallmentPercent: 'loan_max_installment_percent',
  loanMaxInstallments: 'loan_max_installments',
  loanPolicyReference: 'loan_policy_reference',
} as const
type SettingsKey = keyof typeof SETTINGS_COLUMNS
const WORKFLOW_SUBJECTS: [SettingsKey, string][] = [
  ['requisitionWorkflowId', 'job_requisition'],
  ['offerWorkflowId', 'job_offer'],
  ['compensationWorkflowId', 'compensation_proposal'],
]

export async function hrSettings(scope: TenantScope) {
  const r = await scope.trx.rawQuery(`select * from hr_settings where tenant_id = ?`, [
    scope.context.tenantId,
  ])
  const row = r.rows[0] as any
  return {
    requisitionWorkflowId: (row?.requisition_workflow_id as string) ?? null,
    offerWorkflowId: (row?.offer_workflow_id as string) ?? null,
    compensationWorkflowId: (row?.compensation_workflow_id as string) ?? null,
    loanMaxInstallmentPercent: (row?.loan_max_installment_percent as string) ?? null,
    loanMaxInstallments:
      row?.loan_max_installments === null || row?.loan_max_installments === undefined
        ? null
        : Number(row.loan_max_installments),
    loanPolicyReference: (row?.loan_policy_reference as string) ?? null,
    version: row ? Number(row.version) : 0,
  }
}

export class HrSettingsService {
  get(context: TenantContext) {
    return runInTenant(context, (scope) => hrSettings(scope))
  }

  update(
    context: TenantContext,
    input: Partial<Record<SettingsKey, unknown>>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const current = await hrSettings(scope)
      if (current.version !== expectedVersion) throw ApiError.versionConflict(current.version)
      const issues: ErrorDetail[] = []
      const { values: limits, issues: limitIssues } = normalizeFields(
        input as Record<string, unknown>,
        {
          loanMaxInstallmentPercent: { kind: 'money', label: 'Prestação máxima (%)' },
          loanPolicyReference: { kind: 'longtext', min: 5, max: 2000, label: 'Fonte dos limites' },
        }
      )
      issues.push(...limitIssues)
      const next: Record<string, unknown> = { ...current }
      for (const k of Object.keys(SETTINGS_COLUMNS) as SettingsKey[])
        if (k in input) next[k] = input[k] ?? null
      Object.assign(next, limits)
      if ('loanMaxInstallments' in input && input.loanMaxInstallments !== null) {
        const n = input.loanMaxInstallments
        if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 120)
          issues.push({
            path: 'loanMaxInstallments',
            code: 'INVALID',
            message: 'Entre 1 e 120 prestações.',
          })
      }
      const pct = next.loanMaxInstallmentPercent as string | null
      if (pct !== null && (Number(pct) <= 0 || Number(pct) > 100))
        issues.push({
          path: 'loanMaxInstallmentPercent',
          code: 'INVALID',
          message: 'Entre 0 e 100.',
        })
      if ((pct !== null || next.loanMaxInstallments !== null) && !next.loanPolicyReference)
        issues.push({
          path: 'loanPolicyReference',
          code: 'REQUIRED',
          message: 'Indique a fonte legal ou interna dos limites.',
        })
      for (const [key, subject] of WORKFLOW_SUBJECTS)
        if (next[key] && !(await isActiveWorkflowFor(scope, next[key] as string, subject)))
          issues.push({
            path: key,
            code: 'WORKFLOW_UNAVAILABLE',
            message: 'Escolha um workflow publicado para este tipo de assunto.',
          })
      fail(issues)
      const keys = Object.keys(SETTINGS_COLUMNS) as SettingsKey[]
      const cols = keys.map((k) => SETTINGS_COLUMNS[k])
      const vals = keys.map((k) => next[k] ?? null)
      if (current.version === 0)
        await scope.trx.rawQuery(
          `insert into hr_settings (tenant_id, ${cols.join(', ')}, created_by, updated_by)
           values (?, ${cols.map(() => '?').join(', ')}, ?, ?)`,
          [context.tenantId, ...vals, context.userId, context.userId] as never[]
        )
      else
        await scope.trx.rawQuery(
          `update hr_settings set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1,
             updated_by = ?, updated_at = now() where tenant_id = ?`,
          [...vals, context.userId, context.tenantId] as never[]
        )
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const k of keys)
        if ((current as Record<string, unknown>)[k] !== (next[k] ?? null))
          changes[k] = { from: (current as Record<string, unknown>)[k], to: next[k] ?? null }
      await audit(scope, {
        action: 'hr.settings.updated',
        entityType: 'hr_settings',
        entityId: context.tenantId,
        changes,
      })
      return hrSettings(scope)
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Vagas
// ---------------------------------------------------------------------------------------------------------------

const REQ_SELECT = `select r.*, r.deadline::text as deadline_text,
    le.code as le_code, le.legal_name as le_name, b.name as branch_name, d.name as department_name,
    p.code as position_code, p.name as position_name,
    (select count(*) from job_applications a where a.tenant_id = r.tenant_id and a.requisition_id = r.id)::int
      as applications_count,
    (select count(*) from job_applications a where a.tenant_id = r.tenant_id and a.requisition_id = r.id
      and a.stage = 'HIRED')::int as hired_count
  from job_requisitions r
  join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
  join positions p on p.tenant_id = r.tenant_id and p.id = r.position_id
  left join branches b on b.tenant_id = r.tenant_id and b.id = r.branch_id
  left join departments d on d.tenant_id = r.tenant_id and d.id = r.department_id`

async function findRequisition(scope: TenantScope, id: string, lock = false) {
  const r = await scope.trx.rawQuery(
    `${REQ_SELECT} where r.tenant_id = ? and r.id = ?${lock ? ' for update of r' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

function requisitionView(r: any) {
  return {
    id: r.id as string,
    version: Number(r.version),
    code: r.code as string,
    title: r.title as string,
    legalEntityId: r.legal_entity_id as string,
    branchId: (r.branch_id as string) ?? null,
    departmentId: (r.department_id as string) ?? null,
    positionId: r.position_id as string,
    requirements: (r.requirements as string) ?? null,
    justification: (r.justification as string) ?? null,
    quantity: Number(r.quantity),
    deadline: (r.deadline_text as string) ?? null,
    currency: r.currency as string,
    salaryMin: r.salary_min as string,
    salaryMax: r.salary_max as string,
    status: r.status as string,
    approvalRequestId: (r.approval_request_id as string) ?? null,
    approvedAt: r.approved_at ?? null,
    rejectionReason: (r.rejection_reason as string) ?? null,
    legalEntity: { code: r.le_code as string, name: r.le_name as string },
    branchName: (r.branch_name as string) ?? null,
    departmentName: (r.department_name as string) ?? null,
    position: { code: r.position_code as string, name: r.position_name as string },
    applicationsCount: Number(r.applications_count),
    hiredCount: Number(r.hired_count),
    createdAt: r.created_at,
  }
}

const REQ_SORT = {
  code: 'r.code',
  title: 'r.title',
  deadline: 'r.deadline',
  status: 'r.status',
  createdAt: 'r.created_at',
} as const
export const REQUISITION_SORT_FIELDS = Object.keys(REQ_SORT) as (keyof typeof REQ_SORT)[]

/** Coerência da colocação com a estrutura: tudo da mesma entidade legal, activo e consistente. */
async function checkPlacement(scope: TenantScope, v: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const le = await legalEntityFacts(scope, v.legalEntityId as string)
  if (!le)
    fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade legal inexistente.' }])
  if (le!.status !== 'ACTIVE')
    issues.push({ path: 'legalEntityId', code: 'INACTIVE', message: 'Entidade legal inactiva.' })
  const facts = await orgReferenceFacts(scope, {
    branchId: v.branchId as string,
    departmentId: v.departmentId as string,
    positionId: v.positionId as string,
  })
  const ref = (
    key: string,
    fact: { legalEntityId?: string; status: string } | null,
    label: string
  ) => {
    if (!v[key]) return
    if (!fact)
      return issues.push({ path: key, code: 'NOT_FOUND', message: `${label} inexistente.` })
    if (fact.status !== 'ACTIVE')
      issues.push({ path: key, code: 'INACTIVE', message: `${label} inactivo(a).` })
    if (fact.legalEntityId && fact.legalEntityId !== v.legalEntityId)
      issues.push({
        path: key,
        code: 'OTHER_LEGAL_ENTITY',
        message: `${label} de outra entidade legal.`,
      })
  }
  ref('branchId', facts.branch, 'Filial')
  ref('departmentId', facts.department, 'Departamento')
  ref('positionId', facts.position, 'Cargo')
  if (facts.department?.branchId && v.branchId && facts.department.branchId !== v.branchId)
    issues.push({
      path: 'departmentId',
      code: 'OTHER_BRANCH',
      message: 'O departamento pertence a outra filial.',
    })
  if (
    facts.position?.departmentId &&
    v.departmentId &&
    facts.position.departmentId !== v.departmentId
  )
    issues.push({
      path: 'positionId',
      code: 'OTHER_DEPARTMENT',
      message: 'O cargo pertence a outro departamento.',
    })
  fail(issues)
}

const REQ_COLUMNS: Record<string, string> = {
  code: 'code',
  title: 'title',
  legalEntityId: 'legal_entity_id',
  branchId: 'branch_id',
  departmentId: 'department_id',
  positionId: 'position_id',
  requirements: 'requirements',
  justification: 'justification',
  quantity: 'quantity',
  deadline: 'deadline',
  currency: 'currency',
  salaryMin: 'salary_min',
  salaryMax: 'salary_max',
}

function uniqueOr(error: unknown, map: Record<string, [string, string, string]>): never {
  const c = constraintOf(error)
  const u = c ? map[c] : undefined
  if (u) throw new ApiError(409, u[1], u[2], [{ path: u[0], code: u[1], message: u[2] }])
  throw error
}

export interface RequisitionFilter {
  q?: string
  status?: string
  legalEntityId?: string
  departmentId?: string
  sort?: { field: keyof typeof REQ_SORT; direction: 'asc' | 'desc' }
  limit: number
  offset: number
}

export class RequisitionService {
  list(context: TenantContext, f: RequisitionFilter) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const visible = visibleClause(s, context.membershipId, 'r')
      if (!visible) return { items: [], total: 0 }
      const where = ['r.tenant_id = ?', visible.sql]
      const params: unknown[] = [context.tenantId, ...visible.params]
      for (const [key, column] of [
        ['status', 'r.status'],
        ['legalEntityId', 'r.legal_entity_id'],
        ['departmentId', 'r.department_id'],
      ] as const)
        if (f[key]) {
          where.push(`${column} = ?`)
          params.push(f[key])
        }
      if (f.q) {
        where.push(`(lower(r.code) like ? or lower(r.title) like ?)`)
        params.push(like(f.q), like(f.q))
      }
      const clause = where.join(' and ')
      const order = f.sort
        ? `${REQ_SORT[f.sort.field]} ${f.sort.direction === 'desc' ? 'desc' : 'asc'} nulls last, r.code`
        : 'r.created_at desc'
      const rows = await scope.trx.rawQuery(
        `${REQ_SELECT} where ${clause} order by ${order} limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from job_requisitions r where ${clause}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map(requisitionView),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const r = await findRequisition(scope, id)
      const s = await rScopes(scope)
      const me = context.membershipId
      if (!r || !canSee(s, r, me)) throw ApiError.notFound()
      const stages = await scope.trx.rawQuery(
        `select stage, count(*)::int as n from job_applications where tenant_id = ? and requisition_id = ?
          group by stage`,
        [context.tenantId, id]
      )
      const settings = await hrSettings(scope)
      return {
        ...requisitionView(r),
        stageCounts: Object.fromEntries((stages.rows as any[]).map((x) => [x.stage, x.n])),
        approvalMode: settings.requisitionWorkflowId ? 'WORKFLOW' : 'DIRECT',
        access: {
          manage: coversReq(s.manage, r, me),
          approve: coversReq(s.approve, r, me) && r.created_by !== context.userId,
        },
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { values: v, issues } = normalizeFields(input, REQUISITION_FIELDS)
      for (const key of REQUISITION_REQUIRED)
        if (v[key] === undefined || v[key] === null)
          issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...requisitionIssues(v, today()))
      fail(issues)
      const s = await rScopes(scope)
      assertManage(
        s,
        { legal_entity_id: v.legalEntityId, branch_id: v.branchId, department_id: v.departmentId },
        context.membershipId
      )
      await checkPlacement(scope, v)
      const keys = Object.keys(v).filter((k) => v[k] !== undefined)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into job_requisitions (tenant_id, created_by, updated_by, ${keys.map((k) => REQ_COLUMNS[k]).join(', ')})
           values (?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
          [context.tenantId, context.userId, context.userId, ...keys.map((k) => v[k])] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        uniqueOr(error, {
          job_requisitions_code_unique: [
            'code',
            'CODE_TAKEN',
            'Já existe uma vaga com este código.',
          ],
        })
      }
      await audit(scope, {
        action: 'hr.requisition.created',
        entityType: 'job_requisition',
        entityId: id,
        changes: Object.fromEntries(keys.map((k) => [k, { from: null, to: v[k] }])),
      })
      return requisitionView(await findRequisition(scope, id))
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const r = await findRequisition(scope, id, true)
      const s = await rScopes(scope)
      const me = context.membershipId
      if (!r || !canSee(s, r, me)) throw ApiError.notFound()
      assertManage(s, r, me)
      expectVersion(r, expectedVersion)
      if (r.status !== 'DRAFT') wrongState('Só uma vaga em rascunho se altera.')
      const { values: v, issues } = normalizeFields(input, REQUISITION_FIELDS)
      const before = requisitionView(r) as Record<string, unknown>
      const after = { ...before, ...v }
      for (const key of REQUISITION_REQUIRED)
        if (key in v && v[key] === null)
          issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...requisitionIssues(after, today()))
      fail(issues)
      assertManage(
        s,
        {
          legal_entity_id: after.legalEntityId,
          branch_id: after.branchId,
          department_id: after.departmentId,
        },
        me
      )
      await checkPlacement(scope, after)
      const changed = Object.keys(v).filter((k) => (before[k] ?? null) !== (v[k] ?? null))
      if (changed.length) {
        try {
          await scope.trx.rawQuery(
            `update job_requisitions set ${changed.map((k) => `${REQ_COLUMNS[k]} = ?`).join(', ')},
               version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
            [...changed.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
          )
        } catch (error) {
          uniqueOr(error, {
            job_requisitions_code_unique: [
              'code',
              'CODE_TAKEN',
              'Já existe uma vaga com este código.',
            ],
          })
        }
        await audit(scope, {
          action: 'hr.requisition.updated',
          entityType: 'job_requisition',
          entityId: id,
          changes: Object.fromEntries(
            changed.map((k) => [k, { from: before[k] ?? null, to: v[k] }])
          ),
        })
      }
      return requisitionView(await findRequisition(scope, id))
    })
  }

  /** Pedir aprovação: pelo workflow configurado ou directamente a quem tem `hr.recruitment.approve`. */
  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const r = await findRequisition(scope, id, true)
      const s = await rScopes(scope)
      if (!r || !canSee(s, r, context.membershipId)) throw ApiError.notFound()
      assertManage(s, r, context.membershipId)
      expectVersion(r, expectedVersion)
      if (r.status !== 'DRAFT') wrongState('Só uma vaga em rascunho se submete.')
      if (r.deadline_text && r.deadline_text < today())
        fail([{ path: 'deadline', code: 'PAST_DATE', message: 'O prazo já passou.' }])
      const settings = await hrSettings(scope)
      let requestId: string | null = null
      if (settings.requisitionWorkflowId)
        requestId = await submitForSubject(scope, {
          workflowId: settings.requisitionWorkflowId,
          subjectType: 'job_requisition',
          subjectId: id,
          title: `Vaga ${r.code}: ${r.title}`,
          description: `${r.quantity} posto(s) · ${r.position_name} · ${r.currency} ${r.salary_min} a ${r.salary_max}`,
        })
      await scope.trx.rawQuery(
        `update job_requisitions set status = 'PENDING_APPROVAL', approval_request_id = ?, rejection_reason = null,
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [requestId, context.userId, context.tenantId, id] as never[]
      )
      await audit(scope, {
        action: 'hr.requisition.submitted',
        entityType: 'job_requisition',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'PENDING_APPROVAL' } },
        metadata: requestId ? { approvalRequestId: requestId } : { mode: 'DIRECT' },
      })
      return requisitionView(await findRequisition(scope, id))
    })
  }

  /** Decisão directa (sem workflow): `hr.recruitment.approve` no âmbito e nunca quem criou a vaga. */
  decide(
    context: TenantContext,
    id: string,
    decision: 'APPROVE' | 'REJECT',
    reason: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const r = await findRequisition(scope, id, true)
      const s = await rScopes(scope)
      const me = context.membershipId
      if (!r || !canSee(s, r, me)) throw ApiError.notFound()
      if (!coversReq(s.approve, r, me))
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Não aprova vagas nesta entidade, filial ou departamento.'
        )
      expectVersion(r, expectedVersion)
      if (r.status !== 'PENDING_APPROVAL') wrongState('A vaga não aguarda aprovação.')
      if (r.approval_request_id)
        throw ApiError.conflict(
          'USE_APPROVAL_WORKFLOW',
          'Esta vaga é decidida no workflow de aprovação.'
        )
      if (r.created_by === context.userId)
        throw ApiError.forbidden('SEGREGATION', 'Quem pede a vaga não a pode aprovar.')
      if (decision === 'REJECT' && !reason)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo da recusa.' }])
      await applyRequisitionDecision(
        scope,
        r,
        decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reason
      )
      return requisitionView(await findRequisition(scope, id))
    })
  }

  /** Fechar (deixar de recrutar) ou cancelar. */
  finish(
    context: TenantContext,
    id: string,
    to: 'CLOSED' | 'CANCELLED',
    reason: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const r = await findRequisition(scope, id, true)
      const s = await rScopes(scope)
      if (!r || !canSee(s, r, context.membershipId)) throw ApiError.notFound()
      assertManage(s, r, context.membershipId)
      expectVersion(r, expectedVersion)
      const allowed = to === 'CLOSED' ? ['OPEN'] : ['DRAFT', 'OPEN']
      if (!allowed.includes(r.status))
        wrongState(
          to === 'CLOSED' ? 'Só uma vaga aberta se fecha.' : 'Esta vaga já não se cancela.'
        )
      const pending = await scope.trx.rawQuery(
        `select 1 from job_offers o join job_applications a on a.tenant_id = o.tenant_id and a.id = o.application_id
          where o.tenant_id = ? and a.requisition_id = ? and o.status = 'ACCEPTED' limit 1`,
        [context.tenantId, id]
      )
      if (pending.rows.length)
        throw ApiError.conflict('PENDING_HIRE', 'Há uma proposta aceite por contratar nesta vaga.')
      await scope.trx.rawQuery(
        `update job_requisitions set status = ?, version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [to, context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: to === 'CLOSED' ? 'hr.requisition.closed' : 'hr.requisition.cancelled',
        entityType: 'job_requisition',
        entityId: id,
        changes: { status: { from: r.status, to } },
        metadata: reason ? { reason } : null,
      })
      return requisitionView(await findRequisition(scope, id))
    })
  }
}

async function applyRequisitionDecision(
  scope: TenantScope,
  r: any,
  outcome: ApprovalOutcome,
  reason: string | null
) {
  const approved = outcome === 'APPROVED'
  await scope.trx.rawQuery(
    `update job_requisitions set status = ?, approved_by = ?, approved_at = ${approved ? 'now()' : 'null'},
       rejection_reason = ?, approval_request_id = ${approved ? 'approval_request_id' : 'null'},
       version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
    [
      approved ? 'OPEN' : 'DRAFT',
      approved ? scope.context.userId : null,
      approved ? null : reason,
      scope.context.userId,
      scope.context.tenantId,
      r.id,
    ]
  )
  await audit(scope, {
    action: approved ? 'hr.requisition.approved' : 'hr.requisition.rejected',
    entityType: 'job_requisition',
    entityId: r.id,
    changes: { status: { from: 'PENDING_APPROVAL', to: approved ? 'OPEN' : 'DRAFT' } },
    metadata: reason ? { reason } : null,
  })
}

/** Efeito da conclusão do workflow de uma vaga (registado em `start/module_hooks.ts`). */
export async function onRequisitionDecided(
  scope: TenantScope,
  id: string,
  outcome: ApprovalOutcome
) {
  const r = await findRequisition(scope, id, true)
  if (!r || r.status !== 'PENDING_APPROVAL') return
  await applyRequisitionDecision(
    scope,
    r,
    outcome,
    outcome === 'APPROVED'
      ? null
      : outcome === 'REJECTED'
        ? 'Recusada no workflow de aprovação.'
        : 'Pedido de aprovação cancelado.'
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Candidatos
// ---------------------------------------------------------------------------------------------------------------

/** Candidatos visíveis: todos com âmbito de empresa; senão os que o actor registou ou com candidatura a vaga visível. */
function candidateClause(s: RecruitmentScopes, context: TenantContext) {
  if (s.read.tenant || s.manage.tenant || s.approve.tenant)
    return { sql: 'true', params: [] as unknown[] }
  const v = visibleClause(s, context.membershipId, 'vr')
  const parts = ['c.created_by = ?']
  const params: unknown[] = [context.userId]
  if (v) {
    parts.push(`exists (select 1 from job_applications va join job_requisitions vr
      on vr.tenant_id = va.tenant_id and vr.id = va.requisition_id
      where va.tenant_id = c.tenant_id and va.candidate_id = c.id and ${v.sql})`)
    params.push(...v.params)
  }
  return { sql: `(${parts.join(' or ')})`, params }
}

const hasAny = (p: PermissionScope) =>
  p.tenant || p.legalEntityIds.size > 0 || p.branchIds.size > 0 || p.departmentIds.size > 0

function candidateView(c: any) {
  return {
    id: c.id as string,
    version: Number(c.version),
    fullName: c.full_name as string,
    email: (c.email as string) ?? null,
    phone: (c.phone as string) ?? null,
    source: (c.source as string) ?? null,
    notes: (c.notes as string) ?? null,
    applicationsCount:
      c.applications_count !== undefined ? Number(c.applications_count) : undefined,
    createdAt: c.created_at,
  }
}

const CANDIDATE_COLUMNS: Record<string, string> = {
  fullName: 'full_name',
  email: 'email',
  phone: 'phone',
  source: 'source',
  notes: 'notes',
}
const CANDIDATE_UNIQUE: Record<string, [string, string, string]> = {
  candidates_email_unique: ['email', 'EMAIL_TAKEN', 'Já existe um candidato com este email.'],
}

async function visibleCandidate(
  scope: TenantScope,
  s: RecruitmentScopes,
  id: string,
  lock = false
) {
  const clause = candidateClause(s, scope.context)
  const r = await scope.trx.rawQuery(
    `select c.* from candidates c where c.tenant_id = ? and c.id = ? and ${clause.sql}${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id, ...clause.params] as never[]
  )
  return (r.rows[0] as any) ?? null
}

export class CandidateService {
  list(context: TenantContext, f: { q?: string; limit: number; offset: number }) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      if (!hasAny(s.read) && !hasAny(s.manage) && !hasAny(s.approve)) return { items: [], total: 0 }
      const clause = candidateClause(s, context)
      const where = ['c.tenant_id = ?', clause.sql]
      const params: unknown[] = [context.tenantId, ...clause.params]
      if (f.q) {
        where.push(
          `(lower(c.full_name) like ? or lower(coalesce(c.email, '')) like ? or c.phone like ?)`
        )
        params.push(like(f.q), like(f.q), like(f.q))
      }
      const sql = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select c.*, (select count(*) from job_applications a where a.tenant_id = c.tenant_id
            and a.candidate_id = c.id)::int as applications_count
           from candidates c where ${sql} order by c.full_name, c.id limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from candidates c where ${sql}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map(candidateView),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const c = await visibleCandidate(scope, s, id)
      if (!c) throw ApiError.notFound()
      const v = visibleClause(s, context.membershipId, 'r')
      const apps = v
        ? await scope.trx.rawQuery(
            `select a.id, a.stage, a.created_at, r.id as requisition_id, r.code, r.title
               from job_applications a join job_requisitions r on r.tenant_id = a.tenant_id and r.id = a.requisition_id
              where a.tenant_id = ? and a.candidate_id = ? and ${v.sql} order by a.created_at desc`,
            [context.tenantId, id, ...v.params] as never[]
          )
        : { rows: [] }
      return {
        ...candidateView(c),
        applications: (apps.rows as any[]).map((a) => ({
          id: a.id,
          stage: a.stage,
          createdAt: a.created_at,
          requisition: { id: a.requisition_id, code: a.code, title: a.title },
        })),
        access: { manage: hasAny(s.manage) },
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      if (!hasAny(s.manage)) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere recrutamento.')
      const { values: v, issues } = normalizeFields(input, CANDIDATE_FIELDS)
      if (!v.fullName) issues.push({ path: 'fullName', code: 'REQUIRED', message: 'Obrigatório.' })
      if (!v.email && !v.phone)
        issues.push({
          path: 'email',
          code: 'CONTACT_REQUIRED',
          message: 'Indique um email ou telefone.',
        })
      fail(issues)
      const keys = Object.keys(v)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into candidates (tenant_id, created_by, updated_by, ${keys.map((k) => CANDIDATE_COLUMNS[k]).join(', ')})
           values (?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
          [context.tenantId, context.userId, context.userId, ...keys.map((k) => v[k])] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        uniqueOr(error, CANDIDATE_UNIQUE)
      }
      // Dados de contacto do candidato são pessoais: a auditoria regista que existem, não os valores.
      await audit(scope, {
        action: 'hr.candidate.created',
        entityType: 'candidate',
        entityId: id,
        metadata: { fields: keys },
      })
      return candidateView(await visibleCandidate(scope, s, id))
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const c = await visibleCandidate(scope, s, id, true)
      if (!c) throw ApiError.notFound()
      if (!(await this.canManage(scope, s, c)))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode alterar este candidato.')
      expectVersion(c, expectedVersion)
      const { values: v, issues } = normalizeFields(input, CANDIDATE_FIELDS)
      if ('fullName' in v && !v.fullName)
        issues.push({ path: 'fullName', code: 'REQUIRED', message: 'Obrigatório.' })
      const email = 'email' in v ? v.email : c.email
      const phone = 'phone' in v ? v.phone : c.phone
      if (!email && !phone)
        issues.push({
          path: 'email',
          code: 'CONTACT_REQUIRED',
          message: 'Indique um email ou telefone.',
        })
      fail(issues)
      const changed = Object.keys(v).filter((k) => (c[CANDIDATE_COLUMNS[k]] ?? null) !== v[k])
      if (changed.length) {
        try {
          await scope.trx.rawQuery(
            `update candidates set ${changed.map((k) => `${CANDIDATE_COLUMNS[k]} = ?`).join(', ')},
               version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
            [...changed.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
          )
        } catch (error) {
          uniqueOr(error, CANDIDATE_UNIQUE)
        }
        await audit(scope, {
          action: 'hr.candidate.updated',
          entityType: 'candidate',
          entityId: id,
          metadata: { fields: changed },
        })
      }
      return candidateView(await visibleCandidate(scope, s, id))
    })
  }

  /** Quem registou o candidato, quem gere a empresa inteira ou quem gere uma vaga a que se candidatou. */
  private async canManage(scope: TenantScope, s: RecruitmentScopes, c: any) {
    if (s.manage.tenant || (c.created_by === scope.context.userId && hasAny(s.manage))) return true
    const m = scopeClause(noOwn(s.manage), scope.context.membershipId, 'r')
    if (!m) return false
    const r = await scope.trx.rawQuery(
      `select 1 from job_applications a join job_requisitions r on r.tenant_id = a.tenant_id and r.id = a.requisition_id
        where a.tenant_id = ? and a.candidate_id = ? and ${m.sql} limit 1`,
      [scope.context.tenantId, c.id, ...m.params] as never[]
    )
    return r.rows.length > 0
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Candidaturas, entrevistas e avaliações
// ---------------------------------------------------------------------------------------------------------------

const APP_SELECT = `select a.*, c.full_name as candidate_name, c.email as candidate_email, c.phone as candidate_phone,
    r.code as req_code, r.title as req_title, r.status as req_status, r.legal_entity_id, r.branch_id,
    r.department_id, r.position_id, r.currency, r.salary_min, r.salary_max, r.quantity,
    (select round(avg(score), 2)::text from job_evaluations ev where ev.tenant_id = a.tenant_id
      and ev.application_id = a.id) as avg_score,
    (select count(*) from job_evaluations ev where ev.tenant_id = a.tenant_id and ev.application_id = a.id)::int
      as evaluations_count
  from job_applications a
  join candidates c on c.tenant_id = a.tenant_id and c.id = a.candidate_id
  join job_requisitions r on r.tenant_id = a.tenant_id and r.id = a.requisition_id`

async function findApplication(scope: TenantScope, id: string, lock = false) {
  const r = await scope.trx.rawQuery(
    `${APP_SELECT} where a.tenant_id = ? and a.id = ?${lock ? ' for update of a' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

function applicationView(a: any) {
  return {
    id: a.id as string,
    version: Number(a.version),
    stage: a.stage as ApplicationStage,
    stageReason: (a.stage_reason as string) ?? null,
    employeeId: (a.employee_id as string) ?? null,
    candidate: {
      id: a.candidate_id as string,
      fullName: a.candidate_name as string,
      email: (a.candidate_email as string) ?? null,
      phone: (a.candidate_phone as string) ?? null,
    },
    requisition: {
      id: a.requisition_id as string,
      code: a.req_code as string,
      title: a.req_title as string,
      status: a.req_status as string,
      currency: a.currency as string,
      salaryMin: a.salary_min as string,
      salaryMax: a.salary_max as string,
    },
    averageScore: (a.avg_score as string) ?? null,
    evaluationsCount: Number(a.evaluations_count),
    createdAt: a.created_at,
  }
}

const APP_SORT = { createdAt: 'a.created_at', stage: 'a.stage', candidate: 'c.full_name' } as const
export const APPLICATION_SORT_FIELDS = Object.keys(APP_SORT) as (keyof typeof APP_SORT)[]

/** Candidatura visível ao actor (pela vaga) ou 404. */
async function visibleApplication(
  scope: TenantScope,
  s: RecruitmentScopes,
  id: string,
  lock = false
) {
  const a = await findApplication(scope, id, lock)
  if (!a || !canSee(s, a, scope.context.membershipId)) throw ApiError.notFound()
  return a
}

async function setStage(
  scope: TenantScope,
  a: any,
  stage: ApplicationStage,
  reason: string | null
) {
  await scope.trx.rawQuery(
    `update job_applications set stage = ?, stage_reason = ?, version = version + 1, updated_by = ?, updated_at = now()
      where tenant_id = ? and id = ?`,
    [stage, reason, scope.context.userId, scope.context.tenantId, a.id]
  )
  await audit(scope, {
    action: 'hr.application.stage_changed',
    entityType: 'job_application',
    entityId: a.id,
    changes: { stage: { from: a.stage, to: stage } },
    metadata: reason ? { reason } : null,
  })
}

const INTERVIEW_SELECT = `select i.*, u.full_name as interviewer_name,
    exists (select 1 from job_evaluations ev where ev.tenant_id = i.tenant_id and ev.interview_id = i.id
      and ev.evaluator_membership_id = i.interviewer_membership_id) as evaluated
  from job_interviews i
  join tenant_memberships m on m.tenant_id = i.tenant_id and m.id = i.interviewer_membership_id
  join users u on u.id = m.user_id`

function interviewView(i: any) {
  return {
    id: i.id as string,
    version: Number(i.version),
    applicationId: i.application_id as string,
    scheduledAt: i.scheduled_at,
    durationMinutes: Number(i.duration_minutes),
    mode: i.mode as string,
    location: (i.location as string) ?? null,
    interviewer: {
      membershipId: i.interviewer_membership_id as string,
      name: i.interviewer_name as string,
    },
    status: i.status as string,
    evaluated: Boolean(i.evaluated),
  }
}

export interface ApplicationFilter {
  requisitionId?: string
  candidateId?: string
  stage?: string
  q?: string
  sort?: { field: keyof typeof APP_SORT; direction: 'asc' | 'desc' }
  limit: number
  offset: number
}

export class ApplicationService {
  list(context: TenantContext, f: ApplicationFilter) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const visible = visibleClause(s, context.membershipId, 'r')
      if (!visible) return { items: [], total: 0 }
      const where = ['a.tenant_id = ?', visible.sql]
      const params: unknown[] = [context.tenantId, ...visible.params]
      for (const [key, column] of [
        ['requisitionId', 'a.requisition_id'],
        ['candidateId', 'a.candidate_id'],
        ['stage', 'a.stage'],
      ] as const)
        if (f[key]) {
          where.push(`${column} = ?`)
          params.push(f[key])
        }
      if (f.q) {
        where.push(`(lower(c.full_name) like ? or lower(r.code) like ? or lower(r.title) like ?)`)
        params.push(like(f.q), like(f.q), like(f.q))
      }
      const clause = where.join(' and ')
      const order = f.sort
        ? `${APP_SORT[f.sort.field]} ${f.sort.direction === 'desc' ? 'desc' : 'asc'}, a.id`
        : 'a.created_at desc, a.id'
      const rows = await scope.trx.rawQuery(
        `${APP_SELECT} where ${clause} order by ${order} limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from job_applications a
           join candidates c on c.tenant_id = a.tenant_id and c.id = a.candidate_id
           join job_requisitions r on r.tenant_id = a.tenant_id and r.id = a.requisition_id where ${clause}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map(applicationView),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const a = await visibleApplication(scope, s, id)
      const me = context.membershipId
      const interviews = await scope.trx.rawQuery(
        `${INTERVIEW_SELECT} where i.tenant_id = ? and i.application_id = ? order by i.scheduled_at`,
        [context.tenantId, id]
      )
      const evaluations = await scope.trx.rawQuery(
        `select ev.*, u.full_name as evaluator_name from job_evaluations ev
           join tenant_memberships m on m.tenant_id = ev.tenant_id and m.id = ev.evaluator_membership_id
           join users u on u.id = m.user_id
          where ev.tenant_id = ? and ev.application_id = ? order by ev.created_at`,
        [context.tenantId, id]
      )
      const offers = await scope.trx.rawQuery(
        `${OFFER_SELECT} where o.tenant_id = ? and o.application_id = ? order by o.created_at desc`,
        [context.tenantId, id]
      )
      const settings = await hrSettings(scope)
      return {
        ...applicationView(a),
        interviews: (interviews.rows as any[]).map(interviewView),
        evaluations: (evaluations.rows as any[]).map((e) => ({
          id: e.id,
          interviewId: e.interview_id ?? null,
          evaluator: { membershipId: e.evaluator_membership_id, name: e.evaluator_name },
          score: Number(e.score),
          recommendation: e.recommendation,
          comments: e.comments ?? null,
          createdAt: e.created_at,
        })),
        offers: (offers.rows as any[]).map((o) => ({
          ...offerView(o),
          canApprove: coversReq(s.approve, a, me) && o.created_by !== context.userId,
        })),
        offerApprovalMode: settings.offerWorkflowId ? 'WORKFLOW' : 'DIRECT',
        access: { manage: coversReq(s.manage, a, me), approve: coversReq(s.approve, a, me) },
      }
    })
  }

  create(context: TenantContext, input: { requisitionId: string; candidateId: string }) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const r = await findRequisition(scope, input.requisitionId, true)
      if (!r || !canSee(s, r, context.membershipId))
        fail([{ path: 'requisitionId', code: 'NOT_FOUND', message: 'Vaga inexistente.' }])
      assertManage(s, r, context.membershipId)
      if (r.status !== 'OPEN')
        throw ApiError.conflict('REQUISITION_NOT_OPEN', 'A vaga não está aberta a candidaturas.')
      if (!(await visibleCandidate(scope, s, input.candidateId)))
        fail([{ path: 'candidateId', code: 'NOT_FOUND', message: 'Candidato inexistente.' }])
      let id: string
      try {
        const res = await scope.trx.rawQuery(
          `insert into job_applications (tenant_id, requisition_id, candidate_id, created_by, updated_by)
           values (?, ?, ?, ?, ?) returning id`,
          [context.tenantId, input.requisitionId, input.candidateId, context.userId, context.userId]
        )
        id = (res.rows[0] as { id: string }).id
      } catch (error) {
        uniqueOr(error, {
          job_applications_unique: [
            'candidateId',
            'ALREADY_APPLIED',
            'Este candidato já se candidatou a esta vaga.',
          ],
        })
      }
      await audit(scope, {
        action: 'hr.application.created',
        entityType: 'job_application',
        entityId: id,
        metadata: { requisitionId: input.requisitionId, candidateId: input.candidateId },
      })
      return applicationView(await findApplication(scope, id))
    })
  }

  /** Mudar de etapa à mão; recusar ou desistir cancela a proposta em curso e as entrevistas marcadas. */
  changeStage(
    context: TenantContext,
    id: string,
    stage: ApplicationStage,
    reason: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const a = await visibleApplication(scope, s, id, true)
      assertManage(s, a, context.membershipId)
      expectVersion(a, expectedVersion)
      if (!STAGE_TRANSITIONS[a.stage as ApplicationStage].includes(stage))
        fail([
          {
            path: 'stage',
            code: 'INVALID_TRANSITION',
            message: `Não é possível passar de ${a.stage} a ${stage}.`,
          },
        ])
      if (stage === 'REJECTED' && !reason)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      if (CLOSED_STAGES.includes(stage)) {
        const cancelled = await scope.trx.rawQuery(
          `update job_offers set status = 'CANCELLED', version = version + 1, updated_by = ?, updated_at = now()
            where tenant_id = ? and application_id = ?
              and status in ('DRAFT','PENDING_APPROVAL','APPROVED','ACCEPTED') returning id, status`,
          [context.userId, context.tenantId, id]
        )
        for (const o of cancelled.rows as any[])
          await audit(scope, {
            action: 'hr.offer.cancelled',
            entityType: 'job_offer',
            entityId: o.id,
            metadata: { reason: `Candidatura ${stage === 'REJECTED' ? 'recusada' : 'retirada'}.` },
          })
        await scope.trx.rawQuery(
          `update job_interviews set status = 'CANCELLED', version = version + 1, updated_by = ?, updated_at = now()
            where tenant_id = ? and application_id = ? and status = 'SCHEDULED'`,
          [context.userId, context.tenantId, id]
        )
      }
      await setStage(scope, a, stage, reason)
      return applicationView(await findApplication(scope, id))
    })
  }

  scheduleInterview(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const a = await visibleApplication(scope, s, id, true)
      assertManage(s, a, context.membershipId)
      if (!['APPLIED', 'SCREENING', 'INTERVIEW'].includes(a.stage))
        wrongState('Só se marcam entrevistas a candidaturas em triagem ou entrevista.')
      const { values: v, issues } = normalizeFields(input, INTERVIEW_FIELDS)
      const at = parseInstant(v.scheduledAt)
      if (!at)
        issues.push({
          path: 'scheduledAt',
          code: 'INVALID_DATE',
          message: 'Data e hora inválidas.',
        })
      if (!INTERVIEW_MODES.includes(input.mode as never))
        issues.push({ path: 'mode', code: 'INVALID', message: 'Presencial, vídeo ou telefone.' })
      if (!v.interviewerMembershipId)
        issues.push({ path: 'interviewerMembershipId', code: 'REQUIRED', message: 'Obrigatório.' })
      else if (!(await memberActive(scope, v.interviewerMembershipId as string)))
        issues.push({
          path: 'interviewerMembershipId',
          code: 'NOT_FOUND',
          message: 'Membro inexistente ou inactivo.',
        })
      fail(issues)
      const res = await scope.trx.rawQuery(
        `insert into job_interviews (tenant_id, application_id, scheduled_at, duration_minutes, mode, location,
           interviewer_membership_id, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          id,
          at!.toISOString(),
          (v.durationMinutes as number) ?? 60,
          input.mode as string,
          (v.location as string) ?? null,
          v.interviewerMembershipId as string,
          context.userId,
          context.userId,
        ]
      )
      const interviewId = (res.rows[0] as { id: string }).id
      await audit(scope, {
        action: 'hr.interview.scheduled',
        entityType: 'job_interview',
        entityId: interviewId,
        metadata: { applicationId: id, scheduledAt: at!.toISOString() },
      })
      if (a.stage !== 'INTERVIEW') await setStage(scope, a, 'INTERVIEW', null)
      return this.interview(scope, interviewId)
    })
  }

  /** Remarcar ou concluir/cancelar. O entrevistador pode marcar a sua entrevista como realizada. */
  updateInterview(
    context: TenantContext,
    interviewId: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const r = await scope.trx.rawQuery(
        `select * from job_interviews where tenant_id = ? and id = ? for update`,
        [context.tenantId, interviewId]
      )
      const i = r.rows[0] as any
      if (!i) throw ApiError.notFound()
      const a = await findApplication(scope, i.application_id)
      const me = context.membershipId
      const isInterviewer = i.interviewer_membership_id === me
      if (!canSee(s, a, me) && !isInterviewer) throw ApiError.notFound()
      const manager = coversReq(s.manage, a, me)
      const onlyDone = Object.keys(input).every((k) => k === 'status') && input.status === 'DONE'
      if (!manager && !(isInterviewer && onlyDone))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode alterar esta entrevista.')
      expectVersion(i, expectedVersion)
      if (i.status !== 'SCHEDULED') wrongState('A entrevista já foi realizada ou cancelada.')
      const { values: v, issues } = normalizeFields(input, INTERVIEW_FIELDS)
      const sets: string[] = []
      const params: unknown[] = []
      if ('scheduledAt' in v) {
        const at = parseInstant(v.scheduledAt)
        if (!at)
          issues.push({
            path: 'scheduledAt',
            code: 'INVALID_DATE',
            message: 'Data e hora inválidas.',
          })
        else {
          sets.push('scheduled_at = ?')
          params.push(at.toISOString())
        }
      }
      if ('durationMinutes' in v && v.durationMinutes) {
        sets.push('duration_minutes = ?')
        params.push(v.durationMinutes)
      }
      if ('location' in v) {
        sets.push('location = ?')
        params.push(v.location)
      }
      if ('mode' in input) {
        if (!INTERVIEW_MODES.includes(input.mode as never))
          issues.push({ path: 'mode', code: 'INVALID', message: 'Presencial, vídeo ou telefone.' })
        else {
          sets.push('mode = ?')
          params.push(input.mode)
        }
      }
      if (v.interviewerMembershipId) {
        if (!(await memberActive(scope, v.interviewerMembershipId as string)))
          issues.push({
            path: 'interviewerMembershipId',
            code: 'NOT_FOUND',
            message: 'Membro inexistente ou inactivo.',
          })
        sets.push('interviewer_membership_id = ?')
        params.push(v.interviewerMembershipId)
      }
      if ('status' in input) {
        if (!['DONE', 'CANCELLED'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'Realizada ou cancelada.' })
        sets.push('status = ?')
        params.push(input.status)
      }
      fail(issues)
      if (sets.length) {
        await scope.trx.rawQuery(
          `update job_interviews set ${sets.join(', ')}, version = version + 1, updated_by = ?, updated_at = now()
            where tenant_id = ? and id = ?`,
          [...params, context.userId, context.tenantId, interviewId] as never[]
        )
        await audit(scope, {
          action: 'hr.interview.updated',
          entityType: 'job_interview',
          entityId: interviewId,
          metadata: { fields: Object.keys(input) },
        })
      }
      return this.interview(scope, interviewId)
    })
  }

  /** Entrevistas atribuídas ao actor (o entrevistador vê só as suas, mesmo sem acesso ao recrutamento). */
  myInterviews(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `${INTERVIEW_SELECT.replace(
          'from job_interviews i',
          `, c.full_name as candidate_name, rq.code as req_code, rq.title as req_title
           from job_interviews i
           join job_applications a on a.tenant_id = i.tenant_id and a.id = i.application_id
           join candidates c on c.tenant_id = a.tenant_id and c.id = a.candidate_id
           join job_requisitions rq on rq.tenant_id = a.tenant_id and rq.id = a.requisition_id`
        )} where i.tenant_id = ? and i.interviewer_membership_id = ? and i.status <> 'CANCELLED'
           order by i.scheduled_at desc limit 100`,
        [context.tenantId, context.membershipId]
      )
      return (r.rows as any[]).map((i) => ({
        ...interviewView(i),
        candidateName: i.candidate_name as string,
        requisition: { code: i.req_code as string, title: i.req_title as string },
      }))
    })
  }

  /**
   * Avaliação (só de acréscimo): de uma entrevista realizada, pelo entrevistador ou por quem gere a vaga; ou geral,
   * por quem gere a vaga.
   */
  evaluate(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const me = context.membershipId
      const a = await findApplication(scope, id)
      if (!a) throw ApiError.notFound()
      let interview: any = null
      if (input.interviewId) {
        const r = await scope.trx.rawQuery(
          `select * from job_interviews where tenant_id = ? and id = ? and application_id = ?`,
          [context.tenantId, input.interviewId as string, id]
        )
        interview = r.rows[0] ?? null
        if (!interview)
          fail([{ path: 'interviewId', code: 'NOT_FOUND', message: 'Entrevista inexistente.' }])
      }
      const isInterviewer = interview?.interviewer_membership_id === me
      if (!canSee(s, a, me) && !isInterviewer) throw ApiError.notFound()
      if (!coversReq(s.manage, a, me) && !isInterviewer)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode avaliar esta candidatura.')
      if (CLOSED_STAGES.includes(a.stage)) wrongState('A candidatura já está encerrada.')
      if (interview && interview.status !== 'DONE')
        wrongState('A entrevista ainda não foi realizada.')
      const issues: ErrorDetail[] = []
      const score = input.score
      if (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5)
        issues.push({ path: 'score', code: 'INVALID', message: 'Classificação de 1 a 5.' })
      if (!['HIRE', 'HOLD', 'REJECT'].includes(input.recommendation as string))
        issues.push({
          path: 'recommendation',
          code: 'INVALID',
          message: 'Contratar, aguardar ou recusar.',
        })
      const comments = typeof input.comments === 'string' ? input.comments.trim() || null : null
      if (comments && comments.length > 4000)
        issues.push({ path: 'comments', code: 'LENGTH', message: 'Até 4000 caracteres.' })
      fail(issues)
      let evaluationId: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into job_evaluations (tenant_id, application_id, interview_id, evaluator_membership_id, score,
             recommendation, comments, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            id,
            interview?.id ?? null,
            me,
            score as number,
            input.recommendation as string,
            comments,
            context.userId,
            context.userId,
          ]
        )
        evaluationId = (r.rows[0] as { id: string }).id
      } catch (error) {
        uniqueOr(error, {
          job_evaluations_interview_unique: [
            'interviewId',
            'ALREADY_EVALUATED',
            'Já avaliou esta entrevista.',
          ],
        })
      }
      await audit(scope, {
        action: 'hr.evaluation.created',
        entityType: 'job_evaluation',
        entityId: evaluationId,
        metadata: {
          applicationId: id,
          interviewId: interview?.id ?? null,
          score,
          recommendation: input.recommendation,
        },
      })
      return { id: evaluationId }
    })
  }

  private async interview(scope: TenantScope, id: string) {
    const r = await scope.trx.rawQuery(`${INTERVIEW_SELECT} where i.tenant_id = ? and i.id = ?`, [
      scope.context.tenantId,
      id,
    ])
    return interviewView(r.rows[0])
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Propostas e contratação
// ---------------------------------------------------------------------------------------------------------------

const OFFER_SELECT = `select o.*, o.start_date::text as start_date_text, o.expires_on::text as expires_on_text
  from job_offers o`

function offerView(o: any) {
  return {
    id: o.id as string,
    version: Number(o.version),
    applicationId: o.application_id as string,
    currency: o.currency as string,
    salary: o.salary as string,
    startDate: o.start_date_text as string,
    expiresOn: (o.expires_on_text as string) ?? null,
    conditions: (o.conditions as string) ?? null,
    status: o.status as string,
    approvalRequestId: (o.approval_request_id as string) ?? null,
    approvedAt: o.approved_at ?? null,
    rejectionReason: (o.rejection_reason as string) ?? null,
    respondedAt: o.responded_at ?? null,
    employeeId: (o.employee_id as string) ?? null,
    createdAt: o.created_at,
  }
}

/** Proposta e candidatura (com a vaga), visíveis ao actor, com bloqueio da proposta. */
async function visibleOffer(scope: TenantScope, s: RecruitmentScopes, id: string) {
  const r = await scope.trx.rawQuery(
    `${OFFER_SELECT} where o.tenant_id = ? and o.id = ? for update`,
    [scope.context.tenantId, id]
  )
  const o = r.rows[0] as any
  if (!o) throw ApiError.notFound()
  const a = await visibleApplication(scope, s, o.application_id)
  return { o, a }
}

function offerIssues(v: Record<string, unknown>, a: any): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  if (typeof v.salary === 'string' && !withinRange(v.salary, a.salary_min, a.salary_max))
    issues.push({
      path: 'salary',
      code: 'OUT_OF_RANGE',
      message: `Fora da remuneração autorizada da vaga (${a.currency} ${a.salary_min} a ${a.salary_max}).`,
    })
  if (typeof v.startDate === 'string' && v.startDate < today())
    issues.push({
      path: 'startDate',
      code: 'PAST_DATE',
      message: 'O início não pode ser no passado.',
    })
  if (typeof v.expiresOn === 'string' && v.expiresOn < today())
    issues.push({ path: 'expiresOn', code: 'PAST_DATE', message: 'A validade já passou.' })
  return issues
}

async function setOfferStatus(
  scope: TenantScope,
  o: any,
  to: string,
  extra: Record<string, unknown> = {},
  metadata: Record<string, unknown> | null = null
) {
  const cols = Object.keys(extra)
  await scope.trx.rawQuery(
    `update job_offers set status = ?${cols.map((c) => `, ${c} = ?`).join('')}, version = version + 1,
       updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
    [
      to,
      ...cols.map((c) => extra[c]),
      scope.context.userId,
      scope.context.tenantId,
      o.id,
    ] as never[]
  )
  await audit(scope, {
    action: `hr.offer.${to.toLowerCase()}`,
    entityType: 'job_offer',
    entityId: o.id,
    changes: { status: { from: o.status, to } },
    metadata,
  })
}

async function readOffer(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(`${OFFER_SELECT} where o.tenant_id = ? and o.id = ?`, [
    scope.context.tenantId,
    id,
  ])
  return offerView(r.rows[0])
}

const OFFER_ACTIVE_UNIQUE: Record<string, [string, string, string]> = {
  job_offers_active_unique: [
    'applicationId',
    'OFFER_IN_PROGRESS',
    'Já há uma proposta em curso nesta candidatura.',
  ],
}

export class OfferService {
  create(context: TenantContext, applicationId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const a = await visibleApplication(scope, s, applicationId, true)
      assertManage(s, a, context.membershipId)
      if (!['SCREENING', 'INTERVIEW', 'OFFER'].includes(a.stage))
        wrongState('Só há proposta para candidaturas em triagem, entrevista ou proposta.')
      if (a.req_status !== 'OPEN')
        throw ApiError.conflict('REQUISITION_NOT_OPEN', 'A vaga não está aberta.')
      const { values: v, issues } = normalizeFields(input, OFFER_FIELDS)
      for (const key of ['salary', 'startDate'])
        if (!v[key]) issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...offerIssues(v, a))
      fail(issues)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into job_offers (tenant_id, application_id, currency, salary, start_date, expires_on, conditions,
             created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            applicationId,
            a.currency,
            v.salary as string,
            v.startDate as string,
            (v.expiresOn as string) ?? null,
            (v.conditions as string) ?? null,
            context.userId,
            context.userId,
          ]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        uniqueOr(error, OFFER_ACTIVE_UNIQUE)
      }
      await audit(scope, {
        action: 'hr.offer.created',
        entityType: 'job_offer',
        entityId: id,
        changes: {
          salary: { from: null, to: v.salary },
          startDate: { from: null, to: v.startDate },
        },
        metadata: { applicationId, currency: a.currency },
      })
      if (a.stage !== 'OFFER') await setStage(scope, a, 'OFFER', null)
      return readOffer(scope, id)
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const { o, a } = await visibleOffer(scope, s, id)
      assertManage(s, a, context.membershipId)
      expectVersion(o, expectedVersion)
      if (o.status !== 'DRAFT') wrongState('Só uma proposta em rascunho se altera.')
      const { values: v, issues } = normalizeFields(input, OFFER_FIELDS)
      for (const key of ['salary', 'startDate'])
        if (key in v && !v[key])
          issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      issues.push(...offerIssues(v, a))
      fail(issues)
      const columns: Record<string, string> = {
        salary: 'salary',
        startDate: 'start_date',
        expiresOn: 'expires_on',
        conditions: 'conditions',
      }
      const keys = Object.keys(v)
      if (keys.length) {
        await scope.trx.rawQuery(
          `update job_offers set ${keys.map((k) => `${columns[k]} = ?`).join(', ')}, version = version + 1,
             updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [...keys.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
        )
        const before = offerView(o) as Record<string, unknown>
        await audit(scope, {
          action: 'hr.offer.updated',
          entityType: 'job_offer',
          entityId: id,
          changes: Object.fromEntries(keys.map((k) => [k, { from: before[k] ?? null, to: v[k] }])),
        })
      }
      return readOffer(scope, id)
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const { o, a } = await visibleOffer(scope, s, id)
      assertManage(s, a, context.membershipId)
      expectVersion(o, expectedVersion)
      if (o.status !== 'DRAFT') wrongState('Só uma proposta em rascunho se submete.')
      if (a.req_status !== 'OPEN')
        throw ApiError.conflict('REQUISITION_NOT_OPEN', 'A vaga não está aberta.')
      // A remuneração autorizada pode ter mudado? Não (a vaga aberta não se altera), mas a data pode ter passado.
      fail(
        offerIssues(
          { salary: o.salary, startDate: o.start_date_text, expiresOn: o.expires_on_text },
          a
        )
      )
      const settings = await hrSettings(scope)
      let requestId: string | null = null
      if (settings.offerWorkflowId)
        requestId = await submitForSubject(scope, {
          workflowId: settings.offerWorkflowId,
          subjectType: 'job_offer',
          subjectId: id,
          title: `Proposta: ${a.candidate_name} (${a.req_code})`,
          description: `${a.req_title} · ${o.currency} ${o.salary} · início ${o.start_date_text}`,
        })
      await setOfferStatus(
        scope,
        o,
        'PENDING_APPROVAL',
        { approval_request_id: requestId, rejection_reason: null },
        requestId ? { approvalRequestId: requestId } : { mode: 'DIRECT' }
      )
      return readOffer(scope, id)
    })
  }

  decide(
    context: TenantContext,
    id: string,
    decision: 'APPROVE' | 'REJECT',
    reason: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const { o, a } = await visibleOffer(scope, s, id)
      if (!coversReq(s.approve, a, context.membershipId))
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Não aprova propostas nesta entidade, filial ou departamento.'
        )
      expectVersion(o, expectedVersion)
      if (o.status !== 'PENDING_APPROVAL') wrongState('A proposta não aguarda aprovação.')
      if (o.approval_request_id)
        throw ApiError.conflict(
          'USE_APPROVAL_WORKFLOW',
          'Esta proposta é decidida no workflow de aprovação.'
        )
      if (o.created_by === context.userId)
        throw ApiError.forbidden('SEGREGATION', 'Quem prepara a proposta não a pode aprovar.')
      if (decision === 'REJECT' && !reason)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo da recusa.' }])
      await applyOfferDecision(scope, o, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason)
      return readOffer(scope, id)
    })
  }

  /** Resposta do candidato (registada por quem gere a vaga). */
  respond(context: TenantContext, id: string, accepted: boolean, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const { o, a } = await visibleOffer(scope, s, id)
      assertManage(s, a, context.membershipId)
      expectVersion(o, expectedVersion)
      if (o.status !== 'APPROVED') wrongState('Só uma proposta aprovada recebe resposta.')
      if (accepted && o.expires_on_text && o.expires_on_text < today())
        throw ApiError.conflict('OFFER_EXPIRED', 'A proposta expirou; prepare uma nova.')
      await setOfferStatus(scope, o, accepted ? 'ACCEPTED' : 'DECLINED', {
        responded_at: new Date().toISOString(),
      })
      return readOffer(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, reason: string | null, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const { o, a } = await visibleOffer(scope, s, id)
      assertManage(s, a, context.membershipId)
      expectVersion(o, expectedVersion)
      if (!['DRAFT', 'APPROVED', 'ACCEPTED'].includes(o.status))
        wrongState('Esta proposta já não se cancela.')
      await setOfferStatus(scope, o, 'CANCELLED', {}, reason ? { reason } : null)
      return readOffer(scope, id)
    })
  }

  /**
   * Contratação: converte a proposta aceite em colaborador (com a colocação da vaga e o nome do candidato) e cria a
   * checklist de onboarding, tudo na mesma transacção. A vaga fica bloqueada para não passar a quantidade autorizada
   * (duas contratações concorrentes da última vaga: uma falha). Repetir dá 409 (a proposta já está `HIRED`).
   */
  hire(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await rScopes(scope)
      const { o, a } = await visibleOffer(scope, s, id)
      assertManage(s, a, context.membershipId)
      expectVersion(o, expectedVersion)
      if (o.status !== 'ACCEPTED') wrongState('Só uma proposta aceite se converte em colaborador.')
      const r = await findRequisition(scope, a.requisition_id, true)
      if (r.status !== 'OPEN')
        throw ApiError.conflict('REQUISITION_NOT_OPEN', 'A vaga não está aberta.')
      if (Number(r.hired_count) >= Number(r.quantity))
        throw ApiError.conflict(
          'REQUISITION_FILLED',
          'Todos os postos da vaga já foram preenchidos.'
        )
      const checklist = Array.isArray(input.checklist) ? (input.checklist as any[]) : []
      const issues: ErrorDetail[] = []
      checklist.forEach((item, i) => {
        if (!ONBOARDING_CATEGORIES.includes(item?.category))
          issues.push({
            path: `checklist.${i}.category`,
            code: 'INVALID',
            message: 'Categoria inválida.',
          })
        const title = typeof item?.title === 'string' ? item.title.trim() : ''
        if (title.length < 2 || title.length > 160)
          issues.push({
            path: `checklist.${i}.title`,
            code: 'LENGTH',
            message: 'Tarefa com 2 a 160 caracteres.',
          })
      })
      if (checklist.length > 50)
        issues.push({ path: 'checklist', code: 'TOO_MANY', message: 'No máximo 50 tarefas.' })
      fail(issues)
      // Os contactos do candidato passam a dados pessoais da ficha só se o actor os pode escrever.
      const sensitive = await permissionScope(scope, 'hr.sensitive')
      const personal = covers(noOwn(sensitive), placeOf(a), context.membershipId)
      const employee = await new EmployeeService().createIn(scope, {
        code: input.code,
        fullName: a.candidate_name,
        workEmail: input.workEmail ?? null,
        hireDate: input.hireDate ?? o.start_date_text,
        legalEntityId: a.legal_entity_id,
        branchId: a.branch_id,
        departmentId: a.department_id,
        positionId: a.position_id,
        managerId: input.managerId ?? null,
        ...(personal ? { personalEmail: a.candidate_email, personalPhone: a.candidate_phone } : {}),
      })
      await setOfferStatus(scope, o, 'HIRED', { employee_id: employee.id })
      await scope.trx.rawQuery(
        `update job_applications set stage = 'HIRED', employee_id = ?, version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [employee.id, context.userId, context.tenantId, a.id]
      )
      await audit(scope, {
        action: 'hr.application.hired',
        entityType: 'job_application',
        entityId: a.id,
        changes: { stage: { from: a.stage, to: 'HIRED' } },
        metadata: { employeeId: employee.id, offerId: o.id },
      })
      for (const item of checklist)
        await insertOnboardingTask(scope, employee.id as string, {
          category: item.category,
          title: String(item.title).trim(),
          dueDate: item.dueDate ?? null,
          assigneeMembershipId: item.assigneeMembershipId ?? null,
        })
      if (Number(r.hired_count) + 1 >= Number(r.quantity)) {
        await scope.trx.rawQuery(
          `update job_requisitions set status = 'FILLED', version = version + 1, updated_by = ?, updated_at = now()
            where tenant_id = ? and id = ?`,
          [context.userId, context.tenantId, r.id]
        )
        await audit(scope, {
          action: 'hr.requisition.filled',
          entityType: 'job_requisition',
          entityId: r.id,
          changes: { status: { from: 'OPEN', to: 'FILLED' } },
        })
      }
      return { offer: await readOffer(scope, id), employeeId: employee.id }
    })
  }
}

async function applyOfferDecision(
  scope: TenantScope,
  o: any,
  outcome: ApprovalOutcome,
  reason: string | null
) {
  const approved = outcome === 'APPROVED'
  await setOfferStatus(
    scope,
    o,
    approved ? 'APPROVED' : 'DRAFT',
    approved
      ? { approved_by: scope.context.userId, approved_at: new Date().toISOString() }
      : { rejection_reason: reason, approval_request_id: null },
    reason ? { reason } : null
  )
}

/** Efeito da conclusão do workflow de uma proposta (registado em `start/module_hooks.ts`). */
export async function onOfferDecided(scope: TenantScope, id: string, outcome: ApprovalOutcome) {
  const r = await scope.trx.rawQuery(
    `${OFFER_SELECT} where o.tenant_id = ? and o.id = ? for update`,
    [scope.context.tenantId, id]
  )
  const o = r.rows[0] as any
  if (!o || o.status !== 'PENDING_APPROVAL') return
  await applyOfferDecision(
    scope,
    o,
    outcome,
    outcome === 'APPROVED'
      ? null
      : outcome === 'REJECTED'
        ? 'Recusada no workflow de aprovação.'
        : 'Pedido de aprovação cancelado.'
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Onboarding (checklist do colaborador)
// ---------------------------------------------------------------------------------------------------------------

export async function insertOnboardingTask(
  scope: TenantScope,
  employeeId: string,
  input: Record<string, unknown>
) {
  const issues: ErrorDetail[] = []
  if (!ONBOARDING_CATEGORIES.includes(input.category as never))
    issues.push({ path: 'category', code: 'INVALID', message: 'Categoria inválida.' })
  const { values: v, issues: more } = normalizeFields(input, ONBOARDING_FIELDS)
  issues.push(...more)
  if (!v.title) issues.push({ path: 'title', code: 'REQUIRED', message: 'Obrigatório.' })
  if (v.assigneeMembershipId && !(await memberActive(scope, v.assigneeMembershipId as string)))
    issues.push({
      path: 'assigneeMembershipId',
      code: 'NOT_FOUND',
      message: 'Membro inexistente ou inactivo.',
    })
  fail(issues)
  const r = await scope.trx.rawQuery(
    `insert into onboarding_tasks (tenant_id, employee_id, category, title, due_date, assignee_membership_id, notes,
       created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    [
      scope.context.tenantId,
      employeeId,
      input.category as string,
      v.title as string,
      (v.dueDate as string) ?? null,
      (v.assigneeMembershipId as string) ?? null,
      (v.notes as string) ?? null,
      scope.context.userId,
      scope.context.userId,
    ]
  )
  const id = (r.rows[0] as { id: string }).id
  await audit(scope, {
    action: 'hr.onboarding.task_created',
    entityType: 'onboarding_task',
    entityId: id,
    metadata: { employeeId, category: input.category, title: v.title },
  })
  return id
}
