import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  money,
  normalizePayment,
  showMoney,
  type Issue,
  type ObligationKind,
  type PaymentDirection,
  type PaymentInput,
  type PaymentStatus,
} from '#modules/finance/domain/finance'
import {
  financeValidation,
  MAX_PAGE,
  todayOf,
  failure,
  type Clock,
} from '#modules/finance/application/errors'
import type {
  AccountStore,
  ObligationStore,
  Payment,
  PaymentAllocation,
  PaymentStore,
  References,
} from '#modules/finance/application/ports'

export type PaymentDetail = Payment & { allocations: PaymentAllocation[] }

const kindOf = (direction: PaymentDirection): ObligationKind =>
  direction === 'INBOUND' ? 'receivable' : 'payable'

/**
 * Pagamentos e recebimentos (M09). Criar apenas regista a intenção (rascunho, com a alocação a obrigações concretas);
 * confirmar é a operação que move dinheiro: bloqueia as obrigações, confere que nenhuma fica paga a mais, lança o
 * movimento na conta e fecha o que ficou liquidado — tudo numa só transacção. Um pagamento confirmado nunca se edita nem
 * apaga: reverte-se (repõe os saldos e lança o movimento inverso). Confirmar e reverter são idempotentes pelo estado.
 */
export class PaymentUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly payments: PaymentStore,
    private readonly accounts: AccountStore,
    private readonly obligations: ObligationStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      direction?: PaymentDirection
      status?: PaymentStatus
      partyId?: string
      treasuryAccountId?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) =>
        this.payments.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<PaymentDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  private async detail(scope: TenantScope, id: string): Promise<PaymentDetail> {
    const payment = await this.payments.find(scope, id)
    if (!payment) throw ApiError.notFound()
    return { ...payment, allocations: await this.payments.allocations(scope, id) }
  }

  async create(
    context: TenantContext,
    input: PaymentInput,
    idempotencyKey: string | null
  ): Promise<{ payment: PaymentDetail; idempotent: boolean }> {
    if (
      typeof input.partyId === 'string' &&
      !(await this.references.partyExists(context, input.partyId))
    ) {
      throw failure('partyId', 'UNKNOWN_PARTY', 'A pessoa ou organização não existe.')
    }
    return this.uow.run(async (scope) => {
      if (idempotencyKey) {
        const existing = await this.payments.findByIdempotencyKey(scope, idempotencyKey)
        if (existing)
          return { payment: await this.sameRequest(scope, existing, input), idempotent: true }
      }
      const account =
        typeof input.treasuryAccountId === 'string'
          ? await this.accounts.find(scope, input.treasuryAccountId)
          : null
      const issues: Issue[] = []
      const values = normalizePayment(input, account?.currency ?? null, todayOf(this.clock), issues)
      if (!values || !account) throw financeValidation(issues)
      if (account.organizationId !== values.organizationId) {
        throw failure(
          'treasuryAccountId',
          'ACCOUNT_ORGANIZATION',
          'A conta pertence a outra organização.'
        )
      }
      if (!account.active) {
        throw failure(
          'treasuryAccountId',
          'ACCOUNT_INACTIVE',
          'A conta de tesouraria está inactiva.'
        )
      }
      const kind = kindOf(values.direction)
      for (const [index, allocation] of values.allocations.entries()) {
        const targetId = (allocation.receivableId ?? allocation.payableId) as string
        const path = `allocations[${index}]`
        const target = await this.obligations.find(scope, kind, targetId, todayOf(this.clock))
        if (!target) throw failure(path, 'UNKNOWN_OBLIGATION', 'A obrigação não existe.')
        if (target.partyId !== values.partyId || target.organizationId !== values.organizationId) {
          throw failure(
            path,
            'OBLIGATION_MISMATCH',
            'A obrigação pertence a outra entidade ou organização.'
          )
        }
        if (target.currency !== values.currency) {
          throw failure(
            path,
            'CURRENCY_MISMATCH',
            `A obrigação está em ${target.currency} e a conta em ${values.currency}.`
          )
        }
      }
      const created = await this.payments.insert(scope, values, idempotencyKey)
      if (created === 'KEY') {
        const existing = (await this.payments.findByIdempotencyKey(
          scope,
          idempotencyKey as string
        )) as Payment
        return { payment: await this.sameRequest(scope, existing, input), idempotent: true }
      }
      return { payment: await this.detail(scope, created.id), idempotent: false }
    }, context)
  }

  /** Repetir um pedido com a mesma chave devolve o pagamento; com dados diferentes é um erro, não uma duplicação. */
  private async sameRequest(
    scope: TenantScope,
    existing: Payment,
    input: PaymentInput
  ): Promise<PaymentDetail> {
    if (
      existing.partyId !== input.partyId ||
      existing.direction !== input.direction ||
      (typeof input.amount === 'string' && money(existing.amount) !== money(input.amount))
    ) {
      throw ApiError.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'A chave de idempotência já foi usada com outros dados.'
      )
    }
    return this.detail(scope, existing.id)
  }

  submit(context: TenantContext, id: string): Promise<PaymentDetail> {
    return this.uow.run(async (scope) => {
      const payment = await this.payments.find(scope, id, true)
      if (!payment) throw ApiError.notFound()
      if (payment.status === 'PENDING') return this.detail(scope, id)
      if (payment.status !== 'DRAFT') throw this.notAllowed(payment, 'submeter')
      await this.payments.setStatus(scope, id, { status: 'PENDING' })
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const payment = await this.payments.find(scope, id, true)
      if (!payment) throw ApiError.notFound()
      if (payment.status !== 'DRAFT') throw this.notAllowed(payment, 'apagar')
      await this.payments.remove(scope, id)
    }, context)
  }

  fail(context: TenantContext, id: string, reason: string): Promise<PaymentDetail> {
    const text = reason.trim()
    if (!text) throw failure('reason', 'REQUIRED', 'Indique o motivo da falha.')
    return this.uow.run(async (scope) => {
      const payment = await this.payments.find(scope, id, true)
      if (!payment) throw ApiError.notFound()
      if (payment.status === 'FAILED') return this.detail(scope, id)
      if (payment.status !== 'DRAFT' && payment.status !== 'PENDING') {
        throw this.notAllowed(payment, 'marcar como falhado')
      }
      await this.payments.setStatus(scope, id, { status: 'FAILED', reason: text })
      return this.detail(scope, id)
    }, context)
  }

  confirm(context: TenantContext, id: string): Promise<PaymentDetail> {
    return this.uow.run(async (scope) => {
      const payment = await this.payments.find(scope, id, true)
      if (!payment) throw ApiError.notFound()
      if (payment.status === 'CONFIRMED') return this.detail(scope, id)
      if (payment.status !== 'DRAFT' && payment.status !== 'PENDING') {
        throw this.notAllowed(payment, 'confirmar')
      }
      const account = await this.accounts.find(scope, payment.treasuryAccountId, true)
      if (!account || !account.active) {
        throw ApiError.conflict('ACCOUNT_INACTIVE', 'A conta de tesouraria está inactiva.')
      }
      const kind = kindOf(payment.direction)
      const today = todayOf(this.clock)
      const allocations = await this.payments.allocations(scope, id)
      const targets = [...allocations].sort((a, b) =>
        ((a.receivableId ?? a.payableId) as string).localeCompare(
          (b.receivableId ?? b.payableId) as string
        )
      )
      const problems: { path: string; code: string; message: string }[] = []
      for (const allocation of targets) {
        const targetId = (allocation.receivableId ?? allocation.payableId) as string
        const target = await this.obligations.find(scope, kind, targetId, today, true)
        const path = `allocations.${targetId}`
        if (!target || target.status !== 'OPEN') {
          problems.push({
            path,
            code: 'OBLIGATION_NOT_OPEN',
            message: 'A obrigação já não está em aberto.',
          })
        } else if (money(allocation.amount) > money(target.balance)) {
          problems.push({
            path,
            code: 'OVERPAYMENT',
            message: `O montante (${allocation.amount}) excede o saldo em aberto (${target.balance}).`,
          })
        }
      }
      if (problems.length > 0) {
        throw ApiError.conflict(
          'PAYMENT_NOT_APPLICABLE',
          'O pagamento não se pode aplicar.',
          problems
        )
      }

      const confirmed = await this.payments.setStatus(scope, id, { status: 'CONFIRMED' })
      for (const allocation of targets) {
        const targetId = (allocation.receivableId ?? allocation.payableId) as string
        const after = await this.obligations.find(scope, kind, targetId, today)
        if (after && money(after.balance) === 0n) {
          await this.obligations.setStatus(scope, kind, targetId, 'CLOSED')
        }
      }
      const signed =
        payment.direction === 'INBOUND' ? money(payment.amount) : -money(payment.amount)
      await this.payments.insertEntry(scope, {
        accountId: payment.treasuryAccountId,
        paymentId: id,
        amountSigned: showMoney(signed),
        occurredOn: payment.occurredOn,
        reversalOfId: null,
        sourceKey: `payment:${id}`,
      })
      await this.outbox.append(scope, {
        aggregateType: 'payment',
        aggregateId: id,
        aggregateVersion: confirmed.version,
        eventType: 'finance.payment.confirmed',
        payload: {
          paymentId: id,
          direction: payment.direction,
          partyId: payment.partyId,
          organizationId: payment.organizationId,
          amount: payment.amount,
          currency: payment.currency,
          allocations: targets.map((a) => ({
            receivableId: a.receivableId,
            payableId: a.payableId,
            amount: a.amount,
          })),
        },
        correlationId: context.correlationId,
      })
      return this.detail(scope, id)
    }, context)
  }

  reverse(context: TenantContext, id: string, reason: string): Promise<PaymentDetail> {
    const text = reason.trim()
    if (!text) throw failure('reason', 'REQUIRED', 'Indique o motivo da reversão.')
    return this.uow.run(async (scope) => {
      const payment = await this.payments.find(scope, id, true)
      if (!payment) throw ApiError.notFound()
      if (payment.status === 'REVERSED') return this.detail(scope, id)
      if (payment.status !== 'CONFIRMED') throw this.notAllowed(payment, 'reverter')
      const kind = kindOf(payment.direction)
      const today = todayOf(this.clock)
      const allocations = await this.payments.allocations(scope, id)
      const targets = [...allocations].sort((a, b) =>
        ((a.receivableId ?? a.payableId) as string).localeCompare(
          (b.receivableId ?? b.payableId) as string
        )
      )
      for (const allocation of targets) {
        await this.obligations.find(
          scope,
          kind,
          (allocation.receivableId ?? allocation.payableId) as string,
          today,
          true
        )
      }
      await this.payments.markAllocationsReversed(scope, id)
      const reversed = await this.payments.setStatus(scope, id, {
        status: 'REVERSED',
        reason: text,
      })
      for (const allocation of targets) {
        const targetId = (allocation.receivableId ?? allocation.payableId) as string
        const target = await this.obligations.find(scope, kind, targetId, today)
        if (target?.status === 'CLOSED' && money(target.balance) > 0n) {
          await this.obligations.setStatus(scope, kind, targetId, 'OPEN')
        }
      }
      const original = await this.payments.entryOf(scope, id)
      if (original) {
        await this.payments.insertEntry(scope, {
          accountId: payment.treasuryAccountId,
          paymentId: id,
          amountSigned: showMoney(-money(original.amountSigned)),
          occurredOn: today,
          reversalOfId: original.id,
          sourceKey: `payment-reversal:${id}`,
        })
      }
      await this.outbox.append(scope, {
        aggregateType: 'payment',
        aggregateId: id,
        aggregateVersion: reversed.version,
        eventType: 'finance.payment.reversed',
        payload: {
          paymentId: id,
          direction: payment.direction,
          partyId: payment.partyId,
          organizationId: payment.organizationId,
          amount: payment.amount,
          currency: payment.currency,
          reason: text,
        },
        correlationId: context.correlationId,
      })
      return this.detail(scope, id)
    }, context)
  }

  private notAllowed(payment: Payment, action: string) {
    return ApiError.conflict(
      'PAYMENT_STATE',
      `Não se pode ${action} um pagamento no estado ${payment.status}.`
    )
  }
}
