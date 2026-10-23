import { evaluateCondition, validateCondition, type Condition } from '#core/permissions/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { metadataServices } from '#dynamic/metadata/index'
import { RuleEnforcer } from '#dynamic/rules/application/rule_enforcer'
import { RuleUseCases } from '#dynamic/rules/application/rule_use_cases'
import type { ConditionEngine, RuleTarget, RuleTargets } from '#dynamic/rules/application/ports'
import { LucidRuleStore } from '#dynamic/rules/infrastructure/lucid_rules'

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

/** As entidades vêm do módulo de metadados, pela sua API pública. */
const targets: RuleTargets = {
  async findByCode(context, code) {
    const entities = await metadataServices().entities.list(context)
    const entity = entities.find((e) => e.code === code)
    return entity ? this.findById(context, entity.id) : null
  },
  async findById(context, id) {
    const detail = await metadataServices().entities.get(context, id)
    const target: RuleTarget = {
      id: detail.entity.id,
      code: detail.entity.code,
      published: detail.published !== null,
      fields: detail.published?.fields ?? [],
    }
    return target
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const store = new LucidRuleStore()
  return {
    rules: new RuleUseCases(uow, store, targets, engine),
    enforcer: new RuleEnforcer(uow, store, engine),
  }
}

let instance: ReturnType<typeof build> | undefined

export const ruleServices = () => (instance ??= build())
