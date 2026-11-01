import { ApiError } from '#core/http/api_error'
import { memberOf } from '#dynamic/workflows/application/actor'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  createsCycle,
  normalizeScope,
  type WorkflowIssue,
} from '#dynamic/workflows/domain/workflow'
import type { Delegation, DelegationStore, Directory } from '#dynamic/workflows/application/ports'

const MAX_PERIOD_MS = 366 * 24 * 3_600_000
const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/
const CURRENCY = /^[A-Z]{3}$/

export type DelegationView = Delegation & { direction: 'GIVEN' | 'RECEIVED' }

export interface DelegationInput {
  toMembershipId: string
  validFrom?: Date | null
  validUntil: Date
  scope?: unknown
  maxAmount?: string | null
  currency?: string | null
  reason: string
}

/**
 * Delegações de aprovação (C14): quem delega é sempre o próprio utilizador, por um período limitado (máx. um ano), para um
 * membro activo, com âmbito por workflow e um montante máximo opcional. Não há cadeias: o delegado age em nome de quem lhe
 * delegou, nunca em nome de quem delegou a este. Uma delegação que fecharia um ciclo é recusada.
 */
export class DelegationUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly delegations: DelegationStore,
    private readonly directory: Directory,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** As que dei (`GIVEN`) e as que recebi (`RECEIVED`). */
  list(context: TenantContext): Promise<DelegationView[]> {
    const me = memberOf(context)
    return this.uow.run(async (scope) => {
      const rows = await this.delegations.listFor(scope, me)
      return rows.map((d) => ({
        ...d,
        direction: d.fromMembershipId === me ? ('GIVEN' as const) : ('RECEIVED' as const),
      }))
    }, context)
  }

  async create(context: TenantContext, input: DelegationInput): Promise<Delegation> {
    const now = this.clock()
    const issues: WorkflowIssue[] = []
    const validFrom = input.validFrom ?? now
    if (input.validUntil <= validFrom) {
      issues.push({
        path: 'validUntil',
        code: 'INVALID_PERIOD',
        message: 'O fim tem de ser posterior ao início.',
      })
    } else if (input.validUntil.getTime() - validFrom.getTime() > MAX_PERIOD_MS) {
      issues.push({
        path: 'validUntil',
        code: 'PERIOD_TOO_LONG',
        message: 'Uma delegação dura no máximo um ano.',
      })
    }
    if (input.validUntil <= now) {
      issues.push({ path: 'validUntil', code: 'IN_THE_PAST', message: 'O fim já passou.' })
    }
    const scopeValue = normalizeScope(input.scope, issues)
    const maxAmount = input.maxAmount ?? null
    const currency = input.currency ?? null
    if (maxAmount !== null) {
      if (!AMOUNT.test(maxAmount)) {
        issues.push({
          path: 'maxAmount',
          code: 'INVALID_AMOUNT',
          message: 'Montante decimal (até 4 casas), como texto.',
        })
      }
      if (currency === null || !CURRENCY.test(currency)) {
        issues.push({
          path: 'currency',
          code: 'INVALID_CURRENCY',
          message: 'Indique a moeda (3 letras maiúsculas) do montante máximo.',
        })
      }
    } else if (currency !== null) {
      issues.push({
        path: 'currency',
        code: 'CURRENCY_WITHOUT_AMOUNT',
        message: 'A moeda só faz sentido com um montante máximo.',
      })
    }
    const reason = input.reason.trim()
    if (!reason || reason.length > 500) {
      issues.push({
        path: 'reason',
        code: 'INVALID_REASON',
        message: 'O motivo é obrigatório (máx. 500).',
      })
    }
    if (input.toMembershipId === memberOf(context)) {
      issues.push({
        path: 'toMembershipId',
        code: 'SELF_DELEGATION',
        message: 'Não pode delegar em si próprio.',
      })
    }
    if (issues.length > 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', issues)
    }

    return this.uow.run(async (scope) => {
      if (!(await this.directory.isActive(scope, input.toMembershipId))) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
          {
            path: 'toMembershipId',
            code: 'NOT_ACTIVE',
            message: 'O destinatário não existe ou não está activo.',
          },
        ])
      }
      await this.delegations.lock(scope)
      const active = await this.delegations.active(scope, now)
      const cycle = createsCycle(
        active.map((d) => ({ from: d.fromMembershipId, to: d.toMembershipId })),
        { from: memberOf(context), to: input.toMembershipId }
      )
      if (cycle) {
        throw ApiError.conflict(
          'DELEGATION_CYCLE',
          'Esta delegação fecharia uma cadeia circular de delegações.'
        )
      }
      return this.delegations.insert(scope, {
        fromMembershipId: memberOf(context),
        toMembershipId: input.toMembershipId,
        validFrom,
        validUntil: input.validUntil,
        scope: scopeValue,
        maxAmount,
        currency,
        reason,
      })
    }, context)
  }

  /** Só quem delegou revoga; a de outra pessoa é "inexistente". */
  revoke(context: TenantContext, id: string, expectedVersion: number): Promise<Delegation> {
    return this.uow.run(async (scope) => {
      const found = await this.delegations.find(scope, id)
      if (!found || found.fromMembershipId !== memberOf(context)) throw ApiError.notFound()
      return this.delegations.revoke(scope, id, expectedVersion)
    }, context)
  }
}
