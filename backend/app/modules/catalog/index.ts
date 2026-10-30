/** API pública do catálogo (M03). Outros módulos importam **apenas** daqui. */
export { catalogServices } from '#modules/catalog/presentation/composition'
export { registerMovementGuard } from '#modules/catalog/application/registry'
export type { PriceItem, PriceList, Product, Variant } from '#modules/catalog/application/ports'
export type { ResolvedPrice } from '#modules/catalog/application/price_use_cases'
