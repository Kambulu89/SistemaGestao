import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { StageDef, WorkflowGraph } from '#dynamic/workflows/domain/workflow'
import type {
  ConditionEngine,
  Directory,
  EndReason,
  InstanceStore,
  NewTask,
  TaskStore,
  WorkflowInstance,
} from '#dynamic/workflows/application/ports'

export type InstanceEvent = 'approved' | 'rejected' | 'returned' | 'cancelled' | 'failed'

const HOUR_MS = 3_600_000

/**
 * Avanço de um processo pelas etapas: abre as tarefas da primeira etapa aplicável e fecha o processo quando não há mais
 * nenhuma. Partilhado pela submissão e pelas decisões. **Nunca aprova por omissão**: se uma etapa não puder abrir (sem
 * responsável resolvível, condição que não se avalia), a submissão falha e uma decisão em curso leva o processo a FAILED.
 */
export class StageFlow {
  constructor(
    private readonly instances: InstanceStore,
    private readonly tasks: TaskStore,
    private readonly directory: Directory,
    private readonly engine: ConditionEngine,
    private readonly outbox: OutboxWriter,
    private readonly clock: () => Date
  ) {}

  /**
   * Abre a primeira etapa aplicável a partir de `startIndex`. Sem nenhuma, o processo está concluído (`null`);
   * devolve a etapa aberta, ou a razão pela qual nenhuma abriu.
   */
  async open(
    scope: TenantScope,
    instance: WorkflowInstance,
    graph: WorkflowGraph,
    startIndex: number
  ): Promise<{ opened: StageDef } | { opened: null; failure: EndReason | null }> {
    for (let index = startIndex; index < graph.stages.length; index++) {
      const stage = graph.stages[index] as StageDef
      let applies: boolean
      try {
        applies = this.applies(stage, instance)
      } catch {
        // Falha fechada: uma condição que não se consegue avaliar não dispensa a etapa.
        return { opened: null, failure: 'CONDITION_ERROR' }
      }
      if (!applies) continue
      const tasks = await this.tasksFor(scope, instance, stage, index)
      if (!tasks) return { opened: null, failure: 'NO_APPROVER' }
      await this.tasks.insertMany(scope, tasks)
      await this.instances.setStage(scope, instance, index)
      return { opened: stage }
    }
    return { opened: null, failure: null }
  }

  /** Fecha o processo e escreve o evento na mesma transacção. */
  async finish(
    scope: TenantScope,
    context: TenantContext | null,
    instance: WorkflowInstance,
    status: 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'FAILED',
    reason: EndReason,
    event: InstanceEvent
  ): Promise<WorkflowInstance> {
    await this.tasks.cancelPending(scope, instance.id)
    const closed = await this.instances.finish(scope, instance, status, reason)
    await this.outbox.append(scope, {
      aggregateType: 'workflow_instance',
      aggregateId: closed.id,
      aggregateVersion: closed.version,
      eventType: `workflow.instance.${event}`,
      payload: {
        instanceId: closed.id,
        workflowCode: closed.workflowCode,
        workflowRevision: closed.workflowRevision,
        entityCode: closed.entityCode,
        recordId: closed.recordId,
        resourceVersion: closed.resourceVersion,
        status: closed.status,
        endReason: reason,
        submittedByMembershipId: closed.submittedByMembershipId,
      },
      correlationId: context?.correlationId ?? closed.correlationId,
    })
    return closed
  }

  private applies(stage: StageDef, instance: WorkflowInstance): boolean {
    if (stage.condition === undefined) return true
    return this.engine.evaluate(stage.condition, {
      subject: { membershipId: instance.submittedByMembershipId },
      resource: instance.snapshot,
      env: { now: this.clock().toISOString() },
    })
  }

  /** As tarefas da etapa, ou `null` se algum responsável não for resolvível. */
  private async tasksFor(
    scope: TenantScope,
    instance: WorkflowInstance,
    stage: StageDef,
    index: number
  ): Promise<NewTask[] | null> {
    const now = this.clock()
    const dueAt =
      stage.dueInHours === undefined ? null : new Date(now.getTime() + stage.dueInHours * HOUR_MS)
    const tasks: NewTask[] = []
    for (const approver of stage.approvers) {
      if (approver.type === 'MEMBERSHIP') {
        if (!(await this.directory.isActive(scope, approver.id))) return null
        // Quem submeteu não pode ser o único a decidir a sua submissão.
        if (!stage.allowSelfApproval && approver.id === instance.submittedByMembershipId)
          return null
      } else if (
        !(await this.directory.roleExists(scope, approver.id)) ||
        !(await this.directory.hasActiveHolder(scope, approver.id, now))
      ) {
        return null
      }
      tasks.push({
        instanceId: instance.id,
        stageCode: stage.code,
        stageIndex: index,
        assigneeMembershipId: approver.type === 'MEMBERSHIP' ? approver.id : null,
        candidateRoleId: approver.type === 'ROLE' ? approver.id : null,
        dueAt,
      })
    }
    return tasks
  }
}

export const unresolvable = (failure: EndReason | null) =>
  failure === 'CONDITION_ERROR'
    ? ApiError.conflict(
        'WORKFLOW_CONDITION_ERROR',
        'Uma condição do workflow não pôde ser avaliada: o processo não foi iniciado.'
      )
    : ApiError.conflict(
        'NO_RESOLVABLE_APPROVER',
        'Algum responsável da etapa não é resolvível (membro inactivo, papel sem titulares ou a própria pessoa que submete): o processo não foi iniciado.'
      )
