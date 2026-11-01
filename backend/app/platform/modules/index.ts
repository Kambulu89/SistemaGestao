/** API pública do registo de módulos e funcionalidades (C03). Outros módulos importam **apenas** daqui. */
export { CODE_MANIFESTS } from '#platform/modules/manifests'
export type {
  ManifestDependency,
  ManifestFeature,
  ModuleKind,
  ModuleManifest,
} from '#platform/modules/domain/module'
export type { FeatureView, ModuleView } from '#platform/modules/application/use_cases'
export { moduleServices } from '#platform/modules/presentation/composition'
