/** API pública das propostas e encomendas (M04). Outros módulos (expedições, facturação, stock) importam **apenas** daqui. */
export { orderServices } from '#modules/orders/presentation/composition'
export {
  registerConfirmationCheck,
  registerOrderEffects,
  registerShipmentEffects,
  type OrderEffects,
  type ShipmentEffects,
  type ShipmentLineRef,
} from '#modules/orders/application/registry'
export type { Line, Order, Quote, Shipment, ShipmentLine } from '#modules/orders/application/ports'
export type { OrderDetail, QuoteDetail } from '#modules/orders/application/sales_use_cases'
export type { ShipmentDetail } from '#modules/orders/application/shipment_use_cases'
/** Aritmética exacta das linhas comerciais (a facturação reutiliza-a para que os montantes coincidam com os da encomenda). */
export {
  decimalPlaces,
  fromScaled,
  lineAmounts,
  roundDiv,
  sumTotals,
  toScaled,
  type RoundingMode,
  type Totals,
} from '#modules/orders/domain/money'
