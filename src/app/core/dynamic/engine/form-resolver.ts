import type { EntityDefinition } from '../models/entity-definition.model';
import type { FormDefinition, FormItem, FormMode } from '../models/form-definition.model';

/** Formulário gerado automaticamente: uma secção com todos os campos por ordem. */
export function generateDefaultForm(entity: EntityDefinition): FormDefinition {
  const fields = [...entity.fields].filter((f) => !f.archived).sort((a, b) => a.order - b.order);
  return {
    key: 'auto',
    name: entity.names.singular,
    modes: ['create', 'edit', 'read'],
    sections: [
      {
        key: 'data',
        title: 'Dados',
        columns: 2,
        items: fields.map((f) => ({ kind: 'field', field: f.key })),
      },
    ],
  };
}

/** Escolhe o formulário do modo pedido; sem definição própria, gera-se um. */
export function resolveForm(entity: EntityDefinition, mode: FormMode): FormDefinition {
  return entity.forms.find((f) => f.modes.includes(mode)) ?? generateDefaultForm(entity);
}

/** Chaves dos campos usados pelo formulário, por ordem de apresentação. */
export function formFieldKeys(form: FormDefinition): string[] {
  const collect = (items: readonly FormItem[]): string[] =>
    items.flatMap((item) => (item.kind === 'field' ? [item.field] : collect(item.items)));
  return form.sections.flatMap((s) => collect(s.items));
}
