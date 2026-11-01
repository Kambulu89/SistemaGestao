import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { TaskStatus, WorkflowGraph, WorkflowStatus } from '#dynamic/workflows/domain/workflow'
import type {
  Delegation,
  DelegationStore,
  EndReason,
  InboxRow,
  InstanceStatus,
  InstanceStore,
  NewInstance,
  NewTask,
  TaskStore,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowStore,
  WorkflowTask,
  WorkflowValues,
} from '#dynamic/workflows/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never
const json = (value: unknown) => JSON.stringify(value)

// --- definições ---------------------------------------------------------------------------------

interface DefinitionRow {
  id: string
  entity_definition_id: string
  entity_code: string
  code: string
  name: string
  description: string | null
  revision: number
  status: WorkflowStatus
  graph: WorkflowGraph
  published_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

const DEFINITION_SELECT = `select w.id, w.entity_definition_id, e.code as entity_code, w.code, w.name, w.description,
  w.revision, w.status, w.graph, w.published_at, w.version, w.created_at, w.updated_at
  from workflow_definitions w
  join entity_definitions e on e.tenant_id = w.tenant_id and e.id = w.entity_definition_id`

const toDefinition = (r: DefinitionRow): WorkflowDefinition => ({
  id: r.id,
  entityDefinitionId: r.entity_definition_id,
  entityCode: r.entity_code,
  code: r.code,
  name: r.name,
  description: r.description,
  revision: r.revision,
  status: r.status,
  graph: r.graph,
  publishedAt: r.published_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidWorkflowStore implements WorkflowStore {
  async list(scope: TenantScope, filter: { entityDefinitionId?: string; status?: WorkflowStatus }) {
    const where = ['w.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.entityDefinitionId) {
      where.push('w.entity_definition_id = ?')
      params.push(filter.entityDefinitionId)
    }
    if (filter.status) {
      where.push('w.status = ?')
      params.push(filter.status)
    }
    const result = await trxOf(scope).rawQuery(
      `${DEFINITION_SELECT} where ${where.join(' and ')} order by e.code, w.code, w.revision desc`,
      params as never[]
    )
    return (result.rows as DefinitionRow[]).map(toDefinition)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `${DEFINITION_SELECT} where w.tenant_id = ? and w.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as DefinitionRow[]
    return row ? toDefinition(row) : null
  }

  async latest(scope: TenantScope, entityDefinitionId: string, code: string) {
    const result = await trxOf(scope).rawQuery(
      `${DEFINITION_SELECT} where w.tenant_id = ? and w.entity_definition_id = ? and w.code = ?
        order by w.revision desc limit 1`,
      [tenantOf(scope), entityDefinitionId, code]
    )
    const [row] = result.rows as DefinitionRow[]
    return row ? toDefinition(row) : null
  }

  async insert(scope: TenantScope, v: WorkflowValues & { revision: number }) {
    const result = await trxOf(scope).rawQuery(
      `insert into workflow_definitions
         (tenant_id, entity_definition_id, code, name, description, revision, graph,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tenantOf(scope),
        v.entityDefinitionId,
        v.code,
        v.name,
        v.description as never,
        v.revision,
        json(v.graph),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<WorkflowValues, 'entityDefinitionId' | 'code'>>
  ) {
    const columns: [string, unknown, boolean][] = [
      ['name', patch.name, false],
      ['description', patch.description, false],
      ['graph', patch.graph === undefined ? undefined : json(patch.graph), true],
    ]
    const entries = columns.filter(([, value]) => value !== undefined)
    const sets = entries
      .map(([column, , asJson]) => `"${column}" = ?${asJson ? '::jsonb' : ''}`)
      .join(', ')
    const result = await trxOf(scope).rawQuery(
      `update workflow_definitions
          set ${sets}${sets ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'DRAFT'
        returning id`,
      [...entries.map(([, v]) => v as never), actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async publish(scope: TenantScope, workflow: WorkflowDefinition, expectedVersion: number) {
    await trxOf(scope).rawQuery(
      `update workflow_definitions set status = 'RETIRED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and entity_definition_id = ? and code = ? and status = 'PUBLISHED'`,
      [actorOf(scope), tenantOf(scope), workflow.entityDefinitionId, workflow.code]
    )
    const result = await trxOf(scope).rawQuery(
      `update workflow_definitions
          set status = 'PUBLISHED', published_at = now(), published_by_membership_id = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'DRAFT'
        returning id`,
      [actorOf(scope), actorOf(scope), tenantOf(scope), workflow.id, expectedVersion]
    )
    return this.afterWrite(scope, workflow.id, result.rows.length > 0)
  }

  async retire(scope: TenantScope, id: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update workflow_definitions set status = 'RETIRED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'PUBLISHED'
        returning id`,
      [actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async findPublished(scope: TenantScope, entityDefinitionId: string, code: string) {
    const result = await trxOf(scope).rawQuery(
      `${DEFINITION_SELECT} where w.tenant_id = ? and w.entity_definition_id = ? and w.code = ?
          and w.status = 'PUBLISHED'`,
      [tenantOf(scope), entityDefinitionId, code]
    )
    const [row] = result.rows as DefinitionRow[]
    return row ? toDefinition(row) : null
  }

  private async afterWrite(scope: TenantScope, id: string, written: boolean) {
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (!written) throw ApiError.versionConflict(row.version)
    return row
  }
}

// --- instâncias ---------------------------------------------------------------------------------

interface InstanceRow {
  id: string
  workflow_definition_id: string
  workflow_code: string
  workflow_name: string
  workflow_revision: number
  entity_definition_id: string
  entity_code: string
  record_id: string
  resource_version: number
  submitted_snapshot: Record<string, unknown>
  status: InstanceStatus
  end_reason: EndReason | null
  current_stage_index: number
  submitted_by_membership_id: string
  correlation_id: string | null
  started_at: Date
  ended_at: Date | null
  version: number
}

const INSTANCE_SELECT = `select i.id, i.workflow_definition_id, w.code as workflow_code, w.name as workflow_name,
  w.revision as workflow_revision, i.entity_definition_id, e.code as entity_code, i.record_id, i.resource_version,
  i.submitted_snapshot, i.status, i.end_reason, i.current_stage_index, i.submitted_by_membership_id,
  i.correlation_id, i.started_at, i.ended_at, i.version
  from workflow_instances i
  join workflow_definitions w on w.tenant_id = i.tenant_id and w.id = i.workflow_definition_id
  join entity_definitions e on e.tenant_id = i.tenant_id and e.id = i.entity_definition_id`

const toInstance = (r: InstanceRow): WorkflowInstance => ({
  id: r.id,
  workflowDefinitionId: r.workflow_definition_id,
  workflowCode: r.workflow_code,
  workflowName: r.workflow_name,
  workflowRevision: r.workflow_revision,
  entityDefinitionId: r.entity_definition_id,
  entityCode: r.entity_code,
  recordId: r.record_id,
  resourceVersion: r.resource_version,
  snapshot: r.submitted_snapshot,
  status: r.status,
  endReason: r.end_reason,
  currentStageIndex: r.current_stage_index,
  submittedByMembershipId: r.submitted_by_membership_id,
  correlationId: r.correlation_id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  version: r.version,
})

export class LucidInstanceStore implements InstanceStore {
  async insert(scope: TenantScope, v: NewInstance) {
    const result = await trxOf(scope).rawQuery(
      `insert into workflow_instances
         (tenant_id, workflow_definition_id, entity_definition_id, record_id, resource_version, submitted_snapshot,
          submitted_by_membership_id, correlation_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tenantOf(scope),
        v.workflowDefinitionId,
        v.entityDefinitionId,
        v.recordId,
        v.resourceVersion,
        json(v.snapshot),
        v.submittedByMembershipId,
        v.correlationId as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `${INSTANCE_SELECT} where i.tenant_id = ? and i.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as InstanceRow[]
    return row ? toInstance(row) : null
  }

  async lock(scope: TenantScope, id: string) {
    // `for update of i`: bloqueia só a instância (as definições e entidades juntas são imutáveis para este efeito).
    const result = await trxOf(scope).rawQuery(
      `${INSTANCE_SELECT} where i.tenant_id = ? and i.id = ? for update of i`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as InstanceRow[]
    return row ? toInstance(row) : null
  }

  async lockActiveByRecord(scope: TenantScope, recordId: string) {
    const result = await trxOf(scope).rawQuery(
      `${INSTANCE_SELECT} where i.tenant_id = ? and i.record_id = ? and i.status in ('RUNNING', 'WAITING')
        order by i.started_at for update of i`,
      [tenantOf(scope), recordId]
    )
    return (result.rows as InstanceRow[]).map(toInstance)
  }

  async listByRecord(scope: TenantScope, recordId: string) {
    const result = await trxOf(scope).rawQuery(
      `${INSTANCE_SELECT} where i.tenant_id = ? and i.record_id = ? order by i.started_at desc, i.id`,
      [tenantOf(scope), recordId]
    )
    return (result.rows as InstanceRow[]).map(toInstance)
  }

  async list(
    scope: TenantScope,
    filter: { status?: InstanceStatus; entityDefinitionId?: string; submittedBy?: string }
  ) {
    const where = ['i.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.status) {
      where.push('i.status = ?')
      params.push(filter.status)
    }
    if (filter.entityDefinitionId) {
      where.push('i.entity_definition_id = ?')
      params.push(filter.entityDefinitionId)
    }
    if (filter.submittedBy) {
      where.push('i.submitted_by_membership_id = ?')
      params.push(filter.submittedBy)
    }
    const result = await trxOf(scope).rawQuery(
      `${INSTANCE_SELECT} where ${where.join(' and ')} order by i.started_at desc, i.id limit 200`,
      params as never[]
    )
    return (result.rows as InstanceRow[]).map(toInstance)
  }

  async setStage(scope: TenantScope, instance: WorkflowInstance, stageIndex: number) {
    await trxOf(scope).rawQuery(
      `update workflow_instances set current_stage_index = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ?`,
      [stageIndex, actorOf(scope), tenantOf(scope), instance.id, instance.version]
    )
    return this.reload(scope, instance.id)
  }

  async finish(
    scope: TenantScope,
    instance: WorkflowInstance,
    status: Exclude<InstanceStatus, 'RUNNING' | 'WAITING'>,
    reason: EndReason
  ) {
    await trxOf(scope).rawQuery(
      `update workflow_instances set status = ?, end_reason = ?, ended_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ?`,
      [status, reason, actorOf(scope), tenantOf(scope), instance.id, instance.version]
    )
    return this.reload(scope, instance.id)
  }

  private async reload(scope: TenantScope, id: string) {
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    return row
  }
}

// --- tarefas ------------------------------------------------------------------------------------

interface TaskRow {
  id: string
  instance_id: string
  stage_code: string
  stage_index: number
  assignee_membership_id: string | null
  candidate_role_id: string | null
  status: TaskStatus
  due_at: Date | null
  claimed_at: Date | null
  claimed_by_membership_id: string | null
  decided_by_membership_id: string | null
  via_delegation_id: string | null
  decision_reason: string | null
  decided_at: Date | null
  version: number
}

const TASK_COLUMNS = `id, instance_id, stage_code, stage_index, assignee_membership_id, candidate_role_id, status,
  due_at, claimed_at, claimed_by_membership_id, decided_by_membership_id, via_delegation_id, decision_reason,
  decided_at, version`

const toTask = (r: TaskRow): WorkflowTask => ({
  id: r.id,
  instanceId: r.instance_id,
  stageCode: r.stage_code,
  stageIndex: r.stage_index,
  assigneeMembershipId: r.assignee_membership_id,
  candidateRoleId: r.candidate_role_id,
  status: r.status,
  dueAt: r.due_at,
  claimedAt: r.claimed_at,
  claimedByMembershipId: r.claimed_by_membership_id,
  decidedByMembershipId: r.decided_by_membership_id,
  viaDelegationId: r.via_delegation_id,
  decisionReason: r.decision_reason,
  decidedAt: r.decided_at,
  version: r.version,
})

export class LucidTaskStore implements TaskStore {
  async insertMany(scope: TenantScope, tasks: readonly NewTask[]) {
    const created: WorkflowTask[] = []
    for (const t of tasks) {
      const result = await trxOf(scope).rawQuery(
        `insert into workflow_tasks
           (tenant_id, instance_id, stage_code, stage_index, assignee_membership_id, candidate_role_id, due_at,
            created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         returning ${TASK_COLUMNS}`,
        [
          tenantOf(scope),
          t.instanceId,
          t.stageCode,
          t.stageIndex,
          t.assigneeMembershipId as never,
          t.candidateRoleId as never,
          t.dueAt as never,
          actorOf(scope),
          actorOf(scope),
        ]
      )
      created.push(toTask((result.rows as TaskRow[])[0] as TaskRow))
    }
    return created
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${TASK_COLUMNS} from workflow_tasks where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as TaskRow[]
    return row ? toTask(row) : null
  }

  async lock(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${TASK_COLUMNS} from workflow_tasks where tenant_id = ? and id = ? for update`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as TaskRow[]
    return row ? toTask(row) : null
  }

  async byInstance(scope: TenantScope, instanceId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${TASK_COLUMNS} from workflow_tasks where tenant_id = ? and instance_id = ?
        order by stage_index, created_at, id`,
      [tenantOf(scope), instanceId]
    )
    return (result.rows as TaskRow[]).map(toTask)
  }

  async claim(scope: TenantScope, task: WorkflowTask, membershipId: string) {
    const result = await trxOf(scope).rawQuery(
      `update workflow_tasks set status = 'CLAIMED', claimed_at = now(), claimed_by_membership_id = ?,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and status = 'OPEN'
        returning ${TASK_COLUMNS}`,
      [membershipId, actorOf(scope), tenantOf(scope), task.id]
    )
    const [row] = result.rows as TaskRow[]
    return row ? toTask(row) : null
  }

  async decide(
    scope: TenantScope,
    task: WorkflowTask,
    decision: {
      status: 'APPROVED' | 'REJECTED' | 'RETURNED'
      membershipId: string
      viaDelegationId: string | null
      reason: string | null
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update workflow_tasks set status = ?, decided_by_membership_id = ?, via_delegation_id = ?,
              decision_reason = ?, decided_at = now(), updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and status in ('OPEN', 'CLAIMED')
        returning ${TASK_COLUMNS}`,
      [
        decision.status,
        decision.membershipId,
        decision.viaDelegationId as never,
        decision.reason as never,
        actorOf(scope),
        tenantOf(scope),
        task.id,
      ]
    )
    const [row] = result.rows as TaskRow[]
    if (!row) {
      throw ApiError.conflict('TASK_NOT_OPEN', 'A tarefa já não está por decidir.')
    }
    return toTask(row)
  }

  async cancelPending(scope: TenantScope, instanceId: string, stageIndex?: number) {
    const result = await trxOf(scope).rawQuery(
      `update workflow_tasks set status = 'CANCELLED', updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and instance_id = ? and status in ('OPEN', 'CLAIMED')
          ${stageIndex === undefined ? '' : 'and stage_index = ?'}`,
      [
        actorOf(scope),
        tenantOf(scope),
        instanceId,
        ...(stageIndex === undefined ? [] : [stageIndex]),
      ]
    )
    return result.rowCount ?? 0
  }

  async inbox(
    scope: TenantScope,
    filter: {
      assigneeIds: readonly string[]
      roleIds: readonly string[]
      actorId: string
      view: 'pending' | 'decided'
    }
  ): Promise<InboxRow[]> {
    const responsible =
      '(t.assignee_membership_id = any(?::uuid[]) or t.candidate_role_id = any(?::uuid[]))'
    const status =
      filter.view === 'pending'
        ? `t.status in ('OPEN', 'CLAIMED')`
        : `(t.decided_by_membership_id = ? or t.claimed_by_membership_id = ?) and t.status in ('APPROVED', 'REJECTED', 'RETURNED')`
    const params: unknown[] = [tenantOf(scope), [...filter.assigneeIds], [...filter.roleIds]]
    if (filter.view === 'decided') params.push(filter.actorId, filter.actorId)
    const result = await trxOf(scope).rawQuery(
      `select t.id from workflow_tasks t
        where t.tenant_id = ? and ${responsible} and ${status}
        order by t.created_at desc, t.id limit 200`,
      params as never[]
    )
    return this.withInstances(
      scope,
      (result.rows as { id: string }[]).map((r) => r.id)
    )
  }

  async findWithInstance(scope: TenantScope, id: string) {
    const [row] = await this.withInstances(scope, [id])
    return row ?? null
  }

  private async withInstances(scope: TenantScope, ids: readonly string[]): Promise<InboxRow[]> {
    const rows: InboxRow[] = []
    const instances = new LucidInstanceStore()
    const cache = new Map<string, WorkflowInstance | null>()
    for (const id of ids) {
      const task = await this.find(scope, id)
      if (!task) continue
      if (!cache.has(task.instanceId))
        cache.set(task.instanceId, await instances.find(scope, task.instanceId))
      const instance = cache.get(task.instanceId)
      if (instance) rows.push({ task, instance })
    }
    return rows
  }
}

// --- delegações ---------------------------------------------------------------------------------

interface DelegationRow {
  id: string
  from_membership_id: string
  to_membership_id: string
  valid_from: Date
  valid_until: Date
  scope: Delegation['scope']
  max_amount: string | null
  currency: string | null
  reason: string
  revoked_at: Date | null
  version: number
  created_at: Date
}

const DELEGATION_COLUMNS = `id, from_membership_id, to_membership_id, valid_from, valid_until, scope, max_amount::text,
  currency, reason, revoked_at, version, created_at`

const toDelegation = (r: DelegationRow): Delegation => ({
  id: r.id,
  fromMembershipId: r.from_membership_id,
  toMembershipId: r.to_membership_id,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
  scope: r.scope,
  maxAmount: r.max_amount,
  currency: r.currency,
  reason: r.reason,
  revokedAt: r.revoked_at,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidDelegationStore implements DelegationStore {
  async insert(
    scope: TenantScope,
    v: Omit<Delegation, 'id' | 'revokedAt' | 'version' | 'createdAt'>
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into approval_delegations
         (tenant_id, from_membership_id, to_membership_id, valid_from, valid_until, scope, max_amount, currency,
          reason, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
       returning ${DELEGATION_COLUMNS}`,
      [
        tenantOf(scope),
        v.fromMembershipId,
        v.toMembershipId,
        v.validFrom as never,
        v.validUntil as never,
        json(v.scope),
        v.maxAmount as never,
        v.currency as never,
        v.reason,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toDelegation((result.rows as DelegationRow[])[0] as DelegationRow)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${DELEGATION_COLUMNS} from approval_delegations where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as DelegationRow[]
    return row ? toDelegation(row) : null
  }

  async listFor(scope: TenantScope, membershipId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${DELEGATION_COLUMNS} from approval_delegations
        where tenant_id = ? and (from_membership_id = ? or to_membership_id = ?)
        order by created_at desc, id limit 200`,
      [tenantOf(scope), membershipId, membershipId]
    )
    return (result.rows as DelegationRow[]).map(toDelegation)
  }

  async activeTo(scope: TenantScope, toMembershipId: string, at: Date) {
    const result = await trxOf(scope).rawQuery(
      `select ${DELEGATION_COLUMNS} from approval_delegations
        where tenant_id = ? and to_membership_id = ? and revoked_at is null and valid_from <= ? and valid_until > ?`,
      [tenantOf(scope), toMembershipId, at as never, at as never]
    )
    return (result.rows as DelegationRow[]).map(toDelegation)
  }

  async active(scope: TenantScope, at: Date) {
    const result = await trxOf(scope).rawQuery(
      `select ${DELEGATION_COLUMNS} from approval_delegations
        where tenant_id = ? and revoked_at is null and valid_until > ?`,
      [tenantOf(scope), at as never]
    )
    return (result.rows as DelegationRow[]).map(toDelegation)
  }

  async lock(scope: TenantScope) {
    await trxOf(scope).rawQuery(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [
      `approval_delegations:${tenantOf(scope)}`,
    ])
  }

  async revoke(scope: TenantScope, id: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update approval_delegations set revoked_at = now(), updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? and revoked_at is null
        returning ${DELEGATION_COLUMNS}`,
      [actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    const [row] = result.rows as DelegationRow[]
    if (row) return toDelegation(row)
    const current = await this.find(scope, id)
    if (!current) throw ApiError.notFound()
    if (current.revokedAt) {
      throw ApiError.conflict('DELEGATION_REVOKED', 'A delegação já foi revogada.')
    }
    throw ApiError.versionConflict(current.version)
  }
}
