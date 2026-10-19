import { FormControl, FormGroup, type ValidatorFn } from '@angular/forms';
import { conditionFields } from '../../core/dynamic/engine/condition';
import { type FieldAccess, resolveFieldState } from '../../core/dynamic/engine/field-state';
import { rulesForField, validateField } from '../../core/dynamic/engine/validation';
import type { EntityDefinition } from '../../core/dynamic/models/entity-definition.model';
import type { FieldDefinition, FieldValue } from '../../core/dynamic/models/field-definition.model';
import type { FormMode } from '../../core/dynamic/models/form-definition.model';
import type { RecordData } from '../../core/dynamic/models/entity-record.model';

export type EntityFormGroup = FormGroup<Record<string, FormControl<FieldValue>>>;

/** Estado do contexto lido sob demanda (os sinais do componente mudam sem reconstruir o formulário). */
export interface EntityFormContext {
  readonly mode: () => FormMode;
  readonly status: () => string | null;
  readonly access: () => FieldAccess;
}

export const activeFields = (entity: EntityDefinition): FieldDefinition[] =>
  entity.fields.filter((f) => !f.archived);

/**
 * Validador Angular que delega no motor de validação. Lê os valores do grupo, resolve o estado
 * efectivo do campo (visível/editável/obrigatório) e devolve o primeiro problema, se houver.
 */
function engineValidator(
  entity: EntityDefinition,
  field: FieldDefinition,
  ctx: EntityFormContext,
): ValidatorFn {
  return (control) => {
    const group = control.parent;
    if (!group) return null; // ainda não está no grupo
    const values = (group as EntityFormGroup).getRawValue();
    const context = { values, status: ctx.status() };
    const state = resolveFieldState(field, context, ctx.mode(), ctx.access());
    if (!state.visible || !state.editable) return null;

    const [issue] = validateField(entity, field, control.value, context, {
      required: state.required,
    });
    return issue ? { dynamic: { message: issue.message, rule: issue.rule } } : null;
  };
}

/** Constrói o `FormGroup` de uma entidade: um controlo por campo activo, validado pelo motor. */
export function buildEntityForm(entity: EntityDefinition, ctx: EntityFormContext): EntityFormGroup {
  const controls: Record<string, FormControl<FieldValue>> = {};
  for (const field of activeFields(entity)) {
    controls[field.key] = new FormControl<FieldValue>(null, {
      validators: [engineValidator(entity, field, ctx)],
    });
  }
  return new FormGroup(controls);
}

/**
 * Valores iniciais do formulário. Em criação aplicam-se os valores por omissão; os campos
 * acrescentados depois de um registo ser criado simplesmente aparecem vazios.
 */
export function initialFormValues(
  entity: EntityDefinition,
  value: RecordData | null,
  mode: FormMode,
): Record<string, FieldValue> {
  return Object.fromEntries(
    activeFields(entity).map((f) => [
      f.key,
      value?.[f.key] ?? (mode === 'create' ? (f.defaultValue ?? null) : null),
    ]),
  );
}

/** Campos cuja validade ou estado dependem de outros campos: têm de ser reavaliados a cada alteração. */
export function dependentFieldKeys(entity: EntityDefinition): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const field of activeFields(entity)) {
    const conditions = [field.visibleWhen, field.editableWhen, field.requiredWhen];
    const rules = rulesForField(entity, field);
    const dependsOnOthers =
      conditions.some((c) => c && [...conditionFields(c)].some((k) => k !== field.key)) ||
      rules.some((r) => r.type === 'compare' || r.when !== undefined);
    if (dependsOnOthers) keys.add(field.key);
  }
  return keys;
}

/** Valores a enviar: só os campos visíveis e editáveis; texto vazio passa a `null`. */
export function collectSubmitValues(
  entity: EntityDefinition,
  raw: Readonly<Record<string, FieldValue>>,
  ctx: EntityFormContext,
): RecordData {
  const context = { values: raw, status: ctx.status() };
  const out: Record<string, FieldValue> = {};
  for (const field of activeFields(entity)) {
    const state = resolveFieldState(field, context, ctx.mode(), ctx.access());
    if (!state.visible || !state.editable) continue;
    const value = raw[field.key];
    if (value === undefined || value === null || value === '')
      out[field.key] = field.type === 'boolean' ? false : null;
    else out[field.key] = value;
  }
  return out;
}
