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
