import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import {
  initialStateOf,
  type MachineStatus,
  type StateDef,
  type TransitionDef,
} from '#dynamic/states/domain/state_machine'
import type {
  HistoryRow,
  Machine,
  MachineStore,
  MachineValues,
  RecordStateRow,
  RecordStateStore,
  StateHistoryEntry,
} from '#dynamic/states/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never
const json = (value: unknown) => JSON.stringify(value)

interface MachineRow {
  id: string
  entity_definition_id: string
  entity_code: string
  code: string
  name: string
  description: string | null
  revision: number
  status: MachineStatus
  states: StateDef[]
  transitions: TransitionDef[]
  published_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

const SELECT = `select m.id, m.entity_definition_id, e.code as entity_code, m.code, m.name, m.description,
  m.revision, m.status, m.states, m.transitions, m.published_at, m.version, m.created_at, m.updated_at
  from state_machines m
  join entity_definitions e on e.tenant_id = m.tenant_id and e.id = m.entity_definition_id`

const toMachine = (r: MachineRow): Machine => ({
  id: r.id,
  entityDefinitionId: r.entity_definition_id,
  entityCode: r.entity_code,
  code: r.code,
  name: r.name,
  description: r.description,
  revision: r.revision,
  status: r.status,
  states: r.states,
  transitions: r.transitions,
  initialStateCode: initialStateOf(r.states)?.code ?? '',
  publishedAt: r.published_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidMachineStore implements MachineStore {
  async list(scope: TenantScope, filter: { entityDefinitionId?: string; status?: MachineStatus }) {
    const where = ['m.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.entityDefinitionId) {
      where.push('m.entity_definition_id = ?')
      params.push(filter.entityDefinitionId)
    }
    if (filter.status) {
      where.push('m.status = ?')
      params.push(filter.status)
    }
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where ${where.join(' and ')} order by e.code, m.code, m.revision desc`,
      params as never[]
    )
    return (result.rows as MachineRow[]).map(toMachine)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(`${SELECT} where m.tenant_id = ? and m.id = ?`, [
      tenantOf(scope),
      id,
    ])
    const [row] = result.rows as MachineRow[]
    return row ? toMachine(row) : null
  }

  async latest(scope: TenantScope, entityDefinitionId: string, code: string) {
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where m.tenant_id = ? and m.entity_definition_id = ? and m.code = ?
        order by m.revision desc limit 1`,
      [tenantOf(scope), entityDefinitionId, code]
    )
    const [row] = result.rows as MachineRow[]
    return row ? toMachine(row) : null
  }

  async insert(scope: TenantScope, v: MachineValues & { revision: number }) {
    const result = await trxOf(scope).rawQuery(
      `insert into state_machines
         (tenant_id, entity_definition_id, code, name, description, revision, states, transitions,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tenantOf(scope),
        v.entityDefinitionId,
        v.code,
        v.name,
        v.description as never,
        v.revision,
        json(v.states),
        json(v.transitions),
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
    patch: Partial<Omit<MachineValues, 'entityDefinitionId' | 'code'>>
  ) {
    const columns: [string, unknown, boolean][] = [
      ['name', patch.name, false],
      ['description', patch.description, false],
      ['states', patch.states === undefined ? undefined : json(patch.states), true],
      ['transitions', patch.transitions === undefined ? undefined : json(patch.transitions), true],
    ]
    const entries = columns.filter(([, value]) => value !== undefined)
    const sets = entries
      .map(([column, , asJson]) => `"${column}" = ?${asJson ? '::jsonb' : ''}`)
      .join(', ')
    const result = await trxOf(scope).rawQuery(
      `update state_machines
          set ${sets}${sets ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'DRAFT'
        returning id`,
      [...entries.map(([, v]) => v as never), actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async publish(scope: TenantScope, machine: Machine, expectedVersion: number) {
    await trxOf(scope).rawQuery(
      `update state_machines set status = 'RETIRED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and entity_definition_id = ? and status = 'PUBLISHED'`,
      [actorOf(scope), tenantOf(scope), machine.entityDefinitionId]
    )
    const result = await trxOf(scope).rawQuery(
      `update state_machines
          set status = 'PUBLISHED', published_at = now(), published_by_membership_id = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'DRAFT'
        returning id`,
      [actorOf(scope), actorOf(scope), tenantOf(scope), machine.id, expectedVersion]
    )
    return this.afterWrite(scope, machine.id, result.rows.length > 0)
  }

  async retire(scope: TenantScope, id: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update state_machines set status = 'RETIRED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'PUBLISHED'
        returning id`,
      [actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async findPublishedForEntity(scope: TenantScope, entityDefinitionId: string) {
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where m.tenant_id = ? and m.entity_definition_id = ? and m.status = 'PUBLISHED'`,
      [tenantOf(scope), entityDefinitionId]
    )
    const [row] = result.rows as MachineRow[]
    return row ? toMachine(row) : null
  }

  private async afterWrite(scope: TenantScope, id: string, written: boolean): Promise<Machine> {
    const machine = await this.find(scope, id)
    if (!machine) throw ApiError.notFound()
    if (!written) throw ApiError.versionConflict(machine.version)
    return machine
  }
}

interface StateRow {
  id: string
  entity_definition_id: string
  record_id: string
  state_machine_id: string
  state_code: string
  version: number
}

const toState = (r: StateRow): RecordStateRow => ({
  id: r.id,
  entityDefinitionId: r.entity_definition_id,
  recordId: r.record_id,
  machineId: r.state_machine_id,
  stateCode: r.state_code,
  version: r.version,
})

const STATE_COLUMNS = 'id, entity_definition_id, record_id, state_machine_id, state_code, version'

export class LucidRecordStateStore implements RecordStateStore {
  async insert(scope: TenantScope, row: Omit<RecordStateRow, 'id' | 'version'>) {
    const result = await trxOf(scope).rawQuery(
      `insert into record_states
         (tenant_id, entity_definition_id, record_id, state_machine_id, state_code,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?)
       returning ${STATE_COLUMNS}`,
      [
        tenantOf(scope),
        row.entityDefinitionId,
        row.recordId,
        row.machineId,
        row.stateCode,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toState((result.rows as StateRow[])[0] as StateRow)
  }

  async find(scope: TenantScope, recordId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${STATE_COLUMNS} from record_states where tenant_id = ? and record_id = ?`,
      [tenantOf(scope), recordId]
    )
    const [row] = result.rows as StateRow[]
    return row ? toState(row) : null
  }

  async lock(scope: TenantScope, recordId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${STATE_COLUMNS} from record_states where tenant_id = ? and record_id = ? for update`,
      [tenantOf(scope), recordId]
    )
    const [row] = result.rows as StateRow[]
    return row ? toState(row) : null
  }

  async findMany(scope: TenantScope, recordIds: readonly string[]) {
    if (recordIds.length === 0) return []
    const result = await trxOf(scope).rawQuery(
      `select ${STATE_COLUMNS} from record_states where tenant_id = ? and record_id = any(?::uuid[])`,
      [tenantOf(scope), recordIds as never]
    )
    return (result.rows as StateRow[]).map(toState)
  }

  async move(scope: TenantScope, row: RecordStateRow, machineId: string, stateCode: string) {
    const result = await trxOf(scope).rawQuery(
      `update record_states
          set state_machine_id = ?, state_code = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ?
        returning ${STATE_COLUMNS}`,
      [machineId, stateCode, actorOf(scope), tenantOf(scope), row.id, row.version]
    )
    const [moved] = result.rows as StateRow[]
    if (!moved) throw ApiError.versionConflict(row.version)
    return toState(moved)
  }

  async codesInUse(scope: TenantScope, entityDefinitionId: string) {
    const result = await trxOf(scope).rawQuery(
      `select distinct state_code from record_states where tenant_id = ? and entity_definition_id = ?`,
      [tenantOf(scope), entityDefinitionId]
    )
    return new Set((result.rows as { state_code: string }[]).map((r) => r.state_code))
  }

  async insertHistory(scope: TenantScope, row: HistoryRow) {
    await trxOf(scope).rawQuery(
      `insert into state_history
         (tenant_id, entity_definition_id, record_id, state_machine_id, transition_code, from_state, to_state,
          actor_membership_id, reason, correlation_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        row.entityDefinitionId,
        row.recordId,
        row.machineId,
        row.transitionCode as never,
        row.fromState as never,
        row.toState,
        row.actorMembershipId as never,
        row.reason as never,
        row.correlationId as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
  }

  async history(scope: TenantScope, recordId: string): Promise<StateHistoryEntry[]> {
    const result = await trxOf(scope).rawQuery(
      `select id, entity_definition_id, record_id, state_machine_id, transition_code, from_state, to_state,
              actor_membership_id, reason, correlation_id, occurred_at
         from state_history where tenant_id = ? and record_id = ?
        order by occurred_at, id`,
      [tenantOf(scope), recordId]
    )
    return (
      result.rows as {
        id: string
        entity_definition_id: string
        record_id: string
        state_machine_id: string
        transition_code: string | null
        from_state: string | null
        to_state: string
        actor_membership_id: string | null
        reason: string | null
        correlation_id: string | null
        occurred_at: Date
      }[]
    ).map((r) => ({
      id: r.id,
      entityDefinitionId: r.entity_definition_id,
      recordId: r.record_id,
      machineId: r.state_machine_id,
      transitionCode: r.transition_code,
      fromState: r.from_state,
      toState: r.to_state,
      actorMembershipId: r.actor_membership_id,
      reason: r.reason,
      correlationId: r.correlation_id,
      occurredAt: r.occurred_at,
    }))
  }

  async machinesByIds(scope: TenantScope, ids: readonly string[]) {
    const unique = [...new Set(ids)]
    const map = new Map<string, Machine>()
    if (unique.length === 0) return map
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where m.tenant_id = ? and m.id = any(?::uuid[])`,
      [tenantOf(scope), unique as never]
    )
    for (const row of result.rows as MachineRow[]) map.set(row.id, toMachine(row))
    return map
  }
}
