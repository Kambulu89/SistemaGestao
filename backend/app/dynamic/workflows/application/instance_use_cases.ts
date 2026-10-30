import { ApiError } from '#core/http/api_error'
import { memberOf } from '#dynamic/workflows/application/actor'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { StageFlow, unresolvable } from '#dynamic/workflows/application/flow'
import type {
  AccessControl,
  ConditionEngine,
  Directory,
  InstanceStatus,
  InstanceStore,
  RecordGateway,
  TaskStore,
  WorkflowInstance,
  WorkflowStore,
  WorkflowTargets,
  WorkflowTask,
} from '#dynamic/workflows/application/ports'

export const SUBMIT_PERMISSION = 'workflow.submit'
export const READ_PERMISSION = 'workflow.read'

export interface SubmittableWorkflow {
  code: string
  name: string
  revision: number
  stages: { code: string; label: string }[]
}

export interface InstanceDetail {
  instance: WorkflowInstance
  tasks: WorkflowTask[]
}

/**
 * Submeter, consultar e cancelar processos de aprovação (C14). Submeter congela o registo (valores e versão) e a revisão
 * publicada do workflow; um registo só tem um processo em curso. Alterar o registo cancela o processo (hook nas escritas
 * dos registos), por isso uma aprovação nunca vale para valores que ela não viu.
 */
export class InstanceUseCases {
  private readonly flow: StageFlow

  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly workflows: WorkflowStore,
    private readonly instances: InstanceStore,
    private readonly tasks: TaskStore,
    private readonly targets: WorkflowTargets,
    private readonly records: RecordGateway,
    private readonly access: AccessControl,
    directory: Directory,
    engine: ConditionEngine,
    outbox: OutboxWriter,
    clock: () => Date = () => new Date()
  ) {
    this.flow = new StageFlow(instances, tasks, directory, engine, outbox, clock)
  }

  async submit(
    context: TenantContext,
    input: { entityCode: string; workflowCode: string; recordId: string }
  ): Promise<InstanceDetail> {
    const target = await this.targets.findByCode(context, input.entityCode)
    if (!target) throw ApiError.notFound()
    // Um registo inexistente, alheio ou que não pode ler é sempre 404.
    const record = await this.records.get(context, input.entityCode, input.recordId)
    if (!(await this.access.allowed(context, SUBMIT_PERMISSION, { entity: target.code }))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
    }
    if (record.archived) throw ApiError.conflict('RECORD_ARCHIVED', 'O registo está arquivado.')

    return this.uow.run(async (scope) => {
      const definition = await this.workflows.findPublished(scope, target.id, input.workflowCode)
      if (!definition) {
        throw ApiError.conflict(
          'WORKFLOW_NOT_PUBLISHED',
          `Não há um workflow «${input.workflowCode}» publicado para esta entidade.`
        )
      }
      // O registo pode ter mudado entre a primeira leitura e agora: congela-se o que se vê aqui.
      const current = await this.records.get(context, input.entityCode, input.recordId)
      const instance = await this.instances.insert(scope, {
        workflowDefinitionId: definition.id,
        entityDefinitionId: target.id,
        recordId: input.recordId,
        resourceVersion: current.version,
        snapshot: current.data,
        submittedByMembershipId: memberOf(context),
        correlationId: context.correlationId,
      })
      if (!instance) {
        throw ApiError.conflict(
          'WORKFLOW_ALREADY_RUNNING',
          'Este registo já tem um processo de aprovação em curso.'
        )
      }
      const opened = await this.flow.open(scope, instance, definition.graph, 0)
      if (!opened.opened) {
        if (opened.failure) throw unresolvable(opened.failure)
        throw ApiError.conflict(
          'NO_APPLICABLE_STAGE',
          'Nenhuma etapa do workflow se aplica a este registo: não há nada a aprovar.'
        )
      }
      return this.detail(scope, instance.id)
    }, context)
  }

  /** Os workflows publicados a que se pode submeter um registo da entidade (sem os responsáveis). */
  async submittable(context: TenantContext, entityCode: string): Promise<SubmittableWorkflow[]> {
    const target = await this.targets.findByCode(context, entityCode)
    if (!target) throw ApiError.notFound()
    const published = await this.uow.run(
      (scope) => this.workflows.list(scope, { entityDefinitionId: target.id, status: 'PUBLISHED' }),
      context
    )
    return published.map((w) => ({
      code: w.code,
      name: w.name,
      revision: w.revision,
      stages: w.graph.stages.map((st) => ({ code: st.code, label: st.label })),
    }))
  }

  async get(context: TenantContext, id: string): Promise<InstanceDetail> {
    // Quem não tem nenhuma das permissões do circuito (ler, submeter ou decidir) nem sequer pergunta: 403.
    const standing = await this.standingFor(context)
    if (!standing.any) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
    }
    const detail = await this.uow.run(async (scope) => {
      const found = await this.instances.find(scope, id)
      if (!found) throw ApiError.notFound()
      return this.detail(scope, id)
    }, context)
    if (!(await this.canView(context, detail))) throw ApiError.notFound()
    return detail
  }

  async list(
    context: TenantContext,
    filter: { status?: InstanceStatus; entityCode?: string; mine?: boolean }
  ): Promise<WorkflowInstance[]> {
    let entityDefinitionId: string | undefined
    if (filter.entityCode) {
      const target = await this.targets.findByCode(context, filter.entityCode)
      if (!target) return []
      entityDefinitionId = target.id
    }
    return this.uow.run(
      (scope) =>
        this.instances.list(scope, {
          status: filter.status,
          entityDefinitionId,
          submittedBy: filter.mine ? memberOf(context) : undefined,
        }),
      context
    )
  }

  /** Os processos de um registo (o utilizador tem de poder lê-lo). */
  async forRecord(
    context: TenantContext,
    entityCode: string,
    recordId: string
  ): Promise<WorkflowInstance[]> {
    await this.records.get(context, entityCode, recordId)
    return this.uow.run((scope) => this.instances.listByRecord(scope, recordId), context)
  }

  /** Quem submeteu cancela o seu processo; as tarefas por decidir ficam canceladas. */
  async cancel(context: TenantContext, id: string): Promise<InstanceDetail> {
    return this.uow.run(async (scope) => {
      const instance = await this.instances.lock(scope, id)
      if (!instance || instance.submittedByMembershipId !== memberOf(context)) {
        throw ApiError.notFound()
      }
      this.assertActive(instance)
      await this.flow.finish(
        scope,
        context,
        instance,
        'CANCELLED',
        'CANCELLED_BY_SUBMITTER',
        'cancelled'
      )
      return this.detail(scope, id)
    }, context)
  }

  /**
   * Chamado na transacção que altera ou arquiva um registo: o processo em curso deixa de valer (os valores já não são os
   * que foram submetidos) e as tarefas por decidir ficam canceladas. Uma nova submissão recomeça a aprovação.
   */
  async onRecordChanged(scope: TenantScope, recordId: string): Promise<void> {
    const active = await this.instances.lockActiveByRecord(scope, recordId)
    for (const instance of active) {
      await this.flow.finish(scope, null, instance, 'CANCELLED', 'RESOURCE_CHANGED', 'cancelled')
    }
  }

  // --- internos ------------------------------------------------------------------------------

  private assertActive(instance: WorkflowInstance) {
    if (instance.status !== 'WAITING' && instance.status !== 'RUNNING') {
      throw ApiError.conflict('INSTANCE_NOT_ACTIVE', 'O processo já terminou.')
    }
  }

  private async detail(scope: TenantScope, id: string): Promise<InstanceDetail> {
    const instance = (await this.instances.find(scope, id)) as WorkflowInstance
    return { instance, tasks: await this.tasks.byInstance(scope, id) }
  }

  private async standingFor(context: TenantContext): Promise<{ any: boolean }> {
    for (const permission of [READ_PERMISSION, SUBMIT_PERMISSION, 'approval.decide']) {
      if (await this.access.allowed(context, permission, {})) return { any: true }
    }
    return { any: false }
  }

  /** Quem submeteu, quem lê workflows ou quem tem (ou teve) uma tarefa do processo. */
  private async canView(context: TenantContext, detail: InstanceDetail): Promise<boolean> {
    if (detail.instance.submittedByMembershipId === memberOf(context)) return true
    if (
      detail.tasks.some(
        (t) =>
          t.assigneeMembershipId === memberOf(context) ||
          t.claimedByMembershipId === memberOf(context) ||
          t.decidedByMembershipId === memberOf(context)
      )
    ) {
      return true
    }
    return this.access.allowed(context, READ_PERMISSION, { entity: detail.instance.entityCode })
  }
}
