import { LucidOutboxWriter } from '#core/outbox/index'
import { LucidMembershipStore } from '#core/membership/index'
import {
  PERMISSION_CATALOG,
  evaluateCondition,
  iamServices,
  validateCondition,
  type Condition,
} from '#core/permissions/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { metadataServices } from '#dynamic/metadata/index'
import { DefinitionUseCases } from '#dynamic/workflows/application/definition_use_cases'
import { DelegationUseCases } from '#dynamic/workflows/application/delegation_use_cases'
import { InstanceUseCases } from '#dynamic/workflows/application/instance_use_cases'
import type {
  AccessControl,
  ConditionEngine,
  Directory,
  RecordGateway,
  WorkflowTarget,
  WorkflowTargets,
} from '#dynamic/workflows/application/ports'
import { TaskUseCases } from '#dynamic/workflows/application/task_use_cases'
import {
  LucidDelegationStore,
  LucidInstanceStore,
  LucidTaskStore,
  LucidWorkflowStore,
} from '#dynamic/workflows/infrastructure/lucid_workflows'

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

export const catalogHas = (code: string) => PERMISSION_CATALOG.some((p) => p.code === code)

/** Membros e papéis vêm dos módulos de membros e de autorização, pelas suas APIs públicas. */
const directory: Directory = (() => {
  const memberships = new LucidMembershipStore()
  const iam = () => iamServices().store
  const self: Directory = {
    async isActive(scope, membershipId) {
      const found = await memberships.findById(scope, membershipId)
      return found?.status === 'ACTIVE'
    },
    async roleExists(scope, roleId) {
      const role = await iam().findRole(scope, roleId)
      return role !== null
    },
    async rolesOf(scope, membershipId, at) {
      const assignments = await iam().listAssignments(scope, membershipId)
      return new Set(
        assignments
          .filter(
            (a) =>
              (a.validFrom === null || a.validFrom <= at) &&
              (a.validUntil === null || a.validUntil > at)
          )
          .map((a) => a.roleId)
      )
    },
    async hasActiveHolder(scope, roleId, at) {
      for (const membershipId of await iam().membershipsWithRole(scope, roleId)) {
        if (!(await self.isActive(scope, membershipId))) continue
        const roles = await self.rolesOf(scope, membershipId, at)
        if (roles.has(roleId)) return true
      }
      return false
    },
  }
  return self
})()

/** As entidades vêm do módulo de metadados, pela sua API pública. */
const targets: WorkflowTargets = {
  async findByCode(context, code) {
    const entities = await metadataServices().entities.list(context)
    const entity = entities.find((e) => e.code === code)
    return entity ? this.findById(context, entity.id) : null
  },
  async findById(context, id) {
    const detail = await metadataServices().entities.get(context, id)
    const target: WorkflowTarget = {
      id: detail.entity.id,
      code: detail.entity.code,
      published: detail.published !== null && detail.entity.status === 'PUBLISHED',
      readableFields: new Map(
        (detail.published?.fields ?? [])
          .filter((f) => !f.archived && !f.sensitive)
          .map((f) => [f.code, f.type] as const)
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
      version: record.version,
      archived: record.archived,
    }
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const workflows = new LucidWorkflowStore()
  const instances = new LucidInstanceStore()
  const tasks = new LucidTaskStore()
  const delegations = new LucidDelegationStore()
  const outbox = new LucidOutboxWriter()
  return {
    definitions: new DefinitionUseCases(uow, workflows, targets, engine, directory),
    instances: new InstanceUseCases(
      uow,
      workflows,
      instances,
      tasks,
      targets,
      records,
      access,
      directory,
      engine,
      outbox
    ),
    tasks: new TaskUseCases(
      uow,
      workflows,
      instances,
      tasks,
      delegations,
      directory,
      access,
      engine,
      outbox
    ),
    delegations: new DelegationUseCases(uow, delegations, directory),
  }
}

let instance: ReturnType<typeof build> | undefined

export const workflowServices = () => (instance ??= build())
