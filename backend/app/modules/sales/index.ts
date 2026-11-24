/** API pública de Vendas e Facturação (Prompt 10). */
export {
  customerAccess,
  CustomerService,
  customerSnapshot,
  SegmentService,
} from '#modules/sales/application/customer_service'
export {
  DiscountLimitService,
  DiscountRuleService,
  type PriceRequest,
  PriceListService,
  PricingService,
  resolvePrices,
} from '#modules/sales/application/pricing_service'
export {
  acceptedQuote,
  markQuoteConverted,
  quoteAccess,
  QuoteService,
  type QuoteView,
} from '#modules/sales/application/quote_service'
export {
  invoiceableOrder,
  orderAccess,
  OrderService,
  type OrderView,
  recordInvoiced,
  returnForNote,
} from '#modules/sales/application/order_service'
export {
  allocateFiscalNumber,
  FiscalService,
  resolveTaxes,
  type TaxRequest,
} from '#modules/sales/application/fiscal_service'
export {
  invoiceAccess,
  InvoiceService,
  type InvoiceView,
} from '#modules/sales/application/invoice_service'
export {
  receiptAccess,
  ReceiptService,
  type ReceiptView,
} from '#modules/sales/application/receipt_service'
export { noteAccess, NoteService, type NoteView } from '#modules/sales/application/note_service'
