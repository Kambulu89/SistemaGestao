import {
  PERMISSION_CATALOG,
  evaluateCondition,
  iamServices,
  validateCondition,
  type Condition,
} from '#core/permissions/index'
import { LucidOutboxWriter } from '#core/outbox/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { metadataServices } from '#dynamic/metadata/index'
import { MachineUseCases } from '#dynamic/states/application/machine_use_cases'
import type {
  AccessControl,
  ConditionEngine,
  PermissionCatalog,
  RecordGateway,
  StateTarget,
  StateTargets,
} from '#dynamic/states/application/ports'
import { RecordStatesHook } from '#dynamic/states/application/record_states_hook'
import { TransitionUseCases } from '#dynamic/states/application/transition_use_cases'
import {
  LucidMachineStore,
  LucidRecordStateStore,
} from '#dynamic/states/infrastructure/lucid_states'

/** O motor de condições é o das políticas de acesso: mesma gramática, limites e avaliação (sem código do tenant). */
const engine: ConditionEngine = {
  validate: (condition) =>
    validateCondition(condition as Condition).map((i) => ({
      path: i.path,
      code: i.code,
      message: i.message,
    })),
  evaluate: (condition, context) => evaluateCondition(condition as Condition, context),
}

const access: AccessControl = {
  async allowed(context, permission, resource) {
    const decision = await iamServices().authorize.decision(context, permission, resource)
    return decision.allowed
  },
}

const catalog: PermissionCatalog = {
  has: (code) => PERMISSION_CATALOG.some((p) => p.code === code),
}

/** As entidades vêm do módulo de metadados, pela sua API pública. */
const targets: StateTargets = {
  async findByCode(context, code) {
    const entities = await metadataServices().entities.list(context)
    const entity = entities.find((e) => e.code === code)
    return entity ? this.findById(context, entity.id) : null
  },
  async findById(context, id) {
    const detail = await metadataServices().entities.get(context, id)
    const target: StateTarget = {
      id: detail.entity.id,
      code: detail.entity.code,
      published: detail.published !== null && detail.entity.status === 'PUBLISHED',
      ownershipMode: detail.entity.ownershipMode,
      readableFields: new Set(
        (detail.published?.fields ?? [])
          .filter((f) => !f.archived && !f.sensitive)
          .map((f) => f.code)
      ),
    }
    return target
  },
}

/** O registo vem do módulo de metadados: só o que a pessoa pode ler (nunca campos escondidos nem sensíveis). */
const records: RecordGateway = {
  async get(context, entityCode, id) {
    const record = await metadataServices().records.get(context, entityCode, id)
    return {
      id: record.id,
      data: record.data,
      ownerMembershipId: record.ownerMembershipId,
      organizationUnitId: record.organizationUnitId,
      archived: record.archived,
    }
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const machines = new LucidMachineStore()
  const states = new LucidRecordStateStore()
  return {
    machines: new MachineUseCases(uow, machines, states, targets, engine, catalog),
    transitions: new TransitionUseCases(
      uow,
      machines,
      states,
      targets,
      records,
      access,
      engine,
      new LucidOutboxWriter()
    ),
    hook: new RecordStatesHook(uow, machines, states),
  }
}

let instance: ReturnType<typeof build> | undefined

export const stateServices = () => (instance ??= build())
