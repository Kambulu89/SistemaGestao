import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import type { FieldSpec } from '#dynamic/metadata/index'
import {
  DEFAULT_PRIORITY,
  ENV_VARIABLES,
  MAX_PRIORITY,
  RULE_CODE,
  SUBJECT_VARIABLES,
  conditionVariables,
  isEffective,
  normalizeAction,
  type EvaluationResult,
  type RuleIssue,
} from '#dynamic/rules/domain/rule'
import type {
  ConditionEngine,
  Evaluation,
  Rule,
  RuleStore,
  RuleTarget,
  RuleTargets,
  RuleValues,
} from '#dynamic/rules/application/ports'

export const ruleValidation = (details: RuleIssue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export interface RuleInput {
  name?: string
  description?: string | null
  priority?: number
  conditionAst?: unknown
  actionAst?: unknown
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export interface SimulationResult {
  result: EvaluationResult
  /** A mensagem de negócio que bloquearia a escrita (só com `FAIL`). */
  message: string | null
  reason: string | null
}

const parseInstant = (value: string | null | undefined, path: string, issues: RuleIssue[]) => {
  if (value === null || value === undefined) return null
  const time = Date.parse(value)
  if (Number.isNaN(time) || !/T.*(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    issues.push({ path, code: 'INVALID_DATE', message: 'Instante ISO 8601 com fuso horário.' })
    return null
  }
  return new Date(time)
}

/** Casos de uso das regras (C12): rascunho → publicação imutável → desactivação, e simulação sem efeitos. */
export class RuleUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly rules: RuleStore,
    private readonly targets: RuleTargets,
    private readonly engine: ConditionEngine
  ) {}

  async list(context: TenantContext, filter: { entityCode?: string }): Promise<Rule[]> {
    let entityDefinitionId: string | undefined
    if (filter.entityCode) {
      const target = await this.targets.findByCode(context, filter.entityCode)
      if (!target) return []
      entityDefinitionId = target.id
    }
    return this.uow.run((scope) => this.rules.list(scope, { entityDefinitionId }), context)
  }

  get(context: TenantContext, id: string): Promise<Rule> {
    return this.uow.run((scope) => this.mustFind(scope, id), context)
  }

  async create(
    context: TenantContext,
    input: RuleInput & { entityCode: string; code: string }
  ): Promise<Rule> {
    const issues: RuleIssue[] = []
    const code = input.code.trim()
    if (!RULE_CODE.test(code)) {
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    }
    const target = await this.publishedTarget(context, input.entityCode, issues)
    const values = this.values(input, null, issues, target)
    if (issues.length > 0 || !target || !values) throw ruleValidation(issues)

    return this.uow.run(async (scope) => {
      if (await this.rules.latest(scope, target.id, code)) {
        throw ApiError.conflict(
          'RULE_CODE_TAKEN',
          'Já existe uma regra com este código nesta entidade: abra uma nova revisão.'
        )
      }
      const rule = await this.rules.insert(scope, {
        ...values,
        entityDefinitionId: target.id,
        code,
        revision: 1,
      })
      if (!rule) throw ApiError.conflict('RULE_CODE_TAKEN', 'Já existe uma regra com este código.')
      return rule
    }, context)
  }

  /** Só um rascunho se altera; uma regra publicada ou desactivada é imutável (nova revisão). */
  async update(
    context: TenantContext,
    id: string,
    input: RuleInput & { expectedVersion: number }
  ): Promise<Rule> {
    const current = await this.get(context, id)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict('RULE_NOT_DRAFT', 'Só um rascunho se altera: abra uma nova revisão.')
    }
    const issues: RuleIssue[] = []
    const target = await this.publishedTarget(context, current.entityCode, issues)
    const values = this.values(input, current, issues, target)
    if (issues.length > 0 || !values) throw ruleValidation(issues)
    return this.uow.run(
      (scope) =>
        this.rules.update(scope, id, input.expectedVersion, {
          name: values.name,
          description: values.description,
          priority: values.priority,
          conditionAst: values.conditionAst,
          actionAst: values.actionAst,
          effectiveFrom: values.effectiveFrom,
          effectiveTo: values.effectiveTo,
        }),
      context
    )
  }

  /** Abre a próxima revisão em rascunho, a partir da mais recente. */
  createRevision(context: TenantContext, id: string): Promise<Rule> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      const latest = (await this.rules.latest(
        scope,
        current.entityDefinitionId,
        current.code
      )) as Rule
      if (latest.status === 'DRAFT') {
        throw ApiError.conflict('RULE_DRAFT_EXISTS', 'Já existe um rascunho desta regra.')
      }
      const revision = await this.rules.insert(scope, {
        entityDefinitionId: latest.entityDefinitionId,
        code: latest.code,
        name: latest.name,
        description: latest.description,
        priority: latest.priority,
        conditionAst: latest.conditionAst,
        actionAst: latest.actionAst,
        effectiveFrom: latest.effectiveFrom,
        effectiveTo: latest.effectiveTo,
        revision: latest.revision + 1,
      })
      if (!revision)
        throw ApiError.conflict('RULE_DRAFT_EXISTS', 'Já existe um rascunho desta regra.')
      return revision
    }, context)
  }

  /**
   * Publica o rascunho: volta a validar contra os campos em vigor e, se estiver tudo bem, desactiva a revisão
   * anterior e torna esta imutável. Uma regra inválida nunca se publica.
   */
  async publish(context: TenantContext, id: string, expectedVersion: number): Promise<Rule> {
    const current = await this.get(context, id)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict('RULE_NOT_DRAFT', 'Só um rascunho se publica.')
    }
    const issues: RuleIssue[] = []
    const target = await this.publishedTarget(context, current.entityCode, issues)
    this.values({}, current, issues, target)
    if (issues.length > 0) throw ruleValidation(issues)
    return this.uow.run((scope) => this.rules.publish(scope, current, expectedVersion), context)
  }

  disable(context: TenantContext, id: string, expectedVersion: number): Promise<Rule> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      if (current.status !== 'PUBLISHED') {
        throw ApiError.conflict('RULE_NOT_PUBLISHED', 'Só uma regra publicada se desactiva.')
      }
      return this.rules.disable(scope, id, expectedVersion)
    }, context)
  }

  /**
   * Avalia a regra sobre valores de exemplo, sem gravar nada e sem efeitos externos. Serve para testar limites
   * antes de publicar; respeita o período de vigência.
   */
  async simulate(
    context: TenantContext,
    id: string,
    input: { values: Record<string, unknown>; now?: string }
  ): Promise<SimulationResult> {
    const rule = await this.get(context, id)
    const now = input.now ? new Date(input.now) : new Date()
    if (Number.isNaN(now.getTime())) {
      throw ruleValidation([
        { path: 'now', code: 'INVALID_DATE', message: 'Instante ISO 8601 com fuso horário.' },
      ])
    }
    if (!isEffective(rule, now))
      return { result: 'SKIPPED', message: null, reason: 'Fora do período de vigência.' }
    try {
      const hit = this.engine.evaluate(rule.conditionAst, {
        subject: {
          membershipId: context.membershipId,
          userId: context.userId,
          organizationId: context.organizationId,
        },
        resource: input.values,
        env: { now: now.toISOString() },
      })
      return hit
        ? { result: 'FAIL', message: rule.actionAst.message, reason: null }
        : { result: 'PASS', message: null, reason: null }
    } catch {
      return { result: 'ERROR', message: null, reason: 'A condição não pôde ser avaliada.' }
    }
  }

  evaluations(context: TenantContext, id: string): Promise<Evaluation[]> {
    return this.uow.run(async (scope) => {
      await this.mustFind(scope, id)
      return this.rules.listEvaluations(scope, id, 50)
    }, context)
  }

  // --- internos ------------------------------------------------------------------------------

  private async mustFind(scope: Parameters<RuleStore['find']>[0], id: string): Promise<Rule> {
    const rule = await this.rules.find(scope, id)
    if (!rule) throw ApiError.notFound()
    return rule
  }

  private async publishedTarget(
    context: TenantContext,
    code: string,
    issues: RuleIssue[]
  ): Promise<RuleTarget | null> {
    const target = await this.targets.findByCode(context, code)
    if (!target) {
      issues.push({
        path: 'entityCode',
        code: 'NOT_FOUND',
        message: 'Entidade inexistente neste tenant.',
      })
      return null
    }
    if (!target.published) {
      issues.push({
        path: 'entityCode',
        code: 'ENTITY_NOT_PUBLISHED',
        message: 'Publique a entidade antes de lhe definir regras.',
      })
    }
    return target
  }

  /** Valida o conteúdo (sobre o rascunho actual, se existir, com as alterações pedidas) e devolve os valores finais. */
  private values(
    input: RuleInput,
    base: Rule | null,
    issues: RuleIssue[],
    target: RuleTarget | null
  ): RuleValues | null {
    const before = issues.length
    const name = (input.name ?? base?.name ?? '').trim()
    if (!name || name.length > 160) {
      issues.push({
        path: 'name',
        code: 'INVALID_NAME',
        message: 'O nome é obrigatório (máx. 160).',
      })
    }
    const description =
      input.description === undefined
        ? (base?.description ?? null)
        : input.description?.trim() || null
    if (description && description.length > 500) {
      issues.push({
        path: 'description',
        code: 'INVALID_DESCRIPTION',
        message: 'Máx. 500 caracteres.',
      })
    }
    const priority = input.priority ?? base?.priority ?? DEFAULT_PRIORITY
    if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) {
      issues.push({
        path: 'priority',
        code: 'INVALID_PRIORITY',
        message: `Prioridade: inteiro de 0 a ${MAX_PRIORITY}.`,
      })
    }
    const from =
      input.effectiveFrom === undefined
        ? (base?.effectiveFrom ?? null)
        : parseInstant(input.effectiveFrom, 'effectiveFrom', issues)
    const to =
      input.effectiveTo === undefined
        ? (base?.effectiveTo ?? null)
        : parseInstant(input.effectiveTo, 'effectiveTo', issues)
    if (from && to && to <= from) {
      issues.push({
        path: 'effectiveTo',
        code: 'INVALID_PERIOD',
        message: 'O fim tem de ser posterior ao início.',
      })
    }

    const conditionAst = input.conditionAst === undefined ? base?.conditionAst : input.conditionAst
    if (conditionAst === undefined) {
      issues.push({ path: 'conditionAst', code: 'REQUIRED', message: 'Indique a condição.' })
    } else {
      for (const issue of this.engine.validate(conditionAst)) {
        issues.push({ ...issue, path: `conditionAst${issue.path.replace(/^\$/, '')}` })
      }
    }
    const action = normalizeAction(
      input.actionAst === undefined ? base?.actionAst : input.actionAst,
      issues
    )
    if (target?.published && conditionAst !== undefined) {
      this.checkReferences(conditionAst, action?.field, target.fields, issues)
    }
    if (issues.length > before || !action || conditionAst === undefined) return null
    return {
      entityDefinitionId: base?.entityDefinitionId ?? target?.id ?? '',
      code: base?.code ?? '',
      name,
      description,
      priority,
      conditionAst,
      actionAst: action,
      effectiveFrom: from,
      effectiveTo: to,
    }
  }

  /** As condições só usam campos activos e **não sensíveis** da entidade (e o contexto permitido). */
  private checkReferences(
    condition: unknown,
    actionField: string | undefined,
    fields: readonly FieldSpec[],
    issues: RuleIssue[]
  ) {
    const usable = new Map(
      fields
        .filter((f) => !f.archived && !f.sensitive && f.type !== 'LOOKUP')
        .map((f) => [f.code, f])
    )
    for (const variable of conditionVariables(condition)) {
      if (SUBJECT_VARIABLES.includes(variable) || ENV_VARIABLES.includes(variable)) continue
      const code = variable.startsWith('resource.') ? variable.slice('resource.'.length) : null
      if (code === null) {
        issues.push({
          path: 'conditionAst',
          code: 'INVALID_VARIABLE',
          message: `A variável "${variable}" não existe em regras.`,
        })
      } else if (!usable.has(code)) {
        const known = fields.find((f) => f.code === code)
        issues.push({
          path: 'conditionAst',
          code: known?.sensitive ? 'SENSITIVE_FIELD' : 'UNKNOWN_FIELD',
          message: known?.sensitive
            ? `O campo sensível "${code}" não pode ser usado numa regra.`
            : `O campo "${code}" não existe (ou está arquivado) nesta entidade.`,
        })
      }
    }
    if (actionField && !fields.some((f) => f.code === actionField && !f.archived)) {
      issues.push({
        path: 'actionAst.field',
        code: 'UNKNOWN_FIELD',
        message: `O campo "${actionField}" não existe nesta entidade.`,
      })
    }
  }
}
