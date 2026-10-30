/**
 * API pública do inventário (M07). Expedições, recepções e inventários físicos importam **apenas** daqui e lançam os
 * seus movimentos com `inventoryServices().stock.postInScope(scope, …)` na transacção do seu documento.
 */
export { inventoryServices } from '#modules/inventory/presentation/composition'
export { registerInventory } from '#modules/inventory/presentation/registration'
export type {
  PostCommand,
  PostResult,
  ReserveInput,
} from '#modules/inventory/application/stock_use_cases'
export type {
  BalanceView,
  Location,
  Lot,
  Movement,
  Reservation,
  Warehouse,
} from '#modules/inventory/application/ports'
