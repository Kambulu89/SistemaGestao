import type { DocumentResource } from '#modules/documents/application/ports'

/**
 * Registo de recursos (ResourceRegistry, spec S01): cada módulo regista os tipos de recurso a que se podem ligar
 * documentos e anexos. Um vínculo para um tipo não registado, ou para um recurso que não existe no tenant, é recusado.
 */
const resources = new Map<string, DocumentResource>()

export function registerDocumentResource(resourceType: string, resource: DocumentResource): void {
  resources.set(resourceType, resource)
}

export const documentResourceOf = (resourceType: string): DocumentResource | undefined =>
  resources.get(resourceType)

export const documentResourceTypes = (): string[] => [...resources.keys()]
