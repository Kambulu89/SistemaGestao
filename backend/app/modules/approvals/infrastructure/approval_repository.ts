import { ApiError } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import type { TenantScope } from '#modules/tenancy/index'
import type {
  ApproverType,
  Decision,
  RequestStatus,
  StepValues,
  SubjectType,
  WorkflowStatus,
  WorkflowValues,
} from '#modules/approvals/domain/approvals'

export interface Workflow extends WorkflowValues {
  id: string
  status: WorkflowStatus
  publishedAt: string | null
  version: number
}

export interface Person {
  membershipId: string
  fullName: string | null
  email: string
}

export interface DecisionView {
  stepSequence: number
  decision: Decision
  comment: string | null
  decidedBy: Person
  onBehalfOf: Person | null
  decidedAt: string
}

export interface ApprovalRequest {
  id: string
  workflow: { id: string; code: string; name: string }
  subjectType: SubjectType
  subjectId: string | null
  title: string
  description: string | null
  status: RequestStatus
  currentStep: number | null
  requestedBy: Person
  createdAt: string
  completedAt: string | null
  version: number
}

/** Uma tarefa de aprovação: o membro pode decidir já esta etapa (por si ou por quem lhe delegou). */
export interface PendingSlot {
  requestId: string
  title: string
  subjectType: string
  subjectId: string | null
  workflowId: string
  stepSequence: number
  stepName: string
  requestedByMembershipId: string
  createdAt: string
  onBehalfOf: string | null
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)

const WORKFLOW_SELECT = `
  select w.id, w.code, w.name, w.description, w.subject_type, w.status, w.published_at, w.version,
         coalesce(json_agg(json_build_object(
           'sequence', s.sequence, 'name', s.name, 'approverType', s.approver_type,
           'approverRoleId', s.approver_role_id, 'approverMembershipId', s.approver_membership_id,
           'requiredApprovals', s.required_approvals) order by s.sequence)
           filter (where s.id is not null), '[]') as steps
    from approval_workflows w
    left join approval_workflow_steps s on s.tenant_id = w.tenant_id and s.workflow_id = w.id`

const toWorkflow = (r: any): Workflow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  subjectType: r.subject_type,
  status: r.status,
  publishedAt: iso(r.published_at),
  version: r.version,
  steps: r.steps,
})

const REQUEST_SELECT = `
  select r.id, r.subject_type, r.subject_id, r.title, r.description, r.status, r.current_step, r.created_at,
         r.completed_at, r.version, r.requested_by_membership_id,
         w.id as workflow_id, w.code as workflow_code, w.name as workflow_name,
         u.full_name as requester_name, u.email as requester_email
    from approval_requests r
    join approval_workflows w on w.tenant_id = r.tenant_id and w.id = r.workflow_id
    join tenant_memberships m on m.tenant_id = r.tenant_id and m.id = r.requested_by_membership_id
    join users u on u.id = m.user_id`

const toRequest = (r: any): ApprovalRequest => ({
  id: r.id,
  workflow: { id: r.workflow_id, code: r.workflow_code, name: r.workflow_name },
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  title: r.title,
  description: r.description,
  status: r.status,
  currentStep: r.current_step,
  requestedBy: {
    membershipId: r.requested_by_membership_id,
    fullName: r.requester_name,
    email: r.requester_email,
  },
  createdAt: iso(r.created_at)!,
  completedAt: iso(r.completed_at),
  version: r.version,
})

/**
 * Aprovadores elegíveis **directos** de uma etapa: membros activos indicados na etapa ou com o perfil (activo) da etapa,
 * em qualquer âmbito. `slot` é a pessoa cujo voto se conta; numa delegação o slot é quem delegou.
 */
const DIRECTLY_ELIGIBLE = `
  ((st.approver_type = 'MEMBER' and st.approver_membership_id = sl.slot)
   or (st.approver_type = 'ROLE' and exists (
        select 1 from membership_roles mr
          join roles ro on ro.tenant_id = mr.tenant_id and ro.id = mr.role_id and ro.status = 'ACTIVE'
         where mr.tenant_id = st.tenant_id and mr.membership_id = sl.slot and mr.role_id = st.approver_role_id)))`

export class ApprovalRepository {
  // ---------- workflows ----------
  async listWorkflows({ trx, context }: TenantScope, status?: WorkflowStatus) {
    const result = await trx.rawQuery(
      `${WORKFLOW_SELECT} where w.tenant_id = ?${status ? ' and w.status = ?' : ''} group by w.id order by w.code`,
      (status ? [context.tenantId, status] : [context.tenantId]) as never[]
    )
    return (result.rows as any[]).map(toWorkflow)
  }

  async findWorkflow({ trx, context }: TenantScope, id: string, lock = false) {
    if (lock)
      await trx.rawQuery(
        'select id from approval_workflows where tenant_id = ? and id = ? for update',
        [context.tenantId, id]
      )
    const result = await trx.rawQuery(
      `${WORKFLOW_SELECT} where w.tenant_id = ? and w.id = ? group by w.id`,
      [context.tenantId, id]
    )
    return result.rows[0] ? toWorkflow(result.rows[0]) : null
  }

  async insertWorkflow(scope: TenantScope, values: WorkflowValues): Promise<string> {
    const { trx, context } = scope
    await trx.rawQuery('savepoint wf_insert')
    try {
      const result = await trx.rawQuery(
        `insert into approval_workflows (tenant_id, created_by, updated_by, code, name, description, subject_type)
         values (?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          values.code,
          values.name,
          values.description,
          values.subjectType,
        ] as never[]
      )
      await trx.rawQuery('release savepoint wf_insert')
      const id = (result.rows[0] as { id: string }).id
      await this.replaceSteps(scope, id, values.steps)
      return id
    } catch (error) {
      if (constraintOf(error) === 'approval_workflows_code_unique') {
        await trx.rawQuery('rollback to savepoint wf_insert')
        throw ApiError.conflict('WORKFLOW_CODE_TAKEN', 'Já existe um workflow com este código.')
      }
      throw error
    }
  }

  async updateWorkflow(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: WorkflowValues
  ) {
    const { trx, context } = scope
    const result = await trx.rawQuery(
      `update approval_workflows set name = ?, description = ?, subject_type = ?, updated_by = ?, updated_at = now(),
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        values.name,
        values.description,
        values.subjectType,
        context.userId,
        context.tenantId,
        id,
        expectedVersion,
      ] as never[]
    )
    if (result.rows.length === 0) return false
    await this.replaceSteps(scope, id, values.steps)
    return true
  }

  private async replaceSteps(
    { trx, context }: TenantScope,
    workflowId: string,
    steps: StepValues[]
  ) {
    await trx.rawQuery(
      'delete from approval_workflow_steps where tenant_id = ? and workflow_id = ?',
      [context.tenantId, workflowId]
    )
    for (const s of steps) {
      await trx.rawQuery(
        `insert into approval_workflow_steps (tenant_id, created_by, updated_by, workflow_id, sequence, name,
                                              approver_type, approver_role_id, approver_membership_id, required_approvals)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          workflowId,
          s.sequence,
          s.name,
          s.approverType,
          s.approverRoleId,
          s.approverMembershipId,
          s.requiredApprovals,
        ] as never[]
      )
    }
  }

  async setWorkflowStatus(
    { trx, context }: TenantScope,
    id: string,
    expectedVersion: number,
    status: WorkflowStatus
  ) {
    const result = await trx.rawQuery(
      `update approval_workflows set status = ?, published_at = case when ? = 'ACTIVE' then now() else published_at end,
              updated_by = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [status, status, context.userId, context.tenantId, id, expectedVersion]
    )
    return result.rows.length > 0
  }

  async deleteWorkflow({ trx, context }: TenantScope, id: string) {
    await trx.rawQuery('delete from approval_workflows where tenant_id = ? and id = ?', [
      context.tenantId,
      id,
    ])
  }

  /** Estado e número de membros activos com cada perfil / estado de cada membro referido nas etapas. */
  async approverHealth({ trx, context }: TenantScope, roleIds: string[], membershipIds: string[]) {
    const roles = await trx.rawQuery(
      `select r.id, r.status,
              (select count(distinct mr.membership_id)::int from membership_roles mr
                 join tenant_memberships m on m.tenant_id = mr.tenant_id and m.id = mr.membership_id and m.status = 'ACTIVE'
                where mr.tenant_id = r.tenant_id and mr.role_id = r.id) as holders
         from roles r where r.tenant_id = ? and r.id = any(?::uuid[])`,
      [context.tenantId, roleIds] as never[]
    )
    const members = await trx.rawQuery(
      'select id, status from tenant_memberships where tenant_id = ? and id = any(?::uuid[])',
      [context.tenantId, membershipIds] as never[]
    )
    return {
      roles: new Map(
        (roles.rows as any[]).map((r) => [
          r.id as string,
          { status: r.status as string, holders: r.holders as number },
        ])
      ),
      members: new Map((members.rows as any[]).map((m) => [m.id as string, m.status as string])),
    }
  }

  // ---------- pedidos ----------
  async insertRequest(
    { trx, context }: TenantScope,
    input: {
      workflowId: string
      subjectType: string
      subjectId: string | null
      title: string
      description: string | null
      firstStep: number
    }
  ) {
    const result = await trx.rawQuery(
      `insert into approval_requests (tenant_id, created_by, updated_by, workflow_id, subject_type, subject_id, title,
                                      description, current_step, requested_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        context.tenantId,
        context.userId,
        context.userId,
        input.workflowId,
        input.subjectType,
        input.subjectId,
        input.title,
        input.description,
        input.firstStep,
        context.membershipId,
      ] as never[]
    )
    return (result.rows[0] as { id: string }).id
  }

  async findRequest({ trx, context }: TenantScope, id: string, lock = false) {
    if (lock)
      await trx.rawQuery(
        'select id from approval_requests where tenant_id = ? and id = ? for update',
        [context.tenantId, id]
      )
    const result = await trx.rawQuery(`${REQUEST_SELECT} where r.tenant_id = ? and r.id = ?`, [
      context.tenantId,
      id,
    ])
    return result.rows[0] ? toRequest(result.rows[0]) : null
  }

  async listRequests(
    { trx, context }: TenantScope,
    filter: { status?: RequestStatus; onlyInvolving?: string; limit: number; offset: number }
  ) {
    const where = ['r.tenant_id = ?']
    const params: unknown[] = [context.tenantId]
    if (filter.status) {
      where.push('r.status = ?')
      params.push(filter.status)
    }
    if (filter.onlyInvolving) {
      where.push(`(r.requested_by_membership_id = ? or exists (
        select 1 from approval_decisions d where d.tenant_id = r.tenant_id and d.request_id = r.id
           and (d.decided_by_membership_id = ? or d.on_behalf_of_membership_id = ?)))`)
      params.push(filter.onlyInvolving, filter.onlyInvolving, filter.onlyInvolving)
    }
    const clause = where.join(' and ')
    const rows = await trx.rawQuery(
      `${REQUEST_SELECT} where ${clause} order by r.created_at desc, r.id desc limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trx.rawQuery(
      `select count(*)::int as total from approval_requests r where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as any[]).map(toRequest),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async decisions({ trx, context }: TenantScope, requestId: string): Promise<DecisionView[]> {
    const result = await trx.rawQuery(
      `select d.step_sequence, d.decision, d.comment, d.created_at,
              d.decided_by_membership_id, u1.full_name as by_name, u1.email as by_email,
              d.on_behalf_of_membership_id, u2.full_name as behalf_name, u2.email as behalf_email
         from approval_decisions d
         join tenant_memberships m1 on m1.tenant_id = d.tenant_id and m1.id = d.decided_by_membership_id
         join users u1 on u1.id = m1.user_id
         left join tenant_memberships m2 on m2.tenant_id = d.tenant_id and m2.id = d.on_behalf_of_membership_id
         left join users u2 on u2.id = m2.user_id
        where d.tenant_id = ? and d.request_id = ? order by d.created_at, d.id`,
      [context.tenantId, requestId]
    )
    return (result.rows as any[]).map((d) => ({
      stepSequence: d.step_sequence,
      decision: d.decision,
      comment: d.comment,
      decidedBy: {
        membershipId: d.decided_by_membership_id,
        fullName: d.by_name,
        email: d.by_email,
      },
      onBehalfOf: d.on_behalf_of_membership_id
        ? {
            membershipId: d.on_behalf_of_membership_id,
            fullName: d.behalf_name,
            email: d.behalf_email,
          }
        : null,
      decidedAt: iso(d.created_at)!,
    }))
  }

  async insertDecision(
    { trx, context }: TenantScope,
    input: {
      requestId: string
      step: number
      onBehalfOf: string | null
      decision: Decision
      comment: string | null
    }
  ) {
    await trx.rawQuery('savepoint decision_insert')
    try {
      await trx.rawQuery(
        `insert into approval_decisions (tenant_id, created_by, updated_by, request_id, step_sequence,
                                         decided_by_membership_id, on_behalf_of_membership_id, decision, comment)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          input.requestId,
          input.step,
          context.membershipId,
          input.onBehalfOf,
          input.decision,
          input.comment,
        ] as never[]
      )
      await trx.rawQuery('release savepoint decision_insert')
    } catch (error) {
      const constraint = constraintOf(error)
      if (
        constraint === 'approval_decisions_person_unique' ||
        constraint === 'approval_decisions_slot_unique'
      ) {
        await trx.rawQuery('rollback to savepoint decision_insert')
        throw ApiError.conflict('ALREADY_DECIDED', 'Esta etapa já tem a sua decisão.')
      }
      throw error
    }
  }

  async approvalsInStep({ trx, context }: TenantScope, requestId: string, step: number) {
    const result = await trx.rawQuery(
      `select count(*)::int as n from approval_decisions
        where tenant_id = ? and request_id = ? and step_sequence = ? and decision = 'APPROVE'`,
      [context.tenantId, requestId, step]
    )
    return (result.rows[0] as { n: number }).n
  }

  async setRequestState(
    { trx, context }: TenantScope,
    id: string,
    status: RequestStatus,
    currentStep: number | null
  ) {
    await trx.rawQuery(
      `update approval_requests set status = ?, current_step = ?,
              completed_at = case when ? = 'PENDING' then null else now() end,
              updated_by = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [status, currentStep, status, context.userId, context.tenantId, id] as never[]
    )
  }

  // ---------- elegibilidade ----------
  /**
   * Etapas correntes que `membershipId` pode decidir agora: como aprovador directo ou por delegação activa (o slot é
   * quem delegou). Exclui pedidos do próprio ou de quem delegou (segregação de funções) e slots já usados, e nunca deixa a
   * mesma pessoa votar duas vezes na mesma etapa.
   */
  async pendingSlots(
    { trx, context }: TenantScope,
    membershipId: string,
    requestId?: string
  ): Promise<PendingSlot[]> {
    const result = await trx.rawQuery(
      `with slots as (
         select ?::uuid as slot, null::uuid as delegation_workflow, false as delegated
         union all
         select d.delegator_membership_id, d.workflow_id, true from approval_delegations d
          where d.tenant_id = ? and d.delegate_membership_id = ? and d.status = 'ACTIVE'
            and now() >= d.starts_at and now() < d.ends_at)
       select r.id, r.title, r.subject_type, r.subject_id, r.workflow_id, r.created_at, r.requested_by_membership_id,
              st.sequence, st.name as step_name, case when sl.delegated then sl.slot end as on_behalf_of
         from approval_requests r
         join approval_workflow_steps st
           on st.tenant_id = r.tenant_id and st.workflow_id = r.workflow_id and st.sequence = r.current_step
         join slots sl on (not sl.delegated or sl.delegation_workflow is null or sl.delegation_workflow = r.workflow_id)
         join tenant_memberships ms on ms.tenant_id = r.tenant_id and ms.id = sl.slot and ms.status = 'ACTIVE'
        where r.tenant_id = ? and r.status = 'PENDING' ${requestId ? 'and r.id = ?' : ''}
          and r.requested_by_membership_id <> sl.slot and r.requested_by_membership_id <> ?
          and ${DIRECTLY_ELIGIBLE}
          and not exists (
            select 1 from approval_decisions x
             where x.tenant_id = r.tenant_id and x.request_id = r.id and x.step_sequence = r.current_step
               and (coalesce(x.on_behalf_of_membership_id, x.decided_by_membership_id) = sl.slot
                    or x.decided_by_membership_id = ?))
        order by r.created_at, r.id`,
      [
        membershipId,
        context.tenantId,
        membershipId,
        context.tenantId,
        ...(requestId ? [requestId] : []),
        membershipId,
        membershipId,
      ] as never[]
    )
    return (result.rows as any[]).map((r) => ({
      requestId: r.id,
      title: r.title,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      workflowId: r.workflow_id,
      stepSequence: r.sequence,
      stepName: r.step_name,
      requestedByMembershipId: r.requested_by_membership_id,
      createdAt: iso(r.created_at)!,
      onBehalfOf: r.on_behalf_of,
    }))
  }

  /** Quem pode decidir a etapa corrente (directos e delegados activos), para notificar. */
  async currentApprovers({ trx, context }: TenantScope, requestId: string): Promise<string[]> {
    const result = await trx.rawQuery(
      `with st as (
         select s.* from approval_requests r
           join approval_workflow_steps s on s.tenant_id = r.tenant_id and s.workflow_id = r.workflow_id and s.sequence = r.current_step
          where r.tenant_id = ? and r.id = ? and r.status = 'PENDING'),
       direct as (
         select sl.slot from st
           cross join lateral (select m.id as slot from tenant_memberships m
                                where m.tenant_id = st.tenant_id and m.status = 'ACTIVE') sl
          where ${DIRECTLY_ELIGIBLE}
            and sl.slot <> (select requested_by_membership_id from approval_requests where tenant_id = ? and id = ?))
       select slot as id from direct
       union
       select d.delegate_membership_id from approval_delegations d
         join direct on direct.slot = d.delegator_membership_id
         join tenant_memberships m on m.tenant_id = d.tenant_id and m.id = d.delegate_membership_id and m.status = 'ACTIVE'
        where d.tenant_id = ? and d.status = 'ACTIVE' and now() >= d.starts_at and now() < d.ends_at
          and (d.workflow_id is null or d.workflow_id = (select workflow_id from approval_requests where tenant_id = ? and id = ?))
          and d.delegate_membership_id <> (select requested_by_membership_id from approval_requests where tenant_id = ? and id = ?)`,
      [
        context.tenantId,
        requestId,
        context.tenantId,
        requestId,
        context.tenantId,
        context.tenantId,
        requestId,
        context.tenantId,
        requestId,
      ]
    )
    return (result.rows as { id: string }[]).map((r) => r.id)
  }

  async hasDecidedInStep(
    { trx, context }: TenantScope,
    requestId: string,
    step: number,
    membershipId: string
  ) {
    const result = await trx.rawQuery(
      `select 1 from approval_decisions where tenant_id = ? and request_id = ? and step_sequence = ?
          and decided_by_membership_id = ? limit 1`,
      [context.tenantId, requestId, step, membershipId]
    )
    return result.rows.length > 0
  }

  async hasDecided({ trx, context }: TenantScope, requestId: string, membershipId: string) {
    const result = await trx.rawQuery(
      `select 1 from approval_decisions where tenant_id = ? and request_id = ?
          and (decided_by_membership_id = ? or on_behalf_of_membership_id = ?) limit 1`,
      [context.tenantId, requestId, membershipId, membershipId]
    )
    return result.rows.length > 0
  }

  // ---------- delegações ----------
  async insertDelegation(
    { trx, context }: TenantScope,
    input: {
      delegateId: string
      workflowId: string | null
      startsAt: Date
      endsAt: Date
      reason: string
    }
  ) {
    const result = await trx.rawQuery(
      `insert into approval_delegations (tenant_id, created_by, updated_by, delegator_membership_id,
                                         delegate_membership_id, workflow_id, starts_at, ends_at, reason)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        context.tenantId,
        context.userId,
        context.userId,
        context.membershipId,
        input.delegateId,
        input.workflowId,
        input.startsAt,
        input.endsAt,
        input.reason,
      ] as never[]
    )
    return (result.rows[0] as { id: string }).id
  }

  async listDelegations({ trx, context }: TenantScope, involving: string | null, id?: string) {
    const where = ['d.tenant_id = ?']
    const params: unknown[] = [context.tenantId]
    if (involving) {
      where.push('(d.delegator_membership_id = ? or d.delegate_membership_id = ?)')
      params.push(involving, involving)
    }
    if (id) {
      where.push('d.id = ?')
      params.push(id)
    }
    const result = await trx.rawQuery(
      `select d.id, d.workflow_id, d.starts_at, d.ends_at, d.reason, d.status, d.revoked_at, d.version, d.created_at,
              d.delegator_membership_id, u1.full_name as from_name, u1.email as from_email,
              d.delegate_membership_id, u2.full_name as to_name, u2.email as to_email
         from approval_delegations d
         join tenant_memberships m1 on m1.tenant_id = d.tenant_id and m1.id = d.delegator_membership_id
         join users u1 on u1.id = m1.user_id
         join tenant_memberships m2 on m2.tenant_id = d.tenant_id and m2.id = d.delegate_membership_id
         join users u2 on u2.id = m2.user_id
        where ${where.join(' and ')} order by d.starts_at desc, d.id`,
      params as never[]
    )
    return (result.rows as any[]).map((d) => ({
      id: d.id as string,
      delegator: {
        membershipId: d.delegator_membership_id,
        fullName: d.from_name,
        email: d.from_email,
      } as Person,
      delegate: {
        membershipId: d.delegate_membership_id,
        fullName: d.to_name,
        email: d.to_email,
      } as Person,
      workflowId: d.workflow_id as string | null,
      startsAt: iso(d.starts_at)!,
      endsAt: iso(d.ends_at)!,
      reason: d.reason as string,
      status: d.status as 'ACTIVE' | 'REVOKED',
      revokedAt: iso(d.revoked_at),
      version: d.version as number,
    }))
  }

  async revokeDelegation({ trx, context }: TenantScope, id: string) {
    const result = await trx.rawQuery(
      `update approval_delegations set status = 'REVOKED', revoked_at = now(), updated_by = ?, updated_at = now(),
              version = version + 1
        where tenant_id = ? and id = ? and status = 'ACTIVE' returning id`,
      [context.userId, context.tenantId, id]
    )
    return result.rows.length > 0
  }

  async memberStatus({ trx, context }: TenantScope, membershipId: string) {
    const result = await trx.rawQuery(
      'select status from tenant_memberships where tenant_id = ? and id = ?',
      [context.tenantId, membershipId]
    )
    return (result.rows[0] as { status: string } | undefined)?.status ?? null
  }
}

export type { ApproverType }
