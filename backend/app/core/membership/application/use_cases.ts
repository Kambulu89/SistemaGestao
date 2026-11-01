import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  canTransitionMembership,
  type Membership,
  type MembershipStatus,
} from '#core/membership/domain/membership'
import type { MembershipStore } from '#core/membership/application/ports'

/** Acrescenta um utilizador a um tenant (operação interna; os convites chegam na fatia 1.6). */
export class AddMember {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: MembershipStore
  ) {}

  async execute(
    context: TenantContext,
    input: { userId: string; status?: Extract<MembershipStatus, 'INVITED' | 'ACTIVE'> }
  ): Promise<Membership> {
    return this.uow.run(async (scope) => {
      const created = await this.store.insert(scope, {
        userId: input.userId,
        status: input.status ?? 'ACTIVE',
      })
      if (!created) {
        throw ApiError.conflict('MEMBERSHIP_EXISTS', 'O utilizador já pertence a este tenant.')
      }
      return created
    }, context)
  }
}

/** Suspende, reactiva ou termina uma membership; invalida a versão de autorização. */
export class ChangeMembershipStatus {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: MembershipStore
  ) {}

  async execute(
    context: TenantContext,
    input: { userId: string; status: MembershipStatus }
  ): Promise<Membership> {
    return this.uow.run(async (scope) => {
      const current = await this.store.findByUser(scope, input.userId)
      if (!current) throw ApiError.notFound('Membership não encontrada.')
      if (!canTransitionMembership(current.status, input.status)) {
        throw ApiError.conflict(
          'INVALID_STATE_TRANSITION',
          `Não é possível passar de ${current.status} para ${input.status}.`
        )
      }
      return this.store.changeStatus(scope, current, input.status)
    }, context)
  }
}
