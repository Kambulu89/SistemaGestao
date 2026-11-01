import { customerServices } from '#modules/customers/index'
import { invoicingServices } from '#modules/invoicing/index'
import { orderServices } from '#modules/orders/index'
import { registerDocumentResource } from '#modules/documents/application/registry'

let registered = false

const exists = (read: () => Promise<unknown>) => async () => {
  try {
    await read()
    return true
  } catch {
    return false
  }
}

/**
 * Regista os recursos que aceitam documentos e anexos (ResourceRegistry). Uma factura tem conteúdo financeiro: os seus
 * documentos só se vêem com acesso à factura. `exists` usa o caso de uso público do módulo dono, que aplica o seu âmbito.
 */
export function registerDocumentResources(): void {
  if (registered) return
  registered = true
  registerDocumentResource('invoice', {
    permission: 'invoice.read',
    protected: true,
    exists: (context, id) => exists(() => invoicingServices().invoices.get(context, id))(),
  })
  registerDocumentResource('sales_order', {
    permission: 'order.read',
    protected: false,
    exists: (context, id) => exists(() => orderServices().orders.get(context, id))(),
  })
  registerDocumentResource('customer', {
    permission: 'customer.read',
    protected: false,
    exists: (context, id) => exists(() => customerServices().customers.get(context, id))(),
  })
}
