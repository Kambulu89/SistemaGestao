import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { FieldSpec } from '#dynamic/metadata/index'
import type {
  BlockAction,
  EvaluationResult,
  RuleIssue,
  RuleStatus,
  RuleTrigger,
} from '#dynamic/rules/domain/rule'

export interface Rule {
  id: string
  entityDefinitionId: string
  entityCode: string
  code: string
  name: string
  description: string | null
  trigger: RuleTrigger
  revision: number
  priority: number
  conditionAst: unknown
  actionAst: BlockAction
  status: RuleStatus
  effectiveFrom: Date | null
  effectiveTo: Date | null
  publishedAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface RuleValues {
  entityDefinitionId: string
  code: string
  name: string
  description: string | null
  priority: number
  conditionAst: unknown
  actionAst: BlockAction
  effectiveFrom: Date | null
  effectiveTo: Date | null
}

export interface EvaluationRow {
  ruleId: string
  resourceId: string | null
  correlationId: string
  inputHash: string
  result: EvaluationResult
  durationMs: number
  errorCode: string | null
}

export interface Evaluation extends EvaluationRow {
  id: string
  createdAt: Date
}

export interface RuleStore {
  list(scope: TenantScope, filter: { entityDefinitionId?: string }): Promise<Rule[]>
  find(scope: TenantScope, id: string): Promise<Rule | null>
  /** A revisão mais alta desta regra (qualquer estado). */
  latest(scope: TenantScope, entityDefinitionId: string, code: string): Promise<Rule | null>
  /** `null` se já existe um rascunho ou a revisão pedida. */
  insert(scope: TenantScope, values: RuleValues & { revision: number }): Promise<Rule | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<RuleValues, 'entityDefinitionId' | 'code'>>
  ): Promise<Rule>
  /** Desactiva a revisão em vigor do mesmo código e publica esta, numa só operação. */
  publish(scope: TenantScope, rule: Rule, expectedVersion: number): Promise<Rule>
  disable(scope: TenantScope, id: string, expectedVersion: number): Promise<Rule>
  listPublished(scope: TenantScope, entityDefinitionId: string): Promise<Rule[]>
  insertEvaluations(scope: TenantScope, rows: EvaluationRow[]): Promise<void>
  listEvaluations(scope: TenantScope, ruleId: string, limit: number): Promise<Evaluation[]>
}

export interface RuleTarget {
  id: string
  code: string
  /** Campos da versão publicada em vigor; vazio se a entidade ainda não foi publicada. */
  fields: readonly FieldSpec[]
  published: boolean
}

/** Entidades dinâmicas (módulo de metadados) vistas pelas regras. */
export interface RuleTargets {
  findByCode(context: TenantContext, code: string): Promise<RuleTarget | null>
  findById(context: TenantContext, id: string): Promise<RuleTarget | null>
}

export interface EvaluationContext {
  subject: Record<string, unknown>
  resource: Record<string, unknown>
  env: Record<string, unknown>
}

/** Motor das condições declarativas (o do módulo de permissões): valida a estrutura e avalia. */
export interface ConditionEngine {
  validate(condition: unknown): RuleIssue[]
  /** Lança se a condição for inválida; a aplicação trata o erro como falha fechada. */
  evaluate(condition: unknown, context: EvaluationContext): boolean
}
