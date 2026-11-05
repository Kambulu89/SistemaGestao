import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { effectivePermissions } from '#modules/rbac/index'
import { audit, diff } from '#modules/audit/index'
import { notify } from '#modules/notifications/index'
import {
  MAX_DELEGATION_DAYS,
  normalizeRequest,
  normalizeWorkflow,
  type Decision,
  type RequestStatus,
  type WorkflowStatus,
  type WorkflowValues,
} from '#modules/approvals/domain/approvals'
import {
  ApprovalRepository,
  type ApprovalRequest,
  type Workflow,
} from '#modules/approvals/infrastructure/approval_repository'

const repository = new ApprovalRepository()
const WORKFLOW_FIELDS = ['name', 'description', 'subjectType', 'steps'] as const

/** Definições de workflow: só se alteram em DRAFT; publicar valida aprovadores; retirar impede pedidos novos. */
export class WorkflowService {
  list(context: TenantContext, status?: WorkflowStatus) {
    return runInTenant(context, (scope) => repository.listWorkflows(scope, status))
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const wf = await repository.findWorkflow(scope, id)
      if (!wf) throw ApiError.notFound()
      return wf
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    const { values, issues } = normalizeWorkflow(input, null)
    if (!values) throw ApiError.validation(issues)
    return runInTenant(context, async (scope) => {
      await this.checkApprovers(scope, values, false)
      const id = await repository.insertWorkflow(scope, values)
      await audit(scope, {
        action: 'approval_workflow.created',
        entityType: 'approval_workflow',
        entityId: id,
        changes: diff(null, { ...values }, ['code', ...WORKFLOW_FIELDS]),
      })
      return (await repository.findWorkflow(scope, id))!
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown> & { expectedVersion: number }
  ) {
    return runInTenant(context, async (scope) => {
      const current = await repository.findWorkflow(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT')
        throw ApiError.conflict('WORKFLOW_IMMUTABLE', 'Um workflow publicado não se altera.')
      const { values, issues } = normalizeWorkflow(input, current)
      if (!values) throw ApiError.validation(issues)
      await this.checkApprovers(scope, values, false)
      if (!(await repository.updateWorkflow(scope, id, input.expectedVersion, values)))
        throw ApiError.versionConflict(current.version)
      const updated = (await repository.findWorkflow(scope, id))!
      const changes = diff({ ...current }, { ...updated }, WORKFLOW_FIELDS)
      if (changes)
        await audit(scope, {
          action: 'approval_workflow.updated',
          entityType: 'approval_workflow',
          entityId: id,
          changes,
        })
      return updated
    })
  }

  setStatus(
    context: TenantContext,
    id: string,
    expectedVersion: number,
    status: 'ACTIVE' | 'RETIRED'
  ) {
    return runInTenant(context, async (scope) => {
      const current = await repository.findWorkflow(scope, id, true)
      if (!current) throw ApiError.notFound()
      const allowed = status === 'ACTIVE' ? current.status === 'DRAFT' : current.status === 'ACTIVE'
      if (!allowed)
        throw ApiError.conflict(
          'WORKFLOW_STATE',
          `Transição inválida: ${current.status} → ${status}.`
        )
      if (status === 'ACTIVE') await this.checkApprovers(scope, current, true)
      if (!(await repository.setWorkflowStatus(scope, id, expectedVersion, status)))
        throw ApiError.versionConflict(current.version)
      await audit(scope, {
        action: status === 'ACTIVE' ? 'approval_workflow.published' : 'approval_workflow.retired',
        entityType: 'approval_workflow',
        entityId: id,
        changes: { status: { from: current.status, to: status } },
      })
      return (await repository.findWorkflow(scope, id))!
    })
  }

  remove(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const current = await repository.findWorkflow(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT')
        throw ApiError.conflict(
          'WORKFLOW_IMMUTABLE',
          'Só se elimina um workflow em rascunho; retire-o.'
        )
      await repository.deleteWorkflow(scope, id)
      await audit(scope, {
        action: 'approval_workflow.deleted',
        entityType: 'approval_workflow',
        entityId: id,
        metadata: { code: current.code },
      })
    })
  }

  /**
   * Os perfis e membros referidos existem nesta empresa (sempre); para publicar, estão activos e cada perfil tem
   * membros activos suficientes para o número de aprovações exigido (senão a etapa nunca terminaria).
   */
  private async checkApprovers(scope: TenantScope, values: WorkflowValues, publishing: boolean) {
    const roleIds = values.steps.flatMap((s) => (s.approverRoleId ? [s.approverRoleId] : []))
    const memberIds = values.steps.flatMap((s) =>
      s.approverMembershipId ? [s.approverMembershipId] : []
    )
    const health = await repository.approverHealth(scope, roleIds, memberIds)
    const issues: ErrorDetail[] = []
    if (publishing && values.steps.length === 0)
      issues.push({
        path: 'steps',
        code: 'REQUIRED',
        message: 'Um workflow publicado tem pelo menos uma etapa.',
      })
    values.steps.forEach((s, i) => {
      if (s.approverRoleId) {
        const role = health.roles.get(s.approverRoleId)
        if (!role)
          issues.push({
            path: `steps.${i}.approverRoleId`,
            code: 'NOT_FOUND',
            message: 'O perfil não existe.',
          })
        else if (publishing && role.status !== 'ACTIVE')
          issues.push({
            path: `steps.${i}.approverRoleId`,
            code: 'INACTIVE',
            message: 'O perfil está inactivo.',
          })
        else if (publishing && role.holders < s.requiredApprovals)
          issues.push({
            path: `steps.${i}.requiredApprovals`,
            code: 'NOT_ENOUGH_APPROVERS',
            message: `O perfil tem ${role.holders} membro(s) activo(s); exige ${s.requiredApprovals}.`,
          })
      }
      if (s.approverMembershipId) {
        const status = health.members.get(s.approverMembershipId)
        if (!status || status === 'REVOKED')
          issues.push({
            path: `steps.${i}.approverMembershipId`,
            code: 'NOT_FOUND',
            message: 'O membro não existe.',
          })
        else if (publishing && status !== 'ACTIVE')
          issues.push({
            path: `steps.${i}.approverMembershipId`,
            code: 'INACTIVE',
            message: 'O membro não está activo.',
          })
      }
    })
    if (issues.length > 0) throw ApiError.validation(issues)
  }
}

export interface RequestDetail extends ApprovalRequest {
  steps: Workflow['steps']
  decisions: Awaited<ReturnType<ApprovalRepository['decisions']>>
  /** Como o membro em contexto pode decidir agora (vazio se não pode). */
  myOptions: { onBehalfOf: string | null }[]
}

async function detail(scope: TenantScope, request: ApprovalRequest): Promise<RequestDetail> {
  const wf = (await repository.findWorkflow(scope, request.workflow.id))!
  const slots = await repository.pendingSlots(scope, scope.context.membershipId, request.id)
  return {
    ...request,
    steps: wf.steps,
    decisions: await repository.decisions(scope, request.id),
    myOptions: slots.map((s) => ({ onBehalfOf: s.onBehalfOf })),
  }
}

/** Quem vê um pedido: `approvals.read`, o requerente, quem nele decidiu, ou quem o pode decidir agora. */
export async function canViewRequest(scope: TenantScope, requestId: string) {
  const request = await repository.findRequest(scope, requestId)
  if (!request) return null
  const me = scope.context.membershipId
  if (request.requestedBy.membershipId === me) return request
  if ((await effectivePermissions(scope)).tenant.has('approvals.read')) return request
  if (await repository.hasDecided(scope, requestId, me)) return request
  if ((await repository.pendingSlots(scope, me, requestId)).length > 0) return request
  return null
}

/** Pedidos de aprovação: submeter, decidir (com delegação), cancelar, consultar. */
export class ApprovalRequestService {
  submit(context: TenantContext, input: Record<string, unknown>) {
    const { values, issues } = normalizeRequest(input)
    if (issues.length > 0) throw ApiError.validation(issues)
    return runInTenant(context, async (scope) => {
      const wf = await repository.findWorkflow(scope, values.workflowId)
      if (!wf || wf.status !== 'ACTIVE')
        throw ApiError.validation([
          {
            path: 'workflowId',
            code: 'NOT_ACTIVE',
            message: 'O workflow não existe ou não está publicado.',
          },
        ])
      if (wf.subjectType !== 'manual')
        throw ApiError.validation([
          {
            path: 'workflowId',
            code: 'SUBJECT_TYPE',
            message: 'Este workflow é usado pelo seu módulo.',
          },
        ])
      const id = await repository.insertRequest(scope, {
        workflowId: wf.id,
        subjectType: wf.subjectType,
        subjectId: null,
        title: values.title,
        description: values.description,
        firstStep: wf.steps[0].sequence,
      })
      await audit(scope, {
        action: 'approval_request.submitted',
        entityType: 'approval_request',
        entityId: id,
        metadata: { workflowCode: wf.code, title: values.title },
      })
      await this.notifyApprovers(scope, id, values.title)
      return detail(scope, (await repository.findRequest(scope, id))!)
    })
  }

  list(context: TenantContext, filter: { status?: RequestStatus; limit: number; offset: number }) {
    return runInTenant(context, async (scope) => {
      const all = (await effectivePermissions(scope)).tenant.has('approvals.read')
      return repository.listRequests(scope, {
        ...filter,
        onlyInvolving: all ? undefined : context.membershipId,
      })
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const request = await canViewRequest(scope, id)
      if (!request) throw ApiError.notFound()
      return detail(scope, request)
    })
  }

  decide(
    context: TenantContext,
    id: string,
    input: { decision: Decision; comment?: string | null; onBehalfOf?: string | null }
  ) {
    const comment = input.comment?.trim() || null
    if (input.decision === 'REJECT' && !comment)
      throw ApiError.validation([
        { path: 'comment', code: 'REQUIRED', message: 'Indique o motivo da rejeição.' },
      ])
    if (comment && comment.length > 2000)
      throw ApiError.validation([
        { path: 'comment', code: 'LENGTH', message: 'Até 2000 caracteres.' },
      ])
    const onBehalfOf = input.onBehalfOf ?? null
    return runInTenant(context, async (scope) => {
      // Serializa as decisões do pedido: duas aprovações simultâneas não avançam a etapa duas vezes.
      const request = await repository.findRequest(scope, id, true)
      if (!request) throw ApiError.notFound()
      if (request.status !== 'PENDING')
        throw ApiError.conflict('REQUEST_CLOSED', 'O pedido já não está pendente.')
      const me = context.membershipId
      if (
        request.requestedBy.membershipId === me ||
        request.requestedBy.membershipId === onBehalfOf
      )
        throw ApiError.forbidden('SEGREGATION_OF_DUTIES', 'Quem pede não aprova o próprio pedido.')
      const slots = await repository.pendingSlots(scope, me, id)
      const slot = slots.find((s) => s.onBehalfOf === onBehalfOf)
      if (!slot) {
        if (await repository.hasDecidedInStep(scope, id, request.currentStep!, me))
          throw ApiError.conflict('ALREADY_DECIDED', 'Esta etapa já tem a sua decisão.')
        if (!(await canViewRequest(scope, id))) throw ApiError.notFound()
        throw ApiError.forbidden(
          'NOT_AN_APPROVER',
          onBehalfOf
            ? 'Não tem uma delegação activa de um aprovador desta etapa.'
            : 'Não é aprovador desta etapa.'
        )
      }
      const step = request.currentStep!
      await repository.insertDecision(scope, {
        requestId: id,
        step,
        onBehalfOf,
        decision: input.decision,
        comment,
      })
      let status: RequestStatus = 'PENDING'
      let next: number | null = step
      if (input.decision === 'REJECT') {
        status = 'REJECTED'
        next = null
      } else {
        const wf = (await repository.findWorkflow(scope, request.workflow.id))!
        const current = wf.steps.find((s) => s.sequence === step)!
        if ((await repository.approvalsInStep(scope, id, step)) >= current.requiredApprovals) {
          const following = wf.steps.find((s) => s.sequence > step)
          if (following) next = following.sequence
          else {
            status = 'APPROVED'
            next = null
          }
        }
      }
      if (status !== 'PENDING' || next !== step)
        await repository.setRequestState(scope, id, status, next)
      await audit(scope, {
        action:
          input.decision === 'APPROVE'
            ? 'approval_request.approved_step'
            : 'approval_request.rejected',
        entityType: 'approval_request',
        entityId: id,
        metadata: { step, onBehalfOf, comment, resultingStatus: status, resultingStep: next },
      })
      if (status === 'APPROVED')
        await audit(scope, {
          action: 'approval_request.completed',
          entityType: 'approval_request',
          entityId: id,
          changes: { status: { from: 'PENDING', to: 'APPROVED' } },
        })
      if (status !== 'PENDING') {
        await notify(scope, [request.requestedBy.membershipId], {
          type: status === 'APPROVED' ? 'approval.approved' : 'approval.rejected',
          title: `${status === 'APPROVED' ? 'Aprovado' : 'Rejeitado'}: ${request.title}`,
          body: comment,
          subjectType: 'approval_request',
          subjectId: id,
        })
      } else if (next !== step) {
        await this.notifyApprovers(scope, id, request.title)
      }
      return detail(scope, (await repository.findRequest(scope, id))!)
    })
  }

  cancel(context: TenantContext, id: string, reason: string | null) {
    return runInTenant(context, async (scope) => {
      const request = await repository.findRequest(scope, id, true)
      if (!request || !(await canViewRequest(scope, id))) throw ApiError.notFound()
      const own = request.requestedBy.membershipId === context.membershipId
      if (!own && !(await effectivePermissions(scope)).tenant.has('approvals.manage'))
        throw ApiError.forbidden()
      if (request.status !== 'PENDING')
        throw ApiError.conflict('REQUEST_CLOSED', 'O pedido já não está pendente.')
      await repository.setRequestState(scope, id, 'CANCELLED', null)
      await audit(scope, {
        action: 'approval_request.cancelled',
        entityType: 'approval_request',
        entityId: id,
        changes: { status: { from: 'PENDING', to: 'CANCELLED' } },
        metadata: { reason },
      })
      if (!own)
        await notify(scope, [request.requestedBy.membershipId], {
          type: 'approval.cancelled',
          title: `Cancelado: ${request.title}`,
          body: reason,
          subjectType: 'approval_request',
          subjectId: id,
        })
      return detail(scope, (await repository.findRequest(scope, id))!)
    })
  }

  /** Centro de tarefas: etapas que o membro pode decidir agora. */
  pendingTasks(context: TenantContext) {
    return runInTenant(context, (scope) => repository.pendingSlots(scope, context.membershipId))
  }

  private async notifyApprovers(scope: TenantScope, requestId: string, title: string) {
    await notify(scope, await repository.currentApprovers(scope, requestId), {
      type: 'approval.pending',
      title: `Aprovação pendente: ${title}`,
      subjectType: 'approval_request',
      subjectId: requestId,
    })
  }
}

/** Delegações: cada um delega as suas aprovações; `approvals.manage` vê e revoga todas. */
export class DelegationService {
  list(context: TenantContext, all: boolean) {
    return runInTenant(context, async (scope) => {
      const canAll = all && (await effectivePermissions(scope)).tenant.has('approvals.manage')
      if (all && !canAll) throw ApiError.forbidden()
      return repository.listDelegations(scope, canAll ? null : context.membershipId)
    })
  }

  create(
    context: TenantContext,
    input: {
      delegateMembershipId: string
      workflowId?: string | null
      startsAt?: Date
      endsAt: Date
      reason: string
    }
  ) {
    const startsAt = input.startsAt ?? new Date()
    const issues: ErrorDetail[] = []
    if (input.endsAt <= startsAt)
      issues.push({
        path: 'endsAt',
        code: 'RANGE',
        message: 'O fim tem de ser posterior ao início.',
      })
    if (input.endsAt.getTime() - startsAt.getTime() > MAX_DELEGATION_DAYS * 86_400_000)
      issues.push({
        path: 'endsAt',
        code: 'TOO_LONG',
        message: `No máximo ${MAX_DELEGATION_DAYS} dias.`,
      })
    if (input.endsAt <= new Date())
      issues.push({ path: 'endsAt', code: 'PAST', message: 'A delegação já teria terminado.' })
    if (input.delegateMembershipId === context.membershipId)
      issues.push({
        path: 'delegateMembershipId',
        code: 'SELF',
        message: 'Não pode delegar em si próprio.',
      })
    if (issues.length > 0) throw ApiError.validation(issues)
    return runInTenant(context, async (scope) => {
      if ((await repository.memberStatus(scope, input.delegateMembershipId)) !== 'ACTIVE')
        throw ApiError.validation([
          {
            path: 'delegateMembershipId',
            code: 'NOT_ACTIVE',
            message: 'O delegado não é um membro activo.',
          },
        ])
      if (input.workflowId) {
        const wf = await repository.findWorkflow(scope, input.workflowId)
        if (!wf)
          throw ApiError.validation([
            { path: 'workflowId', code: 'NOT_FOUND', message: 'O workflow não existe.' },
          ])
      }
      const id = await repository.insertDelegation(scope, {
        delegateId: input.delegateMembershipId,
        workflowId: input.workflowId ?? null,
        startsAt,
        endsAt: input.endsAt,
        reason: input.reason.trim(),
      })
      await audit(scope, {
        action: 'approval_delegation.created',
        entityType: 'approval_delegation',
        entityId: id,
        metadata: {
          delegateMembershipId: input.delegateMembershipId,
          workflowId: input.workflowId ?? null,
          startsAt: startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
        },
      })
      await notify(scope, [input.delegateMembershipId], {
        type: 'approval.delegation_received',
        title: 'Recebeu uma delegação de aprovações',
        body: input.reason.trim(),
        subjectType: 'approval_delegation',
        subjectId: id,
      })
      return (await repository.listDelegations(scope, null, id))[0]
    })
  }

  revoke(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const [current] = await repository.listDelegations(scope, null, id)
      if (!current) throw ApiError.notFound()
      const involved = [current.delegator.membershipId, current.delegate.membershipId].includes(
        context.membershipId
      )
      const manager = (await effectivePermissions(scope)).tenant.has('approvals.manage')
      if (!involved && !manager) throw ApiError.notFound()
      if (current.delegator.membershipId !== context.membershipId && !manager)
        throw ApiError.forbidden()
      if (!(await repository.revokeDelegation(scope, id)))
        throw ApiError.conflict('DELEGATION_REVOKED', 'A delegação já foi revogada.')
      await audit(scope, {
        action: 'approval_delegation.revoked',
        entityType: 'approval_delegation',
        entityId: id,
        changes: { status: { from: 'ACTIVE', to: 'REVOKED' } },
      })
      return (await repository.listDelegations(scope, null, id))[0]
    })
  }
}

/**
 * Números de aprovações para o painel: tarefas do próprio, pedidos próprios abertos e, com `approvals.read`, os
 * pedidos da empresa por estado e por semana (últimas 8). Sem `approvals.read` os totais são só os pedidos em que
 * participa.
 */
export async function approvalStats(scope: TenantScope) {
  const me = scope.context.membershipId
  const all = (await effectivePermissions(scope)).tenant.has('approvals.read')
  const tasks = (await repository.pendingSlots(scope, me)).length
  const involved = `(r.requested_by_membership_id = ? or exists (select 1 from approval_decisions d
      where d.tenant_id = r.tenant_id and d.request_id = r.id and (d.decided_by_membership_id = ? or d.on_behalf_of_membership_id = ?)))`
  const filter = all ? '' : ` and ${involved}`
  const params = all ? [scope.context.tenantId] : [scope.context.tenantId, me, me, me]
  const byStatus = await scope.trx.rawQuery(
    `select r.status, count(*)::int as n from approval_requests r where r.tenant_id = ?${filter} group by r.status`,
    params as never[]
  )
  const mine = await scope.trx.rawQuery(
    `select count(*)::int as n from approval_requests where tenant_id = ? and requested_by_membership_id = ? and status = 'PENDING'`,
    [scope.context.tenantId, me]
  )
  const weekly = await scope.trx.rawQuery(
    `select to_char(w.week, 'YYYY-MM-DD') as week, count(r.id)::int as n
       from generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') as w(week)
       left join approval_requests r on r.tenant_id = ? and date_trunc('week', r.created_at) = w.week${filter}
      group by w.week order by w.week`,
    params as never[]
  )
  return {
    scope: all ? ('TENANT' as const) : ('MINE' as const),
    tasks,
    myOpen: (mine.rows[0] as { n: number }).n,
    byStatus: Object.fromEntries(
      (byStatus.rows as { status: string; n: number }[]).map((r) => [r.status, r.n])
    ),
    weekly: (weekly.rows as { week: string; n: number }[]).map((r) => ({
      week: r.week,
      count: r.n,
    })),
  }
}

/** Pesquisa de pedidos visíveis (todos com `approvals.read`, senão os do próprio) e de workflows (`approvals.manage`). */
export async function searchApprovals(scope: TenantScope, q: string, limit: number) {
  const me = scope.context.membershipId
  const held = (await effectivePermissions(scope)).tenant
  const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const visibility = held.has('approvals.read')
    ? ''
    : ` and (r.requested_by_membership_id = ? or exists (select 1 from approval_decisions d where d.tenant_id = r.tenant_id
          and d.request_id = r.id and (d.decided_by_membership_id = ? or d.on_behalf_of_membership_id = ?)))`
  const requests = await scope.trx.rawQuery(
    `select r.id, r.title, r.status from approval_requests r
      where r.tenant_id = ? and lower(r.title) like ?${visibility} order by r.created_at desc limit ?`,
    (held.has('approvals.read')
      ? [scope.context.tenantId, like, limit]
      : [scope.context.tenantId, like, me, me, me, limit]) as never[]
  )
  const workflows = held.has('approvals.manage')
    ? await scope.trx.rawQuery(
        `select id, code, name, status from approval_workflows
          where tenant_id = ? and (lower(name) like ? or lower(code) like ?) order by code limit ?`,
        [scope.context.tenantId, like, like, limit]
      )
    : { rows: [] }
  return {
    requests: (requests.rows as { id: string; title: string; status: string }[]).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
    })),
    workflows: (workflows.rows as { id: string; code: string; name: string; status: string }[]).map(
      (w) => ({
        id: w.id,
        title: `${w.code} — ${w.name}`,
        status: w.status,
      })
    ),
  }
}
