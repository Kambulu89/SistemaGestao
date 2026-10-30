import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  buildQuery,
  MAX_PAGE,
  validateQuery,
  visibleFields,
  type DatasetDefinition,
  type DatasetField,
  type Filter,
  type ReportQuery,
} from '#modules/reporting/domain/reporting'
import { denied, reportValidation } from '#modules/reporting/application/errors'
import type { Authorizer, Clock, QueryRunner } from '#modules/reporting/application/ports'

export interface RunResult {
  dataset: string
  columns: { code: string; label: string; type: string }[]
  rows: Record<string, unknown>[]
  total: number
  /** Campos pedidos que esta pessoa não vê e que por isso não vêm no resultado. */
  omittedFields: string[]
  /** Os dados são lidos em tempo real: este é o instante da leitura. */
  asOf: string
}

export interface Paging {
  limit?: number
  offset?: number
}

/**
 * Corre consultas declarativas. A autorização vem **antes** de agregar: sem a permissão do dataset não se corre nada, os
 * campos sensíveis e os escondidos por política ABAC saem do resultado, e filtrar, agrupar ou medir por um campo que a
 * pessoa não vê é recusado (senão um total revelaria o que o campo escondido guarda).
 */
export class QueryService {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly runner: QueryRunner,
    private readonly authorizer: Authorizer,
    private readonly clock: Clock
  ) {}

  /** Os campos que `context` não vê neste dataset; 403 se nem o dataset pode ler. */
  async hiddenFields(context: TenantContext, dataset: DatasetDefinition): Promise<Set<string>> {
    const base = await this.authorizer.decide(context, dataset.permission)
    if (!base.allowed) throw denied()
    const hidden = new Set(base.hiddenFields)
    const extra = new Map<string, boolean>()
    for (const field of dataset.fields) {
      if (!field.permission) continue
      if (!extra.has(field.permission)) {
        const decision = await this.authorizer.decide(context, field.permission)
        extra.set(field.permission, decision.allowed)
      }
      if (!extra.get(field.permission)) hidden.add(field.code)
    }
    return hidden
  }

  async visible(context: TenantContext, dataset: DatasetDefinition): Promise<DatasetField[]> {
    return visibleFields(dataset, await this.hiddenFields(context, dataset))
  }

  async run(
    context: TenantContext,
    dataset: DatasetDefinition,
    raw: Partial<Record<keyof ReportQuery, unknown>>,
    paging: Paging = {}
  ): Promise<RunResult> {
    const hidden = await this.hiddenFields(context, dataset)
    const { value, issues } = validateQuery(dataset, raw, hidden)
    if (!value) throw reportValidation(issues)
    const limit = Math.min(Math.max(paging.limit ?? 50, 1), MAX_PAGE)
    const built = buildQuery(dataset, value, context.tenantId, {
      limit,
      offset: Math.max(paging.offset ?? 0, 0),
    })
    const { rows, total } = await this.uow.run((scope) => this.runner.run(scope, built), context)
    const asked = Array.isArray(raw.select) ? (raw.select as unknown[]) : []
    return {
      dataset: dataset.code,
      columns: built.columns.map((c) => ({ code: c.code, label: c.label, type: c.type })),
      rows,
      total,
      omittedFields: asked.filter((c): c is string => typeof c === 'string' && hidden.has(c)),
      asOf: this.clock.now().toISOString(),
    }
  }
}

export const asFilters = (value: unknown): Filter[] =>
  Array.isArray(value) ? (value as Filter[]) : []
