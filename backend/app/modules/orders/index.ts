/** API pública das propostas e encomendas (M04). Outros módulos (expedições, facturação, stock) importam **apenas** daqui. */
export { orderServices } from '#modules/orders/presentation/composition'
export { registerConfirmationCheck } from '#modules/orders/application/registry'
export type { Line, Order, Quote } from '#modules/orders/application/ports'
export type { OrderDetail, QuoteDetail } from '#modules/orders/application/sales_use_cases'
