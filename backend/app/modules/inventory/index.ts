/** API pública do inventário (Prompt 08). */
export { productExists } from '#modules/inventory/application/product_service'
export {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'
export {
  postStock,
  reverseStockPosting,
  type PostStockInput,
  type PostStockLineInput,
} from '#modules/inventory/application/stock_service'
export type { Bucket, PostingType } from '#modules/inventory/domain/stock'
export {
  deliverSale,
  receivePurchase,
  releaseSaleReservation,
  reserveForSale,
  returnFromSale,
  type IntegrationInput,
  type IntegrationLineInput,
} from '#modules/inventory/application/integration_service'
