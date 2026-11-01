import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import type { ObligationKind, ObligationView } from '#modules/finance/domain/finance'
import { MAX_PAGE, todayOf, type Clock } from '#modules/finance/application/errors'
import type {
  Obligation,
  ObligationAllocation,
  ObligationCredit,
  ObligationStore,
} from '#modules/finance/application/ports'

export type ObligationDetail = Obligation & {
  allocations: ObligationAllocation[]
  creditApplications: ObligationCredit[]
}

/**
 * Contas a receber e a pagar (consulta). As obrigações nascem de documentos (factura emitida, factura de fornecedor
 * validada) e só se liquidam por pagamentos confirmados ou, nos recebíveis, por notas de crédito: não há edição.
 */
export class ObligationUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly obligations: ObligationStore,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    kind: ObligationKind,
    filter: {
      partyId?: string
      organizationId?: string
      view?: ObligationView
      dueBefore?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) =>
        this.obligations.list(scope, kind, {
          ...filter,
          today: todayOf(this.clock),
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, kind: ObligationKind, id: string): Promise<ObligationDetail> {
    return this.uow.run(async (scope) => {
      const obligation = await this.obligations.find(scope, kind, id, todayOf(this.clock))
      if (!obligation) throw ApiError.notFound()
      return {
        ...obligation,
        allocations: await this.obligations.allocations(scope, kind, id),
        creditApplications: kind === 'receivable' ? await this.obligations.credits(scope, id) : [],
      }
    }, context)
  }
}
