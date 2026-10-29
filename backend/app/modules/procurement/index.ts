/**
 * API pública das compras (M06). O inventário importa **apenas** daqui: regista os efeitos de lançar e reverter uma
 * recepção (`registerReceiptEffects`) e dá entrada ou saída do stock na transacção da recepção.
 */
export { procurementServices } from '#modules/procurement/presentation/composition'
export {
  registerReceiptEffects,
  type ReceiptEffects,
  type ReceiptLineRef,
} from '#modules/procurement/application/registry'
export type {
  PurchaseLine,
  PurchaseOrder,
  Receipt,
  ReceiptLine,
  Supplier,
} from '#modules/procurement/application/ports'
