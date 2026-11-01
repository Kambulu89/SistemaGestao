import { registerConfirmationCheck, registerOrderEffects } from '#modules/orders/index'
import { registerInvoiceEffects } from '#modules/invoicing/index'
import { financeServices } from '#modules/finance/presentation/composition'

let registered = false

/**
 * Liga as finanças aos módulos de que não depende (D-054): a confirmação de encomendas verifica o crédito e reserva-o,
 * a emissão de facturas cria o recebível e as notas de crédito abatem-no, tudo na transacção do documento. Chamada uma
 * vez no arranque (`start/modules.ts`).
 */
export function registerFinance(): void {
  if (registered) return
  registered = true
  const credit = () => financeServices().credit

  registerConfirmationCheck(async (scope, order) => {
    const problem = await credit().checkOrder(scope, {
      customerId: order.customerId,
      currency: order.currency,
      total: order.totals.total,
    })
    return problem ? [{ path: 'customerId', ...problem }] : []
  })

  registerOrderEffects({
    confirmed: (scope, order) =>
      credit().orderConfirmed(scope, {
        id: order.id,
        organizationId: order.organizationId,
        customerId: order.customerId,
        currency: order.currency,
        total: order.totals.total,
      }),
    cancelled: (scope, order) => credit().orderCancelled(scope, order.id),
  })

  registerInvoiceEffects({
    issued: (scope, invoice) =>
      credit().invoiceIssued(scope, {
        id: invoice.id,
        organizationId: invoice.organizationId,
        customerId: invoice.customerId,
        orderId: invoice.orderId,
        dueOn: invoice.dueOn,
        currency: invoice.currency,
        total: invoice.totals.total,
      }),
    creditNoteIssued: (scope, note) =>
      credit().creditNoteIssued(scope, {
        id: note.id,
        invoiceId: note.invoiceId,
        total: note.totals.total,
      }),
  })
}
