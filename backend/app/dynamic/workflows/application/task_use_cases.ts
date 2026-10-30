import { ApiError } from '#core/http/api_error'
import { memberOf } from '#dynamic/workflows/application/actor'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { StageFlow } from '#dynamic/workflows/application/flow'
import {
  compareDecimals,
  stageOutcome,
  type StageDef,
  type WorkflowGraph,
} from '#dynamic/workflows/domain/workflow'
import type {
  AccessControl,
  ConditionEngine,
  Delegation,
  DelegationStore,
  Directory,
  InboxRow,
  InstanceStore,
  TaskStore,
  WorkflowInstance,
  WorkflowStore,
  WorkflowTask,
} from '#dynamic/workflows/application/ports'

export const DECIDE_PERMISSION = 'approval.decide'
const MAX_REASON = 1000

export type TaskAction = 'approve' | 'reject' | 'return'

/** A tarefa tal como a caixa de aprovações a mostra. */
export interface TaskView {
  task: WorkflowTask
  workflow: { code: string; name: string; revision: number }
  entityCode: string
  recordId: string
  resourceVersion: number
  submittedByMembershipId: string
  stage: { code: string; label: string; criteria: string }
  amount: string | null
  currency: string | null
  overdue: boolean
  /** O que o utilizador pode fazer agora (o servidor volta a decidir ao executar). */
  can: { claim: boolean; decide: boolean }
  /** `true` se só pode agir por uma delegação. */
  delegated: boolean
}

interface Reach {
  roles: Set<string>
  delegations: Delegation[]
  delegatorRoles: Map<string, Set<string>>
  assigneeIds: string[]
  roleIds: string[]
}

interface Standing {
  /** `null`: não é responsável por esta tarefa (404). */
  responsible: boolean
  allowed: boolean
  delegationId: string | null
  reason: string | null
}

const TERMINAL: Record<TaskAction, 'APPROVED' | 'REJECTED' | 'RETURNED'> = {
  approve: 'APPROVED',
  reject: 'REJECTED',
  return: 'RETURNED',
}

/**
 * Caixa de aprovações e decisões (C14). Cada decisão corre numa transacção com a instância e a tarefa bloqueadas, por isso
 * duas decisões simultâneas nunca duplicam efeitos: a segunda encontra a tarefa já decidida (a repetição pelo mesmo
 * utilizador é idempotente). Quem submeteu não decide a sua submissão (salvo se a etapa o permitir), ninguém decide duas
 * tarefas da mesma etapa, e uma delegação só vale dentro do seu período, âmbito e montante máximo — sem cadeias.
 */
export class TaskUseCases {
  private readonly flow: StageFlow

  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly workflows: WorkflowStore,
    private readonly instances: InstanceStore,
    private readonly tasks: TaskStore,
    private readonly delegations: DelegationStore,
    private readonly directory: Directory,
    private readonly access: AccessControl,
    engine: ConditionEngine,
    outbox: OutboxWriter,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.flow = new StageFlow(instances, tasks, directory, engine, outbox, clock)
  }

  /** Minha caixa: pendentes (a decidir) ou já decididas, incluindo as que posso tratar por delegação. */
  async inbox(context: TenantContext, view: 'pending' | 'decided'): Promise<TaskView[]> {
    const at = this.clock()
    return this.uow.run(async (scope) => {
      const mine = await this.reach(scope, memberOf(context), at)
      const rows = await this.tasks.inbox(scope, {
        assigneeIds: mine.assigneeIds,
        roleIds: mine.roleIds,
        actorId: memberOf(context),
        view,
      })
      const graphs = new Map<string, WorkflowGraph | null>()
      const views: TaskView[] = []
      for (const row of rows) {
        const graph = await this.graphOf(scope, graphs, row.instance)
        const standing = this.standing(row, graph, memberOf(context), mine, at)
        if (!standing.responsible && view === 'pending') continue
        views.push(this.present(row, graph, standing, at, memberOf(context)))
      }
      return views
    }, context)
  }

  async get(context: TenantContext, id: string): Promise<TaskView> {
    const at = this.clock()
    return this.uow.run(async (scope) => {
      const row = await this.tasks.findWithInstance(scope, id)
      if (!row) throw ApiError.notFound()
      const mine = await this.reach(scope, memberOf(context), at)
      const graph = await this.graphOf(scope, new Map(), row.instance)
      const standing = this.standing(row, graph, memberOf(context), mine, at)
      if (!standing.responsible && !this.involved(row.task, memberOf(context))) {
        throw ApiError.notFound()
      }
      return this.present(row, graph, standing, at, memberOf(context))
    }, context)
  }

  /** Reclama atomicamente uma tarefa de grupo: só um dos candidatos a obtém. */
  async claim(context: TenantContext, id: string): Promise<TaskView> {
    const at = this.clock()
    await this.assertMayDecide(context, id)
    await this.uow.run(async (scope) => {
      const row = await this.tasks.findWithInstance(scope, id)
      if (!row) throw ApiError.notFound()
      const mine = await this.reach(scope, memberOf(context), at)
      const graph = await this.graphOf(scope, new Map(), row.instance)
      const standing = this.standing(row, graph, memberOf(context), mine, at)
      if (!standing.responsible) throw ApiError.notFound()
      if (row.task.candidateRoleId === null) {
        throw ApiError.conflict(
          'TASK_NOT_CLAIMABLE',
          'Só se reclamam tarefas de grupo: esta está atribuída a uma pessoa.'
        )
      }
      if (row.task.status === 'CLAIMED' && row.task.claimedByMembershipId === memberOf(context)) {
        return // repetir a reclamação não tem efeitos
      }
      this.assertAllowed(standing)
      await this.assertActiveStage(scope, row.instance, row.task)
      await this.assertFirstTaskOfStage(scope, row.task, memberOf(context))
      const claimed = await this.tasks.claim(scope, row.task, memberOf(context))
      if (!claimed) {
        throw ApiError.conflict(
          'TASK_NOT_OPEN',
          'A tarefa já foi reclamada por outra pessoa ou já não está por decidir.'
        )
      }
    }, context)
    return this.get(context, id)
  }

  async decide(
    context: TenantContext,
    id: string,
    action: TaskAction,
    input: { reason?: string | null }
  ): Promise<TaskView & { idempotent: boolean }> {
    const reason = input.reason?.trim() || null
    if (reason && reason.length > MAX_REASON) {
      throw this.invalid('INVALID_REASON', `O motivo tem no máximo ${MAX_REASON} caracteres.`)
    }
    if (action !== 'approve' && !reason) {
      throw this.invalid('REASON_REQUIRED', 'Indique o motivo.')
    }
    await this.assertMayDecide(context, id)
    const at = this.clock()
    const idempotent = await this.uow.run(async (scope) => {
      const first = await this.tasks.find(scope, id)
      if (!first) throw ApiError.notFound()
      // Ordem de bloqueios: instância, depois tarefa (igual em todo o módulo).
      const instance = await this.instances.lock(scope, first.instanceId)
      const task = await this.tasks.lock(scope, id)
      if (!instance || !task) throw ApiError.notFound()
      const row: InboxRow = { task, instance }
      const mine = await this.reach(scope, memberOf(context), at)
      const graph = await this.graphOf(scope, new Map(), instance)
      const standing = this.standing(row, graph, memberOf(context), mine, at)
      if (!standing.responsible && !this.involved(task, memberOf(context))) {
        throw ApiError.notFound()
      }
      // Repetir a mesma decisão é idempotente: devolve o resultado sem novos efeitos.
      if (task.status === TERMINAL[action] && task.decidedByMembershipId === memberOf(context)) {
        return true
      }
      if (task.status === 'APPROVED' || task.status === 'REJECTED' || task.status === 'RETURNED') {
        throw ApiError.conflict('TASK_ALREADY_DECIDED', 'A tarefa já foi decidida.')
      }
      if (
        task.status === 'CANCELLED' ||
        (instance.status !== 'WAITING' && instance.status !== 'RUNNING')
      ) {
        throw ApiError.conflict('TASK_NOT_OPEN', 'A tarefa já não está por decidir.')
      }
      this.assertAllowed(standing)
      await this.assertActiveStage(scope, instance, task)
      if (task.candidateRoleId !== null) {
        if (task.status !== 'CLAIMED') {
          throw ApiError.conflict('TASK_NOT_CLAIMED', 'Reclame a tarefa antes de a decidir.')
        }
        if (task.claimedByMembershipId !== memberOf(context)) {
          throw ApiError.conflict(
            'TASK_CLAIMED_BY_OTHER',
            'A tarefa foi reclamada por outra pessoa.'
          )
        }
      } else {
        await this.assertFirstTaskOfStage(scope, task, memberOf(context))
      }
      await this.tasks.decide(scope, task, {
        status: TERMINAL[action],
        membershipId: memberOf(context),
        viaDelegationId: standing.delegationId,
        reason,
      })
      await this.advance(scope, context, instance, graph as WorkflowGraph, task, action)
      return false
    }, context)
    return { ...(await this.get(context, id)), idempotent }
  }

  // --- avanço --------------------------------------------------------------------------------

  private async advance(
    scope: TenantScope,
    context: TenantContext,
    instance: WorkflowInstance,
    graph: WorkflowGraph,
    task: WorkflowTask,
    action: TaskAction
  ) {
    if (action === 'return') {
      await this.flow.finish(scope, context, instance, 'CANCELLED', 'RETURNED', 'returned')
      return
    }
    const stage = graph.stages[task.stageIndex] as StageDef
    const allTasks = await this.tasks.byInstance(scope, instance.id)
    const stageTasks = allTasks.filter((t) => t.stageIndex === task.stageIndex)
    const outcome = stageOutcome(
      stage.criteria,
      stage.quorum,
      stageTasks.map((t) => t.status)
    )
    if (outcome === 'PENDING') return
    if (outcome === 'REJECTED') {
      await this.flow.finish(scope, context, instance, 'REJECTED', 'REJECTED', 'rejected')
      return
    }
    // Etapa aprovada: as tarefas que sobram (ANY/QUORUM) fecham-se e passa-se à seguinte.
    await this.tasks.cancelPending(scope, instance.id, task.stageIndex)
    const next = await this.flow.open(scope, instance, graph, task.stageIndex + 1)
    if (next.opened) return
    if (next.failure) {
      await this.flow.finish(scope, context, instance, 'FAILED', next.failure, 'failed')
      return
    }
    await this.flow.finish(scope, context, instance, 'APPROVED', 'APPROVED', 'approved')
  }

  // --- quem pode o quê ---------------------------------------------------------------------------

  /** `approval.decide` com a entidade da tarefa como atributo (ABAC). */
  private async assertMayDecide(context: TenantContext, taskId: string) {
    const entityCode = await this.uow.run(async (scope) => {
      const row = await this.tasks.findWithInstance(scope, taskId)
      return row?.instance.entityCode ?? null
    }, context)
    if (!entityCode) throw ApiError.notFound()
    if (!(await this.access.allowed(context, DECIDE_PERMISSION, { entity: entityCode }))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
    }
  }

  private assertAllowed(standing: Standing) {
    if (standing.allowed) return
    throw new ApiError(403, 'TASK_NOT_ALLOWED', standing.reason ?? 'Não pode decidir esta tarefa.')
  }

  /** Só se decide a tarefa da etapa em curso (as de etapas anteriores já estão fechadas). */
  private async assertActiveStage(
    scope: TenantScope,
    instance: WorkflowInstance,
    task: WorkflowTask
  ) {
    const current = (await this.instances.find(scope, instance.id)) as WorkflowInstance
    if (current.currentStageIndex !== task.stageIndex) {
      throw ApiError.conflict('TASK_NOT_OPEN', 'A tarefa já não pertence à etapa em curso.')
    }
  }

  /** Ninguém trata duas tarefas da mesma etapa: um quórum não se cumpre sozinho. */
  private async assertFirstTaskOfStage(
    scope: TenantScope,
    task: WorkflowTask,
    membershipId: string
  ) {
    const siblings = await this.tasks.byInstance(scope, task.instanceId)
    const clash = siblings.some(
      (t) =>
        t.id !== task.id &&
        t.stageIndex === task.stageIndex &&
        (t.decidedByMembershipId === membershipId ||
          (t.status === 'CLAIMED' && t.claimedByMembershipId === membershipId))
    )
    if (clash) {
      throw ApiError.conflict(
        'ALREADY_ACTED_IN_STAGE',
        'Já tratou outra tarefa desta etapa: cada pessoa decide uma só vez por etapa.'
      )
    }
  }

  private involved(task: WorkflowTask, membershipId: string): boolean {
    return (
      task.assigneeMembershipId === membershipId ||
      task.claimedByMembershipId === membershipId ||
      task.decidedByMembershipId === membershipId
    )
  }

  /** A quem o utilizador "alcança": ele próprio e quem lhe delegou, com os respectivos papéis. */
  private async reach(scope: TenantScope, membershipId: string, at: Date): Promise<Reach> {
    const roles = await this.directory.rolesOf(scope, membershipId, at)
    const delegations = await this.delegations.activeTo(scope, membershipId, at)
    const roleIds = new Set(roles)
    const delegatorRoles = new Map<string, Set<string>>()
    for (const d of delegations) {
      if (!(await this.directory.isActive(scope, d.fromMembershipId))) continue
      const theirs = await this.directory.rolesOf(scope, d.fromMembershipId, at)
      delegatorRoles.set(d.fromMembershipId, theirs)
      for (const r of theirs) roleIds.add(r)
    }
    return {
      roles,
      delegations,
      delegatorRoles,
      assigneeIds: [membershipId, ...delegations.map((d) => d.fromMembershipId)],
      roleIds: [...roleIds],
    }
  }

  private async graphOf(
    scope: TenantScope,
    cache: Map<string, WorkflowGraph | null>,
    instance: WorkflowInstance
  ): Promise<WorkflowGraph | null> {
    if (!cache.has(instance.workflowDefinitionId)) {
      const definition = await this.workflows.find(scope, instance.workflowDefinitionId)
      cache.set(instance.workflowDefinitionId, definition?.graph ?? null)
    }
    return cache.get(instance.workflowDefinitionId) ?? null
  }

  /**
   * A posição do utilizador face à tarefa. Directo (responsável ou titular do papel) ou por uma delegação em vigor que
   * cubra o workflow e o montante. Quem submeteu fica de fora salvo se a etapa o permitir — também quando age por
   * delegação de quem submeteu.
   */
  private standing(
    row: InboxRow,
    graph: WorkflowGraph | null,
    me: string,
    mine: Reach,
    at: Date
  ): Standing {
    const { task, instance } = row
    const stage = graph?.stages[task.stageIndex]
    const direct =
      task.assigneeMembershipId === me ||
      (task.candidateRoleId !== null && mine.roles.has(task.candidateRoleId))
    const none: Standing = { responsible: false, allowed: false, delegationId: null, reason: null }
    if (!stage) return none

    const selfBlocked = (who: string) =>
      !stage.allowSelfApproval && who === instance.submittedByMembershipId
    if (direct) {
      if (selfBlocked(me)) {
        return {
          responsible: true,
          allowed: false,
          delegationId: null,
          reason: 'Quem submeteu o pedido não o pode decidir.',
        }
      }
      return { responsible: true, allowed: true, delegationId: null, reason: null }
    }

    let blocked: string | null = null
    for (const d of mine.delegations) {
      const covers =
        task.assigneeMembershipId === d.fromMembershipId ||
        (task.candidateRoleId !== null &&
          mine.delegatorRoles.get(d.fromMembershipId)?.has(task.candidateRoleId))
      if (!covers) continue
      const limit = this.delegationLimit(d, instance, graph, at)
      if (limit) {
        blocked ??= limit
        continue
      }
      if (selfBlocked(d.fromMembershipId) || selfBlocked(me)) {
        blocked ??= 'Quem submeteu o pedido não o pode decidir, nem por delegação.'
        continue
      }
      return { responsible: true, allowed: true, delegationId: d.id, reason: null }
    }
    if (blocked) return { responsible: true, allowed: false, delegationId: null, reason: blocked }
    return none
  }

  /** `null` se a delegação cobre este processo; senão, porque não. A menor alçada prevalece. */
  private delegationLimit(
    d: Delegation,
    instance: WorkflowInstance,
    graph: WorkflowGraph | null,
    at: Date
  ): string | null {
    if (d.revokedAt || d.validFrom > at || d.validUntil <= at)
      return 'A delegação não está em vigor.'
    const codes = d.scope.workflowCodes
    if (codes && codes.length > 0 && !codes.includes(instance.workflowCode)) {
      return 'A delegação não abrange este workflow.'
    }
    if (d.maxAmount === null) return null
    const { amount, currency } = this.amountOf(instance, graph)
    if (amount === null || currency === null || currency !== d.currency) {
      return 'A delegação tem um montante máximo e o pedido não o declara na mesma moeda.'
    }
    const cmp = compareDecimals(amount, d.maxAmount)
    return cmp !== null && cmp <= 0 ? null : 'O montante excede o máximo da delegação.'
  }

  private amountOf(instance: WorkflowInstance, graph: WorkflowGraph | null) {
    const value = graph?.amountField ? instance.snapshot[graph.amountField] : undefined
    const code = graph?.currencyField ? instance.snapshot[graph.currencyField] : undefined
    return {
      amount: typeof value === 'string' ? value : null,
      currency: typeof code === 'string' ? code : null,
    }
  }

  private present(
    row: InboxRow,
    graph: WorkflowGraph | null,
    standing: Standing,
    at: Date,
    me: string
  ): TaskView {
    const { task, instance } = row
    const stage = graph?.stages[task.stageIndex]
    const pending = task.status === 'OPEN' || task.status === 'CLAIMED'
    const { amount, currency } = this.amountOf(instance, graph)
    const isGroup = task.candidateRoleId !== null
    return {
      task,
      workflow: {
        code: instance.workflowCode,
        name: instance.workflowName,
        revision: instance.workflowRevision,
      },
      entityCode: instance.entityCode,
      recordId: instance.recordId,
      resourceVersion: instance.resourceVersion,
      submittedByMembershipId: instance.submittedByMembershipId,
      stage: {
        code: task.stageCode,
        label: stage?.label ?? task.stageCode,
        criteria: stage?.criteria ?? 'ALL',
      },
      amount,
      currency,
      overdue: pending && task.dueAt !== null && task.dueAt < at,
      can: {
        claim: pending && standing.allowed && isGroup && task.status === 'OPEN',
        decide:
          pending &&
          standing.allowed &&
          (isGroup ? task.status === 'CLAIMED' && task.claimedByMembershipId === me : true),
      },
      delegated: standing.delegationId !== null,
    }
  }

  private invalid(code: string, message: string) {
    return new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
      { path: 'reason', code, message },
    ])
  }
}
