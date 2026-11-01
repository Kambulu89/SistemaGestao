import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  ENV_VARIABLES,
  SUBJECT_VARIABLES,
  WORKFLOW_CODE,
  conditionVariables,
  normalizeGraph,
  type WorkflowIssue,
  type WorkflowStatus,
} from '#dynamic/workflows/domain/workflow'
import type {
  ConditionEngine,
  Directory,
  WorkflowDefinition,
  WorkflowStore,
  WorkflowTarget,
  WorkflowTargets,
  WorkflowValues,
  WorkflowView,
} from '#dynamic/workflows/application/ports'

export const workflowValidation = (details: WorkflowIssue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export interface WorkflowInput {
  name?: string
  description?: string | null
  graph?: unknown
}

export interface PreviewResult {
  issues: WorkflowIssue[]
  publishable: boolean
}

/** Tipos de campo que podem dar o montante e a moeda de um processo. */
const AMOUNT_TYPES = ['DECIMAL']
const CURRENCY_TYPES = ['TEXT', 'SELECT']

/**
 * Casos de uso das definições de workflow (C14): rascunho → publicação imutável → retirada. Guardar um rascunho exige só
 * que esteja bem formado; publicar verifica as condições e os campos contra a entidade e que **todos os responsáveis
 * sejam resolvíveis** (membro activo, ou papel existente com pelo menos um titular activo).
 */
export class DefinitionUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly workflows: WorkflowStore,
    private readonly targets: WorkflowTargets,
    private readonly engine: ConditionEngine,
    private readonly directory: Directory,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async list(
    context: TenantContext,
    filter: { entityCode?: string; status?: WorkflowStatus }
  ): Promise<WorkflowView[]> {
    let entityDefinitionId: string | undefined
    if (filter.entityCode) {
      const target = await this.targets.findByCode(context, filter.entityCode)
      if (!target) return []
      entityDefinitionId = target.id
    }
    const rows = await this.uow.run(
      (scope) => this.workflows.list(scope, { entityDefinitionId, status: filter.status }),
      context
    )
    return this.withIssues(context, rows)
  }

  async get(context: TenantContext, id: string): Promise<WorkflowView> {
    const row = await this.uow.run((scope) => this.mustFind(scope, id), context)
    const [view] = await this.withIssues(context, [row])
    return view as WorkflowView
  }

  async create(
    context: TenantContext,
    input: WorkflowInput & { entityCode: string; code: string }
  ): Promise<WorkflowDefinition> {
    const issues: WorkflowIssue[] = []
    const code = input.code.trim()
    if (!WORKFLOW_CODE.test(code)) {
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    }
    const target = await this.targets.findByCode(context, input.entityCode)
    if (!target) {
      issues.push({
        path: 'entityCode',
        code: 'NOT_FOUND',
        message: 'Entidade inexistente neste tenant.',
      })
    } else if (!target.published) {
      issues.push({
        path: 'entityCode',
        code: 'ENTITY_NOT_PUBLISHED',
        message: 'Publique a entidade antes de lhe definir um workflow.',
      })
    }
    const values = this.values(input, null, issues)
    if (issues.length > 0 || !target || !values) throw workflowValidation(issues)

    return this.uow.run(async (scope) => {
      if (await this.workflows.latest(scope, target.id, code)) {
        throw ApiError.conflict(
          'WORKFLOW_CODE_TAKEN',
          'Já existe um workflow com este código: abra uma nova revisão.'
        )
      }
      const created = await this.workflows.insert(scope, {
        ...values,
        entityDefinitionId: target.id,
        code,
        revision: 1,
      })
      if (!created) {
        throw ApiError.conflict('WORKFLOW_CODE_TAKEN', 'Já existe um workflow com este código.')
      }
      return created
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: WorkflowInput & { expectedVersion: number }
  ): Promise<WorkflowDefinition> {
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict(
        'WORKFLOW_NOT_DRAFT',
        'Só um rascunho se altera: abra uma nova revisão.'
      )
    }
    const issues: WorkflowIssue[] = []
    const values = this.values(input, current, issues)
    if (issues.length > 0 || !values) throw workflowValidation(issues)
    return this.uow.run(
      (scope) =>
        this.workflows.update(scope, id, input.expectedVersion, {
          name: values.name,
          description: values.description,
          graph: values.graph,
        }),
      context
    )
  }

  createRevision(context: TenantContext, id: string): Promise<WorkflowDefinition> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      const latest = (await this.workflows.latest(
        scope,
        current.entityDefinitionId,
        current.code
      )) as WorkflowDefinition
      if (latest.status === 'DRAFT') {
        throw ApiError.conflict('WORKFLOW_DRAFT_EXISTS', 'Já existe um rascunho deste workflow.')
      }
      const revision = await this.workflows.insert(scope, {
        entityDefinitionId: latest.entityDefinitionId,
        code: latest.code,
        name: latest.name,
        description: latest.description,
        graph: latest.graph,
        revision: latest.revision + 1,
      })
      if (!revision) {
        throw ApiError.conflict('WORKFLOW_DRAFT_EXISTS', 'Já existe um rascunho deste workflow.')
      }
      return revision
    }, context)
  }

  async preview(context: TenantContext, id: string): Promise<PreviewResult> {
    const workflow = await this.uow.run((scope) => this.mustFind(scope, id), context)
    const issues = await this.integrity(context, workflow)
    return { issues, publishable: workflow.status === 'DRAFT' && issues.length === 0 }
  }

  /** Publica o rascunho: verifica-o agora, retira a revisão anterior e torna esta imutável. */
  async publish(
    context: TenantContext,
    id: string,
    expectedVersion: number
  ): Promise<WorkflowDefinition> {
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict('WORKFLOW_NOT_DRAFT', 'Só um rascunho se publica.')
    }
    const issues = await this.integrity(context, current)
    if (issues.length > 0) throw workflowValidation(issues)
    return this.uow.run((scope) => this.workflows.publish(scope, current, expectedVersion), context)
  }

  retire(context: TenantContext, id: string, expectedVersion: number): Promise<WorkflowDefinition> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      if (current.status !== 'PUBLISHED') {
        throw ApiError.conflict('WORKFLOW_NOT_PUBLISHED', 'Só um workflow publicado se retira.')
      }
      return this.workflows.retire(scope, id, expectedVersion)
    }, context)
  }

  // --- internos ------------------------------------------------------------------------------

  private async mustFind(scope: TenantScope, id: string): Promise<WorkflowDefinition> {
    const row = await this.workflows.find(scope, id)
    if (!row) throw ApiError.notFound()
    return row
  }

  private values(
    input: WorkflowInput,
    base: WorkflowDefinition | null,
    issues: WorkflowIssue[]
  ): WorkflowValues | null {
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
    const graph = normalizeGraph(input.graph === undefined ? base?.graph : input.graph, issues)
    if (issues.length > before) return null
    return {
      entityDefinitionId: base?.entityDefinitionId ?? '',
      code: base?.code ?? '',
      name,
      description,
      graph,
    }
  }

  /** Condições e campos contra a entidade, e responsáveis resolvíveis. */
  private async integrity(
    context: TenantContext,
    workflow: WorkflowDefinition
  ): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []
    const target = await this.targets.findById(context, workflow.entityDefinitionId)
    if (!target?.published) {
      return [
        {
          path: 'entityCode',
          code: 'ENTITY_NOT_PUBLISHED',
          message: 'A entidade já não está publicada.',
        },
      ]
    }
    this.checkFields(workflow, target, issues)
    const now = this.clock()
    await this.uow.run(async (scope) => {
      for (const [i, stage] of workflow.graph.stages.entries()) {
        const path = `graph.stages[${i}]`
        if (stage.condition !== undefined)
          this.checkCondition(stage.condition, path, target, issues)
        for (const [j, approver] of stage.approvers.entries()) {
          const at = `${path}.approvers[${j}]`
          if (approver.type === 'MEMBERSHIP') {
            if (!(await this.directory.isActive(scope, approver.id))) {
              issues.push({
                path: at,
                code: 'APPROVER_UNRESOLVABLE',
                message: 'O membro não existe ou não está activo.',
              })
            }
          } else if (!(await this.directory.roleExists(scope, approver.id))) {
            issues.push({ path: at, code: 'APPROVER_UNRESOLVABLE', message: 'O papel não existe.' })
          } else if (!(await this.directory.hasActiveHolder(scope, approver.id, now))) {
            issues.push({
              path: at,
              code: 'APPROVER_UNRESOLVABLE',
              message: 'Nenhum membro activo tem este papel.',
            })
          }
        }
      }
    }, context)
    return issues
  }

  private checkFields(
    workflow: WorkflowDefinition,
    target: WorkflowTarget,
    issues: WorkflowIssue[]
  ) {
    const { amountField, currencyField } = workflow.graph
    if (amountField !== undefined) {
      const type = target.readableFields.get(amountField)
      if (!type || !AMOUNT_TYPES.includes(type)) {
        issues.push({
          path: 'graph.amountField',
          code: 'INVALID_AMOUNT_FIELD',
          message: `«${amountField}» tem de ser um campo decimal activo e não sensível.`,
        })
      }
    }
    if (currencyField !== undefined) {
      const type = target.readableFields.get(currencyField)
      if (!type || !CURRENCY_TYPES.includes(type)) {
        issues.push({
          path: 'graph.currencyField',
          code: 'INVALID_CURRENCY_FIELD',
          message: `«${currencyField}» tem de ser um campo de texto ou de escolha activo e não sensível.`,
        })
      }
    }
  }

  private checkCondition(
    condition: unknown,
    path: string,
    target: WorkflowTarget,
    issues: WorkflowIssue[]
  ) {
    for (const problem of this.engine.validate(condition)) {
      issues.push({ ...problem, path: `${path}.condition${problem.path.replace(/^\$/, '')}` })
    }
    for (const variable of conditionVariables(condition)) {
      if (SUBJECT_VARIABLES.includes(variable) || ENV_VARIABLES.includes(variable)) continue
      const field = variable.startsWith('resource.') ? variable.slice('resource.'.length) : null
      if (field === null) {
        issues.push({
          path: `${path}.condition`,
          code: 'INVALID_VARIABLE',
          message: `A variável «${variable}» não existe.`,
        })
      } else if (!target.readableFields.has(field)) {
        issues.push({
          path: `${path}.condition`,
          code: 'UNKNOWN_FIELD',
          message: `O campo «${field}» não existe, está arquivado ou é sensível: não pode condicionar uma etapa.`,
        })
      }
    }
  }

  private async withIssues(
    context: TenantContext,
    rows: WorkflowDefinition[]
  ): Promise<WorkflowView[]> {
    const views: WorkflowView[] = []
    for (const row of rows) {
      views.push({
        ...row,
        issues: row.status === 'PUBLISHED' ? await this.integrity(context, row) : [],
      })
    }
    return views
  }
}
