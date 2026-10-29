/** API pública dos documentos (S01). Outros módulos importam **apenas** daqui. */
export { documentServices } from '#modules/documents/presentation/composition'
export {
  documentResourceOf,
  documentResourceTypes,
  registerDocumentResource,
} from '#modules/documents/application/registry'
export type { DocumentResource } from '#modules/documents/application/ports'
export { registerDocumentResources } from '#modules/documents/presentation/registration'
