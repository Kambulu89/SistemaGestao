import type { Permission } from '../../permissions/permission.model';
import type { FieldDefinition } from '../models/field-definition.model';
import type { FormMode } from '../models/form-definition.model';
import { type ConditionContext, evaluateCondition } from './condition';

/** Acesso a campos individuais. Só afecta a experiência: o backend decide. */
export interface FieldAccess {
  canRead(field: FieldDefinition): boolean;
  canWrite(field: FieldDefinition): boolean;
}

export const FULL_ACCESS: FieldAccess = { canRead: () => true, canWrite: () => true };

export function fieldAccessFromPermissions(can: (permission: Permission) => boolean): FieldAccess {
  return {
    canRead: (f) => !f.permissions?.read || can(f.permissions.read),
    canWrite: (f) => !f.permissions?.write || can(f.permissions.write),
  };
}

export interface FieldState {
  readonly visible: boolean;
  readonly editable: boolean;
  readonly required: boolean;
}

/**
 * Estado efectivo de um campo para os valores actuais: junta a configuração estática,
 * as condições declarativas, o modo do formulário e as permissões do campo.
 */
export function resolveFieldState(
  field: FieldDefinition,
  context: ConditionContext,
  mode: FormMode,
  access: FieldAccess = FULL_ACCESS,
): FieldState {
  const visible =
    field.visible &&
    !field.archived &&
    access.canRead(field) &&
    (!field.visibleWhen || evaluateCondition(field.visibleWhen, context));

  const editable =
    visible &&
    mode !== 'read' &&
    field.editable &&
    access.canWrite(field) &&
    (!field.editableWhen || evaluateCondition(field.editableWhen, context));

  const required =
    visible &&
    (field.required || (!!field.requiredWhen && evaluateCondition(field.requiredWhen, context)));

  return { visible, editable, required };
}
