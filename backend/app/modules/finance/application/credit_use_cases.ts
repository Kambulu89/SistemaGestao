import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { creditHeadroom, exceedsCredit, money, showMoney } from '#modules/finance/domain/finance'
import { todayOf, type Clock } from '#modules/finance/application/errors'
import type {
  CreditExposure,
  CreditStore,
  ObligationStore,
} from '#modules/finance/application/ports'

export interface CreditView extends CreditExposure {
  customerId: string
  creditLimit: string
  currency: string
  /** `null` quando o limite é 0 (sem controlo de crédito). */
  headroom: string | null
  controlled: boolean
}

export interface InvoiceRef {
  id: string
  organizationId: string
  customerId: string
  orderId: string | null
  dueOn: string
  currency: string
  total: string
}

export interface CreditNoteRef {
  id: string
  invoiceId: string
  total: string
}

/**
 * Crédito e recebíveis automáticos (M09). A exposição de um cliente = recebíveis em aberto + reservas activas das
 * encomendas confirmadas por facturar. Confirmar uma encomenda que a faria passar o limite é recusado (sob bloqueio do
 * cliente, por isso duas confirmações em paralelo não ultrapassam o limite); o limite 0 significa «sem controlo». Um
 * cliente bloqueado continua a poder pagar: o bloqueio trava vendas, não recebimentos.
 */
export class CreditUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly credit: CreditStore,
    private readonly obligations: ObligationStore,
    private readonly clock: Clock
  ) {}

  /** Consulta a exposição (para a UI e para decisões); `null` se o cliente não existir. */
  view(context: TenantContext, customerId: string): Promise<CreditView> {
    return this.uow.run(async (scope) => {
      const customer = await this.credit.customer(scope, customerId)
      if (!customer) throw ApiError.notFound()
      const exposure = await this.credit.exposure(scope, customer)
      return {
        customerId,
        creditLimit: customer.creditLimit,
        currency: customer.currency,
        ...exposure,
        headroom: creditHeadroom(customer.creditLimit, exposure.exposure),
        controlled: money(customer.creditLimit) > 0n,
      }
    }, context)
  }

  /** Verificação da confirmação de uma encomenda: devolve o problema (ou `null`). */
  async checkOrder(
    scope: TenantScope,
    order: { customerId: string; currency: string; total: string }
  ): Promise<{ code: string; message: string } | null> {
    const customer = await this.credit.customer(scope, order.customerId)
    if (!customer || money(customer.creditLimit) === 0n) return null
    await this.credit.lockCustomer(scope, order.customerId)
    if (customer.currency !== order.currency) {
      return {
        code: 'CREDIT_CURRENCY_MISMATCH',
        message: `O limite de crédito do cliente é em ${customer.currency} e a encomenda em ${order.currency}.`,
      }
    }
    const exposure = await this.credit.exposure(scope, customer)
    if (exceedsCredit(customer.creditLimit, exposure.exposure, order.total)) {
      return {
        code: 'CREDIT_LIMIT_EXCEEDED',
        message: `Excede o limite de crédito (${customer.creditLimit} ${customer.currency}; exposição actual ${exposure.exposure}).`,
      }
    }
    return null
  }

  async orderConfirmed(
    scope: TenantScope,
    order: {
      id: string
      organizationId: string
      customerId: string
      currency: string
      total: string
    }
  ): Promise<void> {
    await this.credit.insertReservation(scope, {
      organizationId: order.organizationId,
      customerId: order.customerId,
      orderId: order.id,
      currency: order.currency,
      amount: order.total,
    })
  }

  async orderCancelled(scope: TenantScope, orderId: string): Promise<void> {
    await this.credit.releaseReservation(scope, orderId)
  }

  /** Factura emitida: nasce o recebível (idempotente por documento) e consome-se a reserva da encomenda. */
  async invoiceIssued(scope: TenantScope, invoice: InvoiceRef): Promise<void> {
    const customer = await this.credit.customer(scope, invoice.customerId)
    if (!customer) return
    if (money(invoice.total) > 0n) {
      await this.obligations.insert(scope, 'receivable', {
        organizationId: invoice.organizationId,
        partyId: customer.partyId,
        sourceType: 'INVOICE',
        sourceId: invoice.id,
        installmentNo: 1,
        originalAmount: invoice.total,
        currency: invoice.currency,
        dueOn: invoice.dueOn,
      })
    }
    if (invoice.orderId) await this.credit.consumeReservation(scope, invoice.orderId, invoice.total)
  }

  /**
   * Nota de crédito emitida: abate o recebível da factura até ao saldo em aberto (idempotente por nota). Se o cliente já
   * pagou mais do que o novo valor devido, o excedente não se aplica (devolução ao cliente fica fora desta fatia).
   */
  async creditNoteIssued(scope: TenantScope, note: CreditNoteRef): Promise<void> {
    const today = todayOf(this.clock)
    const receivable = await this.obligations.findBySource(
      scope,
      'receivable',
      'INVOICE',
      note.invoiceId,
      today
    )
    if (!receivable) return
    const locked = await this.obligations.find(scope, 'receivable', receivable.id, today, true)
    if (!locked || locked.status !== 'OPEN') return
    const apply =
      money(note.total) < money(locked.balance) ? money(note.total) : money(locked.balance)
    if (apply <= 0n) return
    const applied = await this.obligations.insertCredit(scope, {
      receivableId: locked.id,
      sourceType: 'CREDIT_NOTE',
      sourceId: note.id,
      amount: showMoney(apply),
    })
    if (!applied) return
    const after = await this.obligations.find(scope, 'receivable', locked.id, today)
    if (after && money(after.balance) === 0n) {
      await this.obligations.setStatus(scope, 'receivable', locked.id, 'CLOSED')
    }
  }
}
