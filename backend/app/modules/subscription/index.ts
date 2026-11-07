/** API pública das subscrições e funcionalidades contratadas. */
export { FEATURES, type FeatureDefinition } from '#modules/subscription/domain/features'
export {
  assertEntitled,
  assertWithinLimit,
  assertWithinQuota,
  entitlementsFor,
} from '#modules/subscription/application/entitlements'
export { PlatformSubscriptionService } from '#modules/subscription/application/platform_service'
export { syncFeatureCatalog } from '#modules/subscription/application/catalog'
