import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import type { Issue, RecordRuleCheck, RecordRules } from '#dynamic/metadata/index'
import { inputHash, isEffective, type EvaluationResult } from '#dynamic/rules/domain/rule'
import type { ConditionEngine, EvaluationRow, RuleStore } from '#dynamic/rules/application/ports'

/**
 * Aplica as regras publicadas às escritas de registos. Todas as regras em vigor são avaliadas (por prioridade
 * e depois por código) e cada falha acrescenta uma mensagem de negócio. Uma condição que não se consegue avaliar
 * **bloqueia** (falha fechada). As avaliações recusadas ou com erro ficam registadas numa transacção própria,
 * para não se perderem com a recusa da escrita; guardam um resumo dos dados, nunca os valores.
 */
export class RuleEnforcer implements RecordRules {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly rules: RuleStore,
    private readonly engine: ConditionEngine,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async check(context: TenantContext, input: RecordRuleCheck): Promise<Issue[]> {
    const published = await this.uow.run(
      (scope) => this.rules.listPublished(scope, input.entity.id),
      context
    )
    const now = this.clock()
    const active = published.filter((rule) => isEffective(rule, now))
    if (active.length === 0) return []

    // Os campos sensíveis nunca entram na avaliação (nem numa regra), e os arquivados já não contam.
    const visible = new Set(
      input.fields.filter((f) => !f.sensitive && !f.archived).map((f) => f.code)
    )
    const resource = Object.fromEntries(
      Object.entries(input.values).filter(([code]) => visible.has(code))
    )
    const hash = inputHash(resource)
    const evaluation = {
      subject: {
        membershipId: context.membershipId,
        userId: context.userId,
        organizationId: context.organizationId,
      },
      resource,
      env: { now: now.toISOString() },
    }

    const issues: Issue[] = []
    const rows: EvaluationRow[] = []
    for (const rule of active) {
      const started = performance.now()
      let result: EvaluationResult = 'PASS'
      let errorCode: string | null = null
      try {
        if (this.engine.evaluate(rule.conditionAst, evaluation)) {
          result = 'FAIL'
          issues.push({
            path: rule.actionAst.field ? `data.${rule.actionAst.field}` : 'data',
            code: 'RULE_BLOCKED',
            message: rule.actionAst.message,
          })
        }
      } catch {
        result = 'ERROR'
        errorCode = 'CONDITION_ERROR'
        issues.push({
          path: 'data',
          code: 'RULE_ERROR',
          message: 'Uma regra de negócio não pôde ser avaliada: a operação foi bloqueada.',
        })
      }
      if (result !== 'PASS') {
        rows.push({
          ruleId: rule.id,
          resourceId: input.recordId,
          correlationId: context.correlationId,
          inputHash: hash,
          result,
          durationMs: Math.round(performance.now() - started),
          errorCode,
        })
      }
    }
    if (rows.length > 0) {
      await this.uow.run((scope) => this.rules.insertEvaluations(scope, rows), context)
    }
    return issues
  }
}
