/** API pública da facturação (M05). Outros módulos (finanças, reporting) importam **apenas** daqui. */
export { invoicingServices } from '#modules/invoicing/presentation/composition'
export type {
  Contract,
  CreditNote,
  CreditNoteLine,
  Invoice,
  InvoiceLine,
} from '#modules/invoicing/application/ports'
export type { InvoiceDetail } from '#modules/invoicing/application/invoice_use_cases'
export type { CreditNoteDetail } from '#modules/invoicing/application/credit_note_use_cases'
