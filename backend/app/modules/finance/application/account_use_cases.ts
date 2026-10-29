import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import { normalizeAccount, type AccountInput, type Issue } from '#modules/finance/domain/finance'
import { financeValidation, MAX_PAGE } from '#modules/finance/application/errors'
import type {
  AccountStore,
  PaymentStore,
  References,
  TreasuryAccount,
} from '#modules/finance/application/ports'

/**
 * Contas de tesouraria (caixa e bancos) por organização. O saldo deriva dos movimentos; a organização, o código, o tipo e
 * a moeda não mudam depois de criada a conta. Uma conta inactiva deixa de receber pagamentos novos.
 */
export class AccountUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly accounts: AccountStore,
    private readonly payments: PaymentStore,
    private readonly references: References
  ) {}

  list(
    context: TenantContext,
    filter: { organizationId?: string; active?: boolean; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) =>
        this.accounts.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<TreasuryAccount> {
    return this.uow.run(async (scope) => {
      const account = await this.accounts.find(scope, id)
      if (!account) throw ApiError.notFound()
      return account
    }, context)
  }

  /** Extracto: movimentos da conta, do mais recente para o mais antigo. */
  statement(context: TenantContext, id: string, page: { limit?: number; offset?: number }) {
    return this.uow.run(async (scope) => {
      if (!(await this.accounts.find(scope, id))) throw ApiError.notFound()
      return this.payments.entries(
        scope,
        id,
        Math.min(page.limit ?? 50, MAX_PAGE),
        page.offset ?? 0
      )
    }, context)
  }

  async create(context: TenantContext, input: AccountInput): Promise<TreasuryAccount> {
    const issues: Issue[] = []
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const currency = organizationId
      ? await this.references.organizationCurrency(context, organizationId)
      : null
    if (organizationId && currency === null) {
      issues.push({
        path: 'organizationId',
        code: 'UNKNOWN_ORGANIZATION',
        message: 'A organização não existe.',
      })
    }
    const values = normalizeAccount(input, null, currency ?? 'AOA', issues)
    if (!values || issues.length > 0) throw financeValidation(issues)
    const created = await this.uow.run((scope) => this.accounts.insert(scope, values), context)
    if (created === 'CODE') {
      throw ApiError.conflict('ACCOUNT_CODE_EXISTS', 'Já existe uma conta com este código.')
    }
    return created
  }

  update(
    context: TenantContext,
    id: string,
    input: AccountInput & { expectedVersion: number }
  ): Promise<TreasuryAccount> {
    return this.uow.run(async (scope) => {
      const current = await this.accounts.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeAccount(input, current, current.currency, issues)
      if (!values) throw financeValidation(issues)
      return this.accounts.update(scope, id, input.expectedVersion, values)
    }, context)
  }
}
