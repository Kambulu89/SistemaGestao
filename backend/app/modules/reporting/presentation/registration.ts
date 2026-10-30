import { customerServices } from '#modules/customers/index'
import { documentServices } from '#modules/documents/index'
import { invoicingServices } from '#modules/invoicing/index'
import { registerDataset, registerSearchSource } from '#modules/reporting/application/registry'
import { DATASETS } from '#modules/reporting/infrastructure/datasets'
import {
  scanCustomers,
  scanDocuments,
  scanInvoices,
} from '#modules/reporting/infrastructure/search_sources'

let registered = false

const readable = (read: () => Promise<unknown>) => async () => {
  try {
    await read()
    return true
  } catch {
    return false
  }
}

/**
 * Regista os datasets de relatórios e as origens de pesquisa. As origens dizem como se lê cada tipo (read model) e
 * perguntam ao módulo dono, pelo seu caso de uso público, se a pessoa pode ver cada resultado.
 */
export function registerReporting(): void {
  if (registered) return
  registered = true
  for (const dataset of DATASETS) registerDataset(dataset)

  registerSearchSource({
    type: 'customer',
    label: 'Clientes',
    permission: 'customer.read',
    path: 'crm/customers',
    scan: scanCustomers,
    canRead: (context, id) => readable(() => customerServices().customers.get(context, id))(),
  })
  registerSearchSource({
    type: 'invoice',
    label: 'Facturas',
    permission: 'invoice.read',
    path: 'sales/billing',
    scan: scanInvoices,
    canRead: (context, id) => readable(() => invoicingServices().invoices.get(context, id))(),
  })
  registerSearchSource({
    type: 'document',
    label: 'Documentos',
    permission: 'document.read',
    path: 'documents/dms',
    scan: scanDocuments,
    canRead: (context, id) => readable(() => documentServices().documents.get(context, id))(),
  })
}
