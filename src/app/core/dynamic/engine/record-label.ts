import type { EntityDefinition } from '../models/entity-definition.model';
import type { EntityRecord } from '../models/entity-record.model';
import { formatFieldValue } from './format-value';

/**
 * Texto que identifica um registo: o valor da primeira coluna da listagem que seja um campo
 * (ex.: a matrícula de uma viatura). Serve títulos, migalhas e opções de referência.
 */
export function recordLabel(
  entity: EntityDefinition,
  record: Pick<EntityRecord, 'id' | 'data'>,
): string {
  for (const column of entity.list.columns) {
    const field = entity.fields.find((f) => f.key === column.field);
    if (field && field.type !== 'entity-reference') {
      const text = formatFieldValue(field, record.data[field.key]);
      if (text !== '—') return text;
    }
  }
  return record.id;
}
