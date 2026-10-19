import type { Condition } from '../models/condition.model';
import type { EntityDefinition } from '../models/entity-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';
import type {
  FormDefinition,
  FormFieldItem,
  FormItem,
  FormSection,
} from '../models/form-definition.model';
import type { ValidationRule } from '../models/validation-rule.model';

/** Um campo configurado num formulário, com a secção que o contém. */
export interface FormFieldEntry {
  readonly item: FormFieldItem;
  readonly section: FormSection;
}

/** Todos os campos configurados no formulário, por chave (a primeira ocorrência prevalece). */
export function indexFormFields(form: FormDefinition): Map<string, FormFieldEntry> {
  const index = new Map<string, FormFieldEntry>();
  const visit = (items: readonly FormItem[], section: FormSection): void => {
    for (const item of items) {
      if (item.kind === 'group') visit(item.items, section);
      else if (!index.has(item.field)) index.set(item.field, { item, section });
    }
  };
  for (const section of form.sections) visit(section.items, section);
  return index;
}

/** Junta condições com AND, omitindo as ausentes. */
export function andCondition(...parts: (Condition | undefined)[]): Condition | undefined {
  const list = parts.filter((c): c is Condition => c !== undefined);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : { op: 'and', conditions: list };
}

/** Junta condições com OR, omitindo as ausentes. */
export function orCondition(...parts: (Condition | undefined)[]): Condition | undefined {
  const list = parts.filter((c): c is Condition => c !== undefined);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : { op: 'or', conditions: list };
}

/** Regras que um formulário pode acrescentar a um campo: só apertam, nunca relaxam nem dependem de dados. */
export const FORM_RULE_TYPES: readonly ValidationRule['type'][] = [
  'minLength',
  'maxLength',
  'min',
  'max',
  'pattern',
  'email',
];

/**
 * A entidade **tal como este formulário a apresenta**: cada campo recebe a configuração do
 * formulário, e o resultado é uma `EntityDefinition` normal que os motores de estado e validação
 * (e o servidor) interpretam sem saber que existe um formulário.
 *
 * Um formulário só restringe:
 *  - visibilidade e edição: `false` esconde / bloqueia; `true` nunca mostra o que a entidade esconde;
 *  - obrigatoriedade: pode acrescentar, nunca retirar a da entidade (`required` e `requiredWhen` somam-se);
 *  - condições: juntam-se às do campo (AND; OR para a obrigatoriedade); as da secção aplicam-se a todos os seus campos;
 *  - validações: acrescentam-se às do campo (só as de `FORM_RULE_TYPES`);
 *  - campos que o formulário não inclui ficam escondidos (não se validam nem se enviam).
 */
export function applyFormConfiguration(
  entity: EntityDefinition,
  form: FormDefinition,
): EntityDefinition {
  const index = indexFormFields(form);
  const fields = entity.fields.map<FieldDefinition>((field) => {
    const entry = index.get(field.key);
    if (!entry) return { ...field, visible: false };
    const { item, section } = entry;
    const extra = (item.validations ?? []).filter((r) => FORM_RULE_TYPES.includes(r.type));
    return {
      ...field,
      label: item.label?.trim() || field.label,
      placeholder: item.placeholder ?? field.placeholder,
      description: item.help ?? field.description,
      visible: field.visible && item.visible !== false,
      editable: field.editable && item.editable !== false,
      required: field.required || item.required === true,
      visibleWhen: andCondition(field.visibleWhen, item.visibleWhen, section.visibleWhen),
      editableWhen: andCondition(field.editableWhen, item.editableWhen),
      requiredWhen: orCondition(field.requiredWhen, item.requiredWhen),
      validations: [...field.validations, ...extra],
    } as FieldDefinition;
  });
  return { ...entity, fields };
}

/** Valores por omissão configurados, por chave de campo. */
export function formDefaults(
  form: FormDefinition,
): ReadonlyMap<string, Pick<FormFieldItem, 'defaultValue' | 'defaultWhen'>> {
  const result = new Map<string, Pick<FormFieldItem, 'defaultValue' | 'defaultWhen'>>();
  for (const [key, { item }] of indexFormFields(form)) {
    if (item.defaultValue)
      result.set(key, { defaultValue: item.defaultValue, defaultWhen: item.defaultWhen });
  }
  return result;
}
