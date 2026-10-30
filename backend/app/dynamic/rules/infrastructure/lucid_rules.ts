import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  Evaluation,
  EvaluationRow,
  Rule,
  RuleStore,
  RuleValues,
} from '#dynamic/rules/application/ports'
import type {
  BlockAction,
  EvaluationResult,
  RuleStatus,
  RuleTrigger,
} from '#dynamic/rules/domain/rule'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never
const json = (value: unknown) => JSON.stringify(value)

interface RuleRow {
  id: string
  entity_definition_id: string
  entity_code: string
  code: string
  name: string
  description: string | null
  trigger: RuleTrigger
  revision: number
  priority: number
  condition_ast: unknown
  action_ast: BlockAction
  status: RuleStatus
  effective_from: Date | null
  effective_to: Date | null
  published_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

/** `r.*` com o código da entidade (a regra aponta para a entidade por id). */
const SELECT = `select r.id, r.entity_definition_id, e.code as entity_code, r.code, r.name, r.description,
  r.trigger, r.revision, r.priority, r.condition_ast, r.action_ast, r.status, r.effective_from, r.effective_to,
  r.published_at, r.version, r.created_at, r.updated_at
  from rule_definitions r
  join entity_definitions e on e.tenant_id = r.tenant_id and e.id = r.entity_definition_id`

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  entityDefinitionId: r.entity_definition_id,
  entityCode: r.entity_code,
  code: r.code,
  name: r.name,
  description: r.description,
  trigger: r.trigger,
  revision: r.revision,
  priority: r.priority,
  conditionAst: r.condition_ast,
  actionAst: r.action_ast,
  status: r.status,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  publishedAt: r.published_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidRuleStore implements RuleStore {
  async list(scope: TenantScope, filter: { entityDefinitionId?: string }) {
    const where = ['r.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.entityDefinitionId) {
      where.push('r.entity_definition_id = ?')
      params.push(filter.entityDefinitionId)
    }
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where ${where.join(' and ')} order by e.code, r.code, r.revision desc`,
      params as never[]
    )
    return (result.rows as RuleRow[]).map(toRule)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(`${SELECT} where r.tenant_id = ? and r.id = ?`, [
      tenantOf(scope),
      id,
    ])
    const [row] = result.rows as RuleRow[]
    return row ? toRule(row) : null
  }

  async latest(scope: TenantScope, entityDefinitionId: string, code: string) {
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where r.tenant_id = ? and r.entity_definition_id = ? and r.code = ?
        order by r.revision desc limit 1`,
      [tenantOf(scope), entityDefinitionId, code]
    )
    const [row] = result.rows as RuleRow[]
    return row ? toRule(row) : null
  }

  async insert(scope: TenantScope, v: RuleValues & { revision: number }) {
    const result = await trxOf(scope).rawQuery(
      `insert into rule_definitions
         (tenant_id, entity_definition_id, code, name, description, revision, priority, condition_ast,
          action_ast, effective_from, effective_to, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tenantOf(scope),
        v.entityDefinitionId,
        v.code,
        v.name,
        v.description as never,
        v.revision,
        v.priority,
        json(v.conditionAst),
        json(v.actionAst),
        v.effectiveFrom as never,
        v.effectiveTo as never,
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
    patch: Partial<Omit<RuleValues, 'entityDefinitionId' | 'code'>>
  ) {
    const columns: [string, unknown][] = [
      ['name', patch.name],
      ['description', patch.description],
      ['priority', patch.priority],
      ['condition_ast', patch.conditionAst === undefined ? undefined : json(patch.conditionAst)],
      ['action_ast', patch.actionAst === undefined ? undefined : json(patch.actionAst)],
      ['effective_from', patch.effectiveFrom],
      ['effective_to', patch.effectiveTo],
    ]
    const entries = columns.filter(([, value]) => value !== undefined)
    const sets = entries.map(([column]) => `"${column}" = ?`).join(', ')
    const result = await trxOf(scope).rawQuery(
      `update rule_definitions
          set ${sets}${sets ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ?
        returning id`,
      [...entries.map(([, v]) => v as never), actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async publish(scope: TenantScope, rule: Rule, expectedVersion: number) {
    // A revisão em vigor passa a DISABLED antes de a nova entrar (um só PUBLISHED por regra).
    await trxOf(scope).rawQuery(
      `update rule_definitions set status = 'DISABLED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and entity_definition_id = ? and code = ? and status = 'PUBLISHED'`,
      [actorOf(scope), tenantOf(scope), rule.entityDefinitionId, rule.code]
    )
    const result = await trxOf(scope).rawQuery(
      `update rule_definitions
          set status = 'PUBLISHED', published_at = now(), published_by_membership_id = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'DRAFT'
        returning id`,
      [actorOf(scope), actorOf(scope), tenantOf(scope), rule.id, expectedVersion]
    )
    return this.afterWrite(scope, rule.id, result.rows.length > 0)
  }

  async disable(scope: TenantScope, id: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update rule_definitions set status = 'DISABLED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'PUBLISHED'
        returning id`,
      [actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async listPublished(scope: TenantScope, entityDefinitionId: string) {
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where r.tenant_id = ? and r.entity_definition_id = ? and r.status = 'PUBLISHED'
          and r.trigger = 'VALIDATE'
        order by r.priority desc, r.code`,
      [tenantOf(scope), entityDefinitionId]
    )
    return (result.rows as RuleRow[]).map(toRule)
  }

  async insertEvaluations(scope: TenantScope, rows: EvaluationRow[]) {
    for (const row of rows) {
      await trxOf(scope).rawQuery(
        `insert into rule_evaluations
           (tenant_id, rule_definition_id, resource_id, correlation_id, input_hash, result, duration_ms, error_code,
            created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantOf(scope),
          row.ruleId,
          row.resourceId as never,
          row.correlationId,
          row.inputHash,
          row.result,
          row.durationMs,
          row.errorCode as never,
          actorOf(scope),
          actorOf(scope),
        ]
      )
    }
  }

  async listEvaluations(scope: TenantScope, ruleId: string, limit: number): Promise<Evaluation[]> {
    const result = await trxOf(scope).rawQuery(
      `select id, rule_definition_id, resource_id, correlation_id, input_hash, result, duration_ms, error_code, created_at
         from rule_evaluations where tenant_id = ? and rule_definition_id = ?
        order by created_at desc, id limit ?`,
      [tenantOf(scope), ruleId, limit]
    )
    return (
      result.rows as {
        id: string
        rule_definition_id: string
        resource_id: string | null
        correlation_id: string | null
        input_hash: string
        result: EvaluationResult
        duration_ms: number
        error_code: string | null
        created_at: Date
      }[]
    ).map((r) => ({
      id: r.id,
      ruleId: r.rule_definition_id,
      resourceId: r.resource_id,
      correlationId: r.correlation_id ?? '',
      inputHash: r.input_hash,
      result: r.result,
      durationMs: r.duration_ms,
      errorCode: r.error_code,
      createdAt: r.created_at,
    }))
  }

  /** Lê a regra depois de uma escrita com controlo de versão: 404 se não existe, 409 se a versão mudou. */
  private async afterWrite(scope: TenantScope, id: string, written: boolean): Promise<Rule> {
    const rule = await this.find(scope, id)
    if (!rule) throw ApiError.notFound()
    if (!written) throw ApiError.versionConflict(rule.version)
    return rule
  }
}
