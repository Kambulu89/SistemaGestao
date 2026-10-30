import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  ENV_VARIABLES,
  MACHINE_CODE,
  SUBJECT_VARIABLES,
  checkMachine,
  conditionVariables,
  normalizeStates,
  normalizeTransitions,
  type MachineIssue,
  type MachineStatus,
} from '#dynamic/states/domain/state_machine'
import type {
  ConditionEngine,
  Machine,
  MachineStore,
  MachineValues,
  MachineView,
  PermissionCatalog,
  RecordStateStore,
  StateTarget,
  StateTargets,
} from '#dynamic/states/application/ports'

export const machineValidation = (details: MachineIssue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export interface MachineInput {
  name?: string
  description?: string | null
  states?: unknown
  transitions?: unknown
}

export interface PreviewResult {
  issues: MachineIssue[]
  publishable: boolean
}

/**
 * Casos de uso das máquinas de estados (C13): rascunho → publicação imutável → retirada. Guardar um rascunho exige só que
 * esteja bem formado; publicar verifica a integridade (um estado inicial, estados alcançáveis), as guardas contra os campos da
 * entidade e que nenhum estado em uso por registos desapareça. Uma só máquina em vigor por entidade.
 */
export class MachineUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly machines: MachineStore,
    private readonly recordStates: RecordStateStore,
    private readonly targets: StateTargets,
    private readonly engine: ConditionEngine,
    private readonly catalog: PermissionCatalog
  ) {}

  async list(
    context: TenantContext,
    filter: { entityCode?: string; status?: MachineStatus }
  ): Promise<MachineView[]> {
    let entityDefinitionId: string | undefined
    if (filter.entityCode) {
      const target = await this.targets.findByCode(context, filter.entityCode)
      if (!target) return []
      entityDefinitionId = target.id
    }
    const machines = await this.uow.run(
      (scope) => this.machines.list(scope, { entityDefinitionId, status: filter.status }),
      context
    )
    return this.withIssues(context, machines)
  }

  async get(context: TenantContext, id: string): Promise<MachineView> {
    const machine = await this.uow.run((scope) => this.mustFind(scope, id), context)
    const [view] = await this.withIssues(context, [machine])
    return view as MachineView
  }

  async create(
    context: TenantContext,
    input: MachineInput & { entityCode: string; code: string }
  ): Promise<Machine> {
    const issues: MachineIssue[] = []
    const code = input.code.trim()
    if (!MACHINE_CODE.test(code)) {
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    }
    const target = await this.publishedTarget(context, input.entityCode, issues)
    const values = this.values(input, null, issues)
    if (issues.length > 0 || !target || !values) throw machineValidation(issues)

    return this.uow.run(async (scope) => {
      if (await this.machines.latest(scope, target.id, code)) {
        throw ApiError.conflict(
          'STATE_MACHINE_CODE_TAKEN',
          'Já existe uma máquina com este código: abra uma nova revisão.'
        )
      }
      const machine = await this.machines.insert(scope, {
        ...values,
        entityDefinitionId: target.id,
        code,
        revision: 1,
      })
      if (!machine)
        throw ApiError.conflict(
          'STATE_MACHINE_CODE_TAKEN',
          'Já existe uma máquina com este código.'
        )
      return machine
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: MachineInput & { expectedVersion: number }
  ): Promise<Machine> {
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict(
        'STATE_MACHINE_NOT_DRAFT',
        'Só um rascunho se altera: abra uma nova revisão.'
      )
    }
    const issues: MachineIssue[] = []
    const values = this.values(input, current, issues)
    if (issues.length > 0 || !values) throw machineValidation(issues)
    return this.uow.run(
      (scope) =>
        this.machines.update(scope, id, input.expectedVersion, {
          name: values.name,
          description: values.description,
          states: values.states,
          transitions: values.transitions,
        }),
      context
    )
  }

  createRevision(context: TenantContext, id: string): Promise<Machine> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      const latest = (await this.machines.latest(
        scope,
        current.entityDefinitionId,
        current.code
      )) as Machine
      if (latest.status === 'DRAFT') {
        throw ApiError.conflict(
          'STATE_MACHINE_DRAFT_EXISTS',
          'Já existe um rascunho desta máquina.'
        )
      }
      const revision = await this.machines.insert(scope, {
        entityDefinitionId: latest.entityDefinitionId,
        code: latest.code,
        name: latest.name,
        description: latest.description,
        states: latest.states,
        transitions: latest.transitions,
        revision: latest.revision + 1,
      })
      if (!revision) {
        throw ApiError.conflict(
          'STATE_MACHINE_DRAFT_EXISTS',
          'Já existe um rascunho desta máquina.'
        )
      }
      return revision
    }, context)
  }

  async preview(context: TenantContext, id: string): Promise<PreviewResult> {
    const machine = await this.uow.run((scope) => this.mustFind(scope, id), context)
    const issues = await this.integrity(context, machine)
    return { issues, publishable: machine.status === 'DRAFT' && issues.length === 0 }
  }

  /**
   * Publica o rascunho: verifica-o contra a entidade em vigor e contra os registos que já têm estado (um estado em uso não
   * pode desaparecer), retira a revisão anterior e torna esta imutável.
   */
  async publish(context: TenantContext, id: string, expectedVersion: number): Promise<Machine> {
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict('STATE_MACHINE_NOT_DRAFT', 'Só um rascunho se publica.')
    }
    const issues = await this.integrity(context, current)
    if (issues.length > 0) throw machineValidation(issues)
    return this.uow.run(async (scope) => {
      const inUse = await this.recordStates.codesInUse(scope, current.entityDefinitionId)
      const kept = new Set(current.states.map((s) => s.code))
      const lost = [...inUse].filter((code) => !kept.has(code))
      if (lost.length > 0) {
        throw ApiError.conflict(
          'STATE_IN_USE',
          `Há registos nos estados ${lost.map((c) => `«${c}»`).join(', ')}: mantenha-os (a migração de registos em curso exige um mapeamento explícito).`
        )
      }
      return this.machines.publish(scope, current, expectedVersion)
    }, context)
  }

  retire(context: TenantContext, id: string, expectedVersion: number): Promise<Machine> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      if (current.status !== 'PUBLISHED') {
        throw ApiError.conflict(
          'STATE_MACHINE_NOT_PUBLISHED',
          'Só uma máquina publicada se retira.'
        )
      }
      return this.machines.retire(scope, id, expectedVersion)
    }, context)
  }

  // --- internos ------------------------------------------------------------------------------

  private async mustFind(scope: TenantScope, id: string): Promise<Machine> {
    const machine = await this.machines.find(scope, id)
    if (!machine) throw ApiError.notFound()
    return machine
  }

  private async publishedTarget(
    context: TenantContext,
    code: string,
    issues: MachineIssue[]
  ): Promise<StateTarget | null> {
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
        message: 'Publique a entidade antes de lhe definir uma máquina de estados.',
      })
    }
    return target
  }

  private values(
    input: MachineInput,
    base: Machine | null,
    issues: MachineIssue[]
  ): MachineValues | null {
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
    const states = normalizeStates(input.states === undefined ? base?.states : input.states, issues)
    const transitions = normalizeTransitions(
      input.transitions === undefined ? (base?.transitions ?? []) : input.transitions,
      issues
    )
    if (issues.length > before) return null
    return {
      entityDefinitionId: base?.entityDefinitionId ?? '',
      code: base?.code ?? '',
      name,
      description,
      states,
      transitions,
    }
  }

  /** Integridade do grafo, guardas contra os campos da entidade e permissões conhecidas. */
  private async integrity(context: TenantContext, machine: Machine): Promise<MachineIssue[]> {
    const issues = checkMachine(machine.states, machine.transitions)
    const target = await this.targets.findById(context, machine.entityDefinitionId)
    if (!target?.published) {
      return [
        ...issues,
        {
          path: 'entityCode',
          code: 'ENTITY_NOT_PUBLISHED',
          message: 'A entidade já não está publicada.',
        },
      ]
    }
    machine.transitions.forEach((t, i) => {
      const path = `transitions[${i}]`
      if (t.permission && !this.catalog.has(t.permission)) {
        issues.push({
          path: `${path}.permission`,
          code: 'UNKNOWN_PERMISSION',
          message: `A permissão «${t.permission}» não existe.`,
        })
      }
      if (t.guard === undefined) return
      for (const problem of this.engine.validate(t.guard)) {
        issues.push({ ...problem, path: `${path}.guard${problem.path.replace(/^\$/, '')}` })
      }
      for (const variable of conditionVariables(t.guard)) {
        if (SUBJECT_VARIABLES.includes(variable) || ENV_VARIABLES.includes(variable)) continue
        const field = variable.startsWith('resource.') ? variable.slice('resource.'.length) : null
        if (field === null) {
          issues.push({
            path: `${path}.guard`,
            code: 'INVALID_VARIABLE',
            message: `A variável «${variable}» não existe.`,
          })
        } else if (!target.readableFields.has(field)) {
          issues.push({
            path: `${path}.guard`,
            code: 'UNKNOWN_FIELD',
            message: `O campo «${field}» não existe, está arquivado ou é sensível: não pode condicionar uma transição.`,
          })
        }
      }
    })
    return issues
  }

  /** Junta a cada máquina publicada o que o servidor verifica agora contra a entidade. */
  private async withIssues(context: TenantContext, machines: Machine[]): Promise<MachineView[]> {
    const views: MachineView[] = []
    for (const machine of machines) {
      views.push({
        ...machine,
        issues: machine.status === 'PUBLISHED' ? await this.integrity(context, machine) : [],
      })
    }
    return views
  }
}
