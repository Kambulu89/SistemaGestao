import { USER_DIRECTORY_KEY } from '../../core/dynamic/models/entity-record.model';
import type { FieldDefinition } from '../../core/dynamic/models/field-definition.model';

/** Entidade (ou directório) a consultar para obter o rótulo de um campo de referência. */
export function referenceTarget(field: FieldDefinition): string | null {
  if (field.type === 'entity-reference') return field.entityKey;
  if (field.type === 'user-reference') return USER_DIRECTORY_KEY;
  return null;
}
