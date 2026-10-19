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

/**
 * Precedência entre formulários (maior ganha):
 *  3. do tenant (personalização, ou formulário próprio);
 *  2. globais, fornecidos pela plataforma;
 *  1. embutidos na definição da entidade.
 * Um formulário do tenant com a mesma chave que um global **substitui-o** para esse tenant; o
 * global nunca é alterado. Só os publicados participam (rascunhos e arquivados não).
 */
export function formRank(form: FormDefinition): number {
  return form.scope === 'tenant' ? 3 : form.scope === 'global' ? 2 : 1;
}

const isUsable = (form: FormDefinition): boolean =>
  form.state === undefined || form.state === 'published';

/**
 * Formulários publicados que servem o modo, do preferido para o menos preferido: por precedência,
 * depois os marcados por omissão, depois a versão mais recente. Uma chave repetida em vários
 * âmbitos aparece uma só vez (a de maior precedência).
 */
export function formCandidates(forms: readonly FormDefinition[], mode: FormMode): FormDefinition[] {
  const best = new Map<string, FormDefinition>();
  for (const form of forms.filter(isUsable)) {
    const current = best.get(form.key);
    if (
      !current ||
      formRank(form) > formRank(current) ||
      (formRank(form) === formRank(current) && (form.version ?? 0) > (current.version ?? 0))
    )
      best.set(form.key, form);
  }
  return [...best.values()]
    .filter((f) => f.modes.includes(mode))
    .map((form, order) => ({ form, order }))
    .sort(
      (a, b) =>
        formRank(b.form) - formRank(a.form) ||
        Number(b.form.isDefault === true) - Number(a.form.isDefault === true) ||
        a.order - b.order,
    )
    .map((x) => x.form);
}

/** Escolhe o formulário do modo pedido (ou o pedido pela chave); sem definição própria, gera-se um. */
export function resolveForm(
  entity: EntityDefinition,
  mode: FormMode,
  formKey?: string,
): FormDefinition {
  const candidates = formCandidates(entity.forms, mode);
  const requested = formKey ? candidates.find((f) => f.key === formKey) : undefined;
  return requested ?? candidates[0] ?? generateDefaultForm(entity);
}

/** Chaves dos campos usados pelo formulário, por ordem de apresentação. */
export function formFieldKeys(form: FormDefinition): string[] {
  const collect = (items: readonly FormItem[]): string[] =>
    items.flatMap((item) => (item.kind === 'field' ? [item.field] : collect(item.items)));
  return form.sections.flatMap((s) => collect(s.items));
}
