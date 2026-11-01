import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import type { RecordState, RecordStates, RecordStateTarget } from '#dynamic/metadata/index'
import type { MachineStore, RecordStateStore } from '#dynamic/states/application/ports'

/**
 * Liga as máquinas de estados aos registos (porta `RecordStates` dos metadados): o registo novo nasce no estado inicial da
 * máquina em vigor, um estado que não admite alterações recusa-as (409) e as respostas trazem o estado.
 */
export class RecordStatesHook implements RecordStates {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly machines: MachineStore,
    private readonly states: RecordStateStore
  ) {}

  async onCreated(
    scope: TenantScope,
    context: TenantContext,
    entity: RecordStateTarget,
    recordId: string
  ): Promise<void> {
    const machine = await this.machines.findPublishedForEntity(scope, entity.id)
    if (!machine) return
    const initial = machine.states.find((s) => s.code === machine.initialStateCode)
    if (!initial) throw new Error('Máquina de estados sem estado inicial.')
    await this.states.insert(scope, {
      entityDefinitionId: entity.id,
      recordId,
      machineId: machine.id,
      stateCode: initial.code,
    })
    await this.states.insertHistory(scope, {
      entityDefinitionId: entity.id,
      recordId,
      machineId: machine.id,
      transitionCode: null,
      fromState: null,
      toState: initial.code,
      actorMembershipId: context.membershipId,
      reason: null,
      correlationId: context.correlationId,
    })
  }

  async assertEditable(
    scope: TenantScope,
    entity: RecordStateTarget,
    recordId: string
  ): Promise<void> {
    const row = await this.states.find(scope, recordId)
    if (!row || row.entityDefinitionId !== entity.id) return
    const machines = await this.states.machinesByIds(scope, [row.machineId])
    const machine = machines.get(row.machineId)
    const state = machine?.states.find((s) => s.code === row.stateCode)
    if (state && !state.editable) {
      throw ApiError.conflict(
        'RECORD_STATE_LOCKED',
        `O registo está no estado «${state.label}» e não aceita alterações de valores.`
      )
    }
  }

  async describe(
    context: TenantContext,
    entity: RecordStateTarget,
    recordIds: readonly string[]
  ): Promise<Map<string, RecordState>> {
    const result = new Map<string, RecordState>()
    if (recordIds.length === 0) return result
    await this.uow.run(async (scope) => {
      const found = await this.states.findMany(scope, recordIds)
      const rows = found.filter((r) => r.entityDefinitionId === entity.id)
      const machines = await this.states.machinesByIds(
        scope,
        rows.map((r) => r.machineId)
      )
      for (const row of rows) {
        const machine = machines.get(row.machineId)
        const state = machine?.states.find((s) => s.code === row.stateCode)
        if (!machine || !state) continue
        result.set(row.recordId, {
          code: state.code,
          label: state.label,
          category: state.category,
          editable: state.editable,
          color: state.color ?? null,
          machine: { code: machine.code, revision: machine.revision },
          version: row.version,
        })
      }
    }, context)
    return result
  }
}
