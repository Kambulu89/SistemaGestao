import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  DelegationScope,
  TaskStatus,
  WorkflowGraph,
  WorkflowIssue,
  WorkflowStatus,
} from '#dynamic/workflows/domain/workflow'

export interface WorkflowDefinition {
  id: string
  entityDefinitionId: string
  entityCode: string
  code: string
  name: string
  description: string | null
  revision: number
  status: WorkflowStatus
  graph: WorkflowGraph
  publishedAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface WorkflowValues {
  entityDefinitionId: string
  code: string
  name: string
  description: string | null
  graph: WorkflowGraph
}

export interface WorkflowView extends WorkflowDefinition {
  /** Problemas que o servidor verifica agora (só nas publicadas; vazio = utilizável). */
  issues: WorkflowIssue[]
}

export interface WorkflowStore {
  list(
    scope: TenantScope,
    filter: { entityDefinitionId?: string; status?: WorkflowStatus }
  ): Promise<WorkflowDefinition[]>
  find(scope: TenantScope, id: string): Promise<WorkflowDefinition | null>
  latest(
    scope: TenantScope,
    entityDefinitionId: string,
    code: string
  ): Promise<WorkflowDefinition | null>
  /** `null` se já existe um rascunho ou a revisão pedida. */
  insert(
    scope: TenantScope,
    values: WorkflowValues & { revision: number }
  ): Promise<WorkflowDefinition | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<WorkflowValues, 'entityDefinitionId' | 'code'>>
  ): Promise<WorkflowDefinition>
  /** Retira a revisão em vigor do mesmo código e publica esta, numa só operação. */
  publish(
    scope: TenantScope,
    workflow: WorkflowDefinition,
    expectedVersion: number
  ): Promise<WorkflowDefinition>
  retire(scope: TenantScope, id: string, expectedVersion: number): Promise<WorkflowDefinition>
  findPublished(
    scope: TenantScope,
    entityDefinitionId: string,
    code: string
  ): Promise<WorkflowDefinition | null>
}

export type InstanceStatus =
  'RUNNING' | 'WAITING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'FAILED'
export type EndReason =
  | 'APPROVED'
  | 'REJECTED'
  | 'RETURNED'
  | 'CANCELLED_BY_SUBMITTER'
  | 'RESOURCE_CHANGED'
  | 'NO_APPROVER'
  | 'CONDITION_ERROR'

export interface WorkflowInstance {
  id: string
  workflowDefinitionId: string
  workflowCode: string
  workflowName: string
  workflowRevision: number
  entityDefinitionId: string
  entityCode: string
  recordId: string
  resourceVersion: number
  snapshot: Record<string, unknown>
  status: InstanceStatus
  endReason: EndReason | null
  currentStageIndex: number
  submittedByMembershipId: string
  correlationId: string | null
  startedAt: Date
  endedAt: Date | null
  version: number
}

export interface NewInstance {
  workflowDefinitionId: string
  entityDefinitionId: string
  recordId: string
  resourceVersion: number
  snapshot: Record<string, unknown>
  submittedByMembershipId: string
  correlationId: string | null
}

export interface InstanceStore {
  /** `null` se o registo já tem um processo em curso. */
  insert(scope: TenantScope, values: NewInstance): Promise<WorkflowInstance | null>
  find(scope: TenantScope, id: string): Promise<WorkflowInstance | null>
  /** Lê com bloqueio até ao fim da transacção: duas decisões da mesma instância nunca correm ao mesmo tempo. */
  lock(scope: TenantScope, id: string): Promise<WorkflowInstance | null>
  /** Instâncias em curso do registo, com bloqueio. */
  lockActiveByRecord(scope: TenantScope, recordId: string): Promise<WorkflowInstance[]>
  listByRecord(scope: TenantScope, recordId: string): Promise<WorkflowInstance[]>
  list(
    scope: TenantScope,
    filter: { status?: InstanceStatus; entityDefinitionId?: string; submittedBy?: string }
  ): Promise<WorkflowInstance[]>
  setStage(
    scope: TenantScope,
    instance: WorkflowInstance,
    stageIndex: number
  ): Promise<WorkflowInstance>
  finish(
    scope: TenantScope,
    instance: WorkflowInstance,
    status: Exclude<InstanceStatus, 'RUNNING' | 'WAITING'>,
    reason: EndReason
  ): Promise<WorkflowInstance>
}

export interface WorkflowTask {
  id: string
  instanceId: string
  stageCode: string
  stageIndex: number
  assigneeMembershipId: string | null
  candidateRoleId: string | null
  status: TaskStatus
  dueAt: Date | null
  claimedAt: Date | null
  claimedByMembershipId: string | null
  decidedByMembershipId: string | null
  viaDelegationId: string | null
  decisionReason: string | null
  decidedAt: Date | null
  version: number
}

export interface NewTask {
  instanceId: string
  stageCode: string
  stageIndex: number
  assigneeMembershipId: string | null
  candidateRoleId: string | null
  dueAt: Date | null
}

export interface TaskStore {
  insertMany(scope: TenantScope, tasks: readonly NewTask[]): Promise<WorkflowTask[]>
  find(scope: TenantScope, id: string): Promise<WorkflowTask | null>
  lock(scope: TenantScope, id: string): Promise<WorkflowTask | null>
  byInstance(scope: TenantScope, instanceId: string): Promise<WorkflowTask[]>
  /** `OPEN → CLAIMED`; `null` se a tarefa já não estava aberta. */
  claim(scope: TenantScope, task: WorkflowTask, membershipId: string): Promise<WorkflowTask | null>
  decide(
    scope: TenantScope,
    task: WorkflowTask,
    decision: {
      status: 'APPROVED' | 'REJECTED' | 'RETURNED'
      membershipId: string
      viaDelegationId: string | null
      reason: string | null
    }
  ): Promise<WorkflowTask>
  /** Cancela as tarefas ainda por decidir da instância (de uma etapa, ou de todas). */
  cancelPending(scope: TenantScope, instanceId: string, stageIndex?: number): Promise<number>
  /** Tarefas em que o utilizador (ou quem lhe delegou) é responsável, com os dados da instância. */
  inbox(
    scope: TenantScope,
    filter: {
      assigneeIds: readonly string[]
      roleIds: readonly string[]
      actorId: string
      view: 'pending' | 'decided'
    }
  ): Promise<InboxRow[]>
  findWithInstance(scope: TenantScope, id: string): Promise<InboxRow | null>
}

export interface InboxRow {
  task: WorkflowTask
  instance: WorkflowInstance
}

export interface Delegation {
  id: string
  fromMembershipId: string
  toMembershipId: string
  validFrom: Date
  validUntil: Date
  scope: DelegationScope
  maxAmount: string | null
  currency: string | null
  reason: string
  revokedAt: Date | null
  version: number
  createdAt: Date
}

export interface DelegationStore {
  insert(
    scope: TenantScope,
    values: Omit<Delegation, 'id' | 'revokedAt' | 'version' | 'createdAt'>
  ): Promise<Delegation>
  find(scope: TenantScope, id: string): Promise<Delegation | null>
  /** As delegações que o membro deu ou recebeu. */
  listFor(scope: TenantScope, membershipId: string): Promise<Delegation[]>
  /** Delegações em vigor (não revogadas, dentro do período) recebidas por `toMembershipId`. */
  activeTo(scope: TenantScope, toMembershipId: string, at: Date): Promise<Delegation[]>
  /** Todas as delegações em vigor num instante (para detectar ciclos). */
  active(scope: TenantScope, at: Date): Promise<Delegation[]>
  /** Serializa as criações de delegações do tenant até ao fim da transacção (ciclos sob concorrência). */
  lock(scope: TenantScope): Promise<void>
  revoke(scope: TenantScope, id: string, expectedVersion: number): Promise<Delegation>
}

/** Quem é quem no tenant: o módulo de membros e o de autorização, pelas suas APIs públicas. */
export interface Directory {
  isActive(scope: TenantScope, membershipId: string): Promise<boolean>
  roleExists(scope: TenantScope, roleId: string): Promise<boolean>
  /** Papéis com uma atribuição válida agora. */
  rolesOf(scope: TenantScope, membershipId: string, at: Date): Promise<Set<string>>
  /** Há pelo menos um membro activo com uma atribuição válida do papel. */
  hasActiveHolder(scope: TenantScope, roleId: string, at: Date): Promise<boolean>
}

export interface WorkflowTarget {
  id: string
  code: string
  published: boolean
  /** Campos activos e não sensíveis (os que uma condição ou o montante podem ler), por tipo. */
  readableFields: ReadonlyMap<string, string>
}

export interface WorkflowTargets {
  findByCode(context: TenantContext, code: string): Promise<WorkflowTarget | null>
  findById(context: TenantContext, id: string): Promise<WorkflowTarget | null>
}

/** O registo, tal como o módulo de metadados o mostra a quem o pode ler. */
export interface RecordSnapshot {
  id: string
  data: Record<string, unknown>
  version: number
  archived: boolean
}

export interface RecordGateway {
  get(context: TenantContext, entityCode: string, id: string): Promise<RecordSnapshot>
}

export interface AccessControl {
  allowed(
    context: TenantContext,
    permission: string,
    resource: Record<string, unknown>
  ): Promise<boolean>
}

export interface ConditionEngine {
  validate(condition: unknown): WorkflowIssue[]
  /** Lança se a condição for inválida; a aplicação trata o erro como falha fechada. */
  evaluate(
    condition: unknown,
    context: {
      subject: Record<string, unknown>
      resource: Record<string, unknown>
      env: Record<string, unknown>
    }
  ): boolean
}

export interface PermissionCatalog {
  has(code: string): boolean
}
