import type { EntityDefinition } from '../models/entity-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';

/**
 * Junta a cada valor relacionado (`lookup`) a definição do campo de origem, para os renderers o
 * formatarem como o campo original. É apresentação: o servidor continua a decidir o valor e o acesso.
 */
export function resolveLookupSources(entities: readonly EntityDefinition[]): EntityDefinition[] {
  const byKey = new Map(entities.map((e) => [e.key, e]));
  return entities.map((entity) => {
    if (!entity.fields.some((f) => f.type === 'lookup')) return entity;
    const fields = entity.fields.map<FieldDefinition>((field) => {
      if (field.type !== 'lookup') return field;
      const relation = entity.fields.find((f) => f.key === field.lookup.relationField);
      const target = relation?.type === 'entity-reference' ? byKey.get(relation.entityKey) : null;
      const source = target?.fields.find((f) => f.key === field.lookup.sourceField);
      return source ? { ...field, lookup: { ...field.lookup, resolvedSource: source } } : field;
    });
    return { ...entity, fields };
  });
}
