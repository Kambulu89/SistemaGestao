import { LucidMembershipStore } from '#core/membership/index'
import { LucidOutboxReader } from '#core/outbox/index'
import { evaluateCondition, validateCondition, type Condition } from '#core/permissions/index'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import { LucidTenantStore, isOperational, tenantServices } from '#platform/tenants/index'
import { AutomationUseCases } from '#dynamic/automations/application/automation_use_cases'
import { AutomationEngine, AutomationWorker } from '#dynamic/automations/application/engine'
import type { ConditionEngine, RunAsResolver } from '#dynamic/automations/application/ports'
import { RunUseCases } from '#dynamic/automations/application/run_use_cases'
import {
  LucidAutomationStore,
  LucidRunStore,
} from '#dynamic/automations/infrastructure/lucid_automations'

/** O motor de condições é o das políticas de acesso: mesma gramática, limites e avaliação (sem código do tenant). */
const conditions: ConditionEngine = {
  validate: (condition) =>
    validateCondition(condition as Condition).map((i) => ({
      path: i.path,
      code: i.code,
      message: i.message,
    })),
  evaluate: (condition, context) => evaluateCondition(condition as Condition, context),
}

function build() {
  const uow = new LucidTenantDatabase()
  const automations = new LucidAutomationStore()
  const runs = new LucidRunStore()
  const tenants = new LucidTenantStore()
  const memberships = new LucidMembershipStore()

  /** O membro de uma automação executa com as suas permissões **actuais**, num tenant operacional. */
  const runAs: RunAsResolver = {
    async resolve(tenantId, membershipId, correlationId) {
      const membership = await uow.run(
        (scope) => memberships.findById(scope, membershipId),
        serviceTenantContext(tenantId, correlationId)
      )
      if (!membership)
        throw new Error('O membro em nome de quem a automação executa já não existe.')
      const resolved = await tenantServices().resolveTenantContext.execute({
        user: { id: membership.userId, locale: null },
        selector: { tenantId },
        correlationId,
      })
      return resolved.context
    },
    async operationalTenants() {
      const all = await tenants.list()
      return all.filter((t) => isOperational(t.status)).map((t) => t.id)
    },
  }

  const engine = new AutomationEngine(
    uow,
    automations,
    runs,
    new LucidOutboxReader(),
    conditions,
    runAs
  )
  return {
    automations: new AutomationUseCases(uow, automations, conditions, async (tenantId) => {
      const tenant = await tenants.findById(tenantId)
      return tenant?.timezone ?? 'Africa/Luanda'
    }),
    runs: new RunUseCases(uow, runs),
    engine,
    worker: (onError?: (tenantId: string, error: unknown) => void) =>
      new AutomationWorker(engine, runAs, onError),
  }
}

let instance: ReturnType<typeof build> | undefined

export const automationServices = () => (instance ??= build())
