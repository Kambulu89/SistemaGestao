import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  MachineIssue,
  MachineStatus,
  StateDef,
  TransitionDef,
} from '#dynamic/states/domain/state_machine'

export interface Machine {
  id: string
  entityDefinitionId: string
  entityCode: string
  code: string
  name: string
  description: string | null
  revision: number
  status: MachineStatus
  states: StateDef[]
  transitions: TransitionDef[]
  initialStateCode: string
  publishedAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface MachineValues {
  entityDefinitionId: string
  code: string
  name: string
  description: string | null
  states: StateDef[]
  transitions: TransitionDef[]
}

export interface MachineView extends Machine {
  /** Problemas que o servidor verifica agora contra a entidade (só nas publicadas; vazio = utilizável). */
  issues: MachineIssue[]
}

export interface MachineStore {
  list(
    scope: TenantScope,
    filter: { entityDefinitionId?: string; status?: MachineStatus }
  ): Promise<Machine[]>
  find(scope: TenantScope, id: string): Promise<Machine | null>
  latest(scope: TenantScope, entityDefinitionId: string, code: string): Promise<Machine | null>
  /** `null` se já existe um rascunho ou a revisão pedida. */
  insert(scope: TenantScope, values: MachineValues & { revision: number }): Promise<Machine | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<MachineValues, 'entityDefinitionId' | 'code'>>
  ): Promise<Machine>
  /** Retira a revisão em vigor da entidade e publica esta, numa só operação. */
  publish(scope: TenantScope, machine: Machine, expectedVersion: number): Promise<Machine>
  retire(scope: TenantScope, id: string, expectedVersion: number): Promise<Machine>
  findPublishedForEntity(scope: TenantScope, entityDefinitionId: string): Promise<Machine | null>
}

export interface RecordStateRow {
  id: string
  entityDefinitionId: string
  recordId: string
  machineId: string
  stateCode: string
  /** Versão de concorrência do estado. */
  version: number
}

export interface HistoryRow {
  entityDefinitionId: string
  recordId: string
  machineId: string
  transitionCode: string | null
  fromState: string | null
  toState: string
  actorMembershipId: string | null
  reason: string | null
  correlationId: string | null
}

export interface StateHistoryEntry extends HistoryRow {
  id: string
  occurredAt: Date
}

export interface RecordStateStore {
  insert(scope: TenantScope, row: Omit<RecordStateRow, 'id' | 'version'>): Promise<RecordStateRow>
  find(scope: TenantScope, recordId: string): Promise<RecordStateRow | null>
  /** Lê com bloqueio até ao fim da transacção: duas transições do mesmo registo não correm ao mesmo tempo. */
  lock(scope: TenantScope, recordId: string): Promise<RecordStateRow | null>
  findMany(scope: TenantScope, recordIds: readonly string[]): Promise<RecordStateRow[]>
  /** Muda o estado e a versão; devolve a nova linha. */
  move(
    scope: TenantScope,
    row: RecordStateRow,
    machineId: string,
    stateCode: string
  ): Promise<RecordStateRow>
  /** Códigos de estado em uso por registos da entidade (para não retirar um estado com registos). */
  codesInUse(scope: TenantScope, entityDefinitionId: string): Promise<Set<string>>
  insertHistory(scope: TenantScope, row: HistoryRow): Promise<void>
  history(scope: TenantScope, recordId: string): Promise<StateHistoryEntry[]>
  machinesByIds(scope: TenantScope, ids: readonly string[]): Promise<Map<string, Machine>>
}

export interface StateTarget {
  id: string
  code: string
  published: boolean
  ownershipMode: 'TENANT' | 'UNIT' | 'OWNER'
  /** Códigos dos campos activos e não sensíveis (os que uma guarda pode ler). */
  readableFields: ReadonlySet<string>
}

/** Entidades dinâmicas (módulo de metadados) vistas pelas máquinas de estados. */
export interface StateTargets {
  findByCode(context: TenantContext, code: string): Promise<StateTarget | null>
  findById(context: TenantContext, id: string): Promise<StateTarget | null>
}

/** O registo, tal como o módulo de metadados o mostra a quem o pode ler (sem campos escondidos nem sensíveis). */
export interface RecordSnapshot {
  id: string
  data: Record<string, unknown>
  ownerMembershipId: string | null
  organizationUnitId: string | null
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
  validate(condition: unknown): MachineIssue[]
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
