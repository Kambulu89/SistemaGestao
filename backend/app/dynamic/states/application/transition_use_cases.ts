import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { transitionsFrom, type TransitionDef } from '#dynamic/states/domain/state_machine'
import type {
  AccessControl,
  ConditionEngine,
  Machine,
  MachineStore,
  RecordGateway,
  RecordSnapshot,
  RecordStateRow,
  RecordStateStore,
  StateHistoryEntry,
  StateTarget,
  StateTargets,
} from '#dynamic/states/application/ports'

export const TRANSITION_PERMISSION = 'dynamic.transition'
const MAX_REASON = 500

export interface AvailableAction {
  code: string
  label: string
  to: string
  toLabel: string
  reasonRequired: boolean
}

export interface AvailableActions {
  state: { code: string; label: string; version: number }
  actions: AvailableAction[]
}

export interface TransitionResult {
  recordId: string
  fromState: string
  toState: string
  version: number
}

/**
 * Executar transições (C13). Uma transição só existe se a máquina em vigor a define a partir do estado actual; exige a
 * permissão `dynamic.transition` (com os atributos do registo, incluindo o estado, para as políticas ABAC) e a da própria
 * transição, `expectedVersion`, a guarda a verdadeiro sobre os dados actuais e o motivo quando é obrigatório. O estado, o
 * histórico e o evento de outbox escrevem-se na **mesma transacção**, com o estado do registo bloqueado.
 */
export class TransitionUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly machines: MachineStore,
    private readonly states: RecordStateStore,
    private readonly targets: StateTargets,
    private readonly records: RecordGateway,
    private readonly access: AccessControl,
    private readonly engine: ConditionEngine,
    private readonly outbox: OutboxWriter,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** As acções que o utilizador pode executar agora neste registo (o servidor é que decide; a interface só mostra). */
  async availableActions(
    context: TenantContext,
    entityCode: string,
    recordId: string
  ): Promise<AvailableActions> {
    const target = await this.mustFindTarget(context, entityCode)
    const record = await this.records.get(context, entityCode, recordId)
    const { row, machine } = await this.uow.run(async (scope) => {
      const stored = await this.states.find(scope, recordId)
      if (!stored) return { row: null, machine: null }
      return { row: stored, machine: await this.machineFor(scope, target, stored) }
    }, context)
    if (!row || !machine) throw this.noState()
    const state = machine.states.find((s) => s.code === row.stateCode)
    if (!state) throw this.unknownState(row.stateCode)

    const actions: AvailableAction[] = []
    for (const transition of transitionsFrom(machine.transitions, row.stateCode)) {
      if (await this.allowed(context, target, record, row, transition)) {
        actions.push({
          code: transition.code,
          label: transition.label,
          to: transition.to,
          toLabel: machine.states.find((s) => s.code === transition.to)?.label ?? transition.to,
          reasonRequired: transition.reasonRequired,
        })
      }
    }
    return { state: { code: state.code, label: state.label, version: row.version }, actions }
  }

  async execute(
    context: TenantContext,
    entityCode: string,
    recordId: string,
    transitionCode: string,
    input: { expectedVersion: number; reason?: string | null }
  ): Promise<TransitionResult> {
    const target = await this.mustFindTarget(context, entityCode)
    const reason = input.reason?.trim() || null
    if (reason && reason.length > MAX_REASON) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
        {
          path: 'reason',
          code: 'INVALID_REASON',
          message: `O motivo tem no máximo ${MAX_REASON} caracteres.`,
        },
      ])
    }
    // Um registo inexistente, alheio ou que não pode ler é sempre 404 (antes de qualquer consulta de estado).
    await this.records.get(context, entityCode, recordId)
    return this.uow.run(async (scope) => {
      // 1. Bloqueia o estado: duas transições do mesmo registo nunca correm ao mesmo tempo.
      const row = await this.states.lock(scope, recordId)
      if (!row || row.entityDefinitionId !== target.id) throw this.noState()
      if (row.version !== input.expectedVersion) throw ApiError.versionConflict(row.version)
      const machine = await this.machineFor(scope, target, row)
      const transition = machine.transitions.find(
        (t) => t.code === transitionCode && t.from.includes(row.stateCode)
      )
      if (!transition) {
        throw ApiError.conflict(
          'TRANSITION_NOT_AVAILABLE',
          `A transição «${transitionCode}» não existe a partir do estado «${row.stateCode}».`
        )
      }
      // 2. Dados actuais, permissões e guarda.
      const record = await this.records.get(context, entityCode, recordId)
      if (record.archived) throw ApiError.conflict('RECORD_ARCHIVED', 'O registo está arquivado.')
      await this.assertAllowed(context, target, record, row, transition)
      if (transition.reasonRequired && !reason) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
          { path: 'reason', code: 'REASON_REQUIRED', message: 'Esta transição exige um motivo.' },
        ])
      }
      // 3. Estado, histórico e evento: na mesma transacção.
      const moved = await this.states.move(scope, row, machine.id, transition.to)
      await this.states.insertHistory(scope, {
        entityDefinitionId: target.id,
        recordId,
        machineId: machine.id,
        transitionCode: transition.code,
        fromState: row.stateCode,
        toState: transition.to,
        actorMembershipId: context.membershipId,
        reason,
        correlationId: context.correlationId,
      })
      await this.outbox.append(scope, {
        aggregateType: 'dynamic_record',
        aggregateId: recordId,
        aggregateVersion: moved.version,
        eventType: 'dynamic.record.state_changed',
        payload: {
          entityCode,
          recordId,
          machineCode: machine.code,
          machineRevision: machine.revision,
          transition: transition.code,
          fromState: row.stateCode,
          toState: transition.to,
          actorMembershipId: context.membershipId,
        },
        correlationId: context.correlationId,
      })
      return {
        recordId,
        fromState: row.stateCode,
        toState: transition.to,
        version: moved.version,
      }
    }, context)
  }

  async history(
    context: TenantContext,
    entityCode: string,
    recordId: string
  ): Promise<StateHistoryEntry[]> {
    const target = await this.mustFindTarget(context, entityCode)
    await this.records.get(context, entityCode, recordId)
    return this.uow.run(async (scope) => {
      const rows = await this.states.history(scope, recordId)
      return rows.filter((r) => r.entityDefinitionId === target.id)
    }, context)
  }

  // --- internos ------------------------------------------------------------------------------

  private async mustFindTarget(context: TenantContext, code: string): Promise<StateTarget> {
    const target = await this.targets.findByCode(context, code)
    if (!target) throw ApiError.notFound()
    return target
  }

  /**
   * A máquina que decide as transições: a em vigor da entidade. Um registo ainda ligado a uma revisão anterior só segue
   * se o seu estado existir na em vigor (a publicação impede que um estado em uso desapareça).
   */
  private async machineFor(
    scope: TenantScope,
    target: StateTarget,
    row: RecordStateRow
  ): Promise<Machine> {
    const current = await this.machines.findPublishedForEntity(scope, target.id)
    if (!current) {
      throw ApiError.conflict(
        'NO_STATE_MACHINE',
        'A entidade já não tem uma máquina de estados em vigor.'
      )
    }
    if (!current.states.some((s) => s.code === row.stateCode))
      throw this.unknownState(row.stateCode)
    return current
  }

  private noState() {
    return ApiError.conflict(
      'RECORD_WITHOUT_STATE',
      'Este registo não tem estado: foi criado antes da máquina de estados.'
    )
  }

  private unknownState(code: string) {
    return ApiError.conflict(
      'STATE_UNKNOWN',
      `O estado «${code}» já não existe na máquina em vigor.`
    )
  }

  private resource(target: StateTarget, record: RecordSnapshot, row: RecordStateRow) {
    return {
      entity: target.code,
      ownershipMode: target.ownershipMode,
      state: row.stateCode,
      ...(record.organizationUnitId ? { unitId: record.organizationUnitId } : {}),
      ...(record.ownerMembershipId ? { ownerMembershipId: record.ownerMembershipId } : {}),
    }
  }

  private guardPasses(
    context: TenantContext,
    record: RecordSnapshot,
    transition: TransitionDef
  ): boolean {
    if (transition.guard === undefined) return true
    return this.engine.evaluate(transition.guard, {
      subject: {
        membershipId: context.membershipId,
        userId: context.userId,
        organizationId: context.organizationId,
      },
      resource: record.data,
      env: { now: this.clock().toISOString() },
    })
  }

  /** Para a lista de acções: tudo o que a execução exigiria, sem lançar. */
  private async allowed(
    context: TenantContext,
    target: StateTarget,
    record: RecordSnapshot,
    row: RecordStateRow,
    transition: TransitionDef
  ): Promise<boolean> {
    try {
      await this.assertAllowed(context, target, record, row, transition)
      return true
    } catch (error) {
      if (error instanceof ApiError) return false
      throw error
    }
  }

  private async assertAllowed(
    context: TenantContext,
    target: StateTarget,
    record: RecordSnapshot,
    row: RecordStateRow,
    transition: TransitionDef
  ): Promise<void> {
    const resource = this.resource(target, record, row)
    if (!(await this.access.allowed(context, TRANSITION_PERMISSION, resource))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
    }
    if (
      transition.permission &&
      !(await this.access.allowed(context, transition.permission, resource))
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
    }
    let passes: boolean
    try {
      passes = this.guardPasses(context, record, transition)
    } catch {
      // Falha fechada: uma guarda que não se consegue avaliar bloqueia a transição.
      throw ApiError.conflict(
        'TRANSITION_GUARD_ERROR',
        'A condição da transição não pôde ser avaliada.'
      )
    }
    if (!passes) {
      throw ApiError.conflict(
        'TRANSITION_GUARD_FAILED',
        'Os dados actuais do registo não satisfazem a condição desta transição.'
      )
    }
  }
}
