import type { Permission } from '../../permissions/permission.model';
import type { Condition } from './condition.model';
import type { ValidationRule } from './validation-rule.model';

export interface FileValue {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  /** Identificador devolvido pelo serviço de ficheiros (futuro). */
  readonly id?: string;
}

/** Tipo do valor guardado para cada tipo de campo. */
export interface FieldValueTypes {
  readonly text: string;
  readonly textarea: string;
  readonly number: number;
  readonly decimal: number;
  readonly boolean: boolean;
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** ISO 8601 */
  readonly datetime: string;
  readonly email: string;
  readonly phone: string;
  readonly select: string;
  readonly multiselect: readonly string[];
  readonly currency: number;
  readonly file: readonly FileValue[];
  /** Id do registo referenciado. */
  readonly reference: string;
}

export type FieldType = keyof FieldValueTypes;

export type FieldValue = FieldValueTypes[FieldType] | null;

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldPermissions {
  /** Permissão necessária para ver o campo. */
  readonly read?: Permission;
  /** Permissão necessária para o editar. */
  readonly write?: Permission;
}

interface FieldBase<T extends FieldType> {
  readonly type: T;
  /** Identificador estável do campo (camelCase). Nunca se reutiliza com outro significado. */
  readonly key: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly description?: string;
  readonly defaultValue?: FieldValueTypes[T];
  readonly required: boolean;
  readonly visible: boolean;
  readonly editable: boolean;
  readonly order: number;
  readonly validations: readonly ValidationRule[];
  readonly visibleWhen?: Condition;
  readonly editableWhen?: Condition;
  readonly requiredWhen?: Condition;
  readonly permissions?: FieldPermissions;
  /** Entra na pesquisa de texto da listagem. */
  readonly searchable: boolean;
  /** Pode ser usado como filtro da listagem. */
  readonly filterable: boolean;
  readonly sortable: boolean;
  /** Campo retirado de uso: deixa de aparecer, mas os dados existentes mantêm-se. */
  readonly archived?: boolean;
}

export type TextField = FieldBase<'text'>;
export type TextareaField = FieldBase<'textarea'>;
export type NumberField = FieldBase<'number'>;
export type DecimalField = FieldBase<'decimal'> & { readonly scale?: number };
export type BooleanField = FieldBase<'boolean'>;
export type DateField = FieldBase<'date'>;
export type DateTimeField = FieldBase<'datetime'>;
export type EmailField = FieldBase<'email'>;
export type PhoneField = FieldBase<'phone'>;
export type SelectField = FieldBase<'select'> & { readonly options: readonly FieldOption[] };
export type MultiSelectField = FieldBase<'multiselect'> & {
  readonly options: readonly FieldOption[];
};
/** Valor monetário numa moeda (código ISO 4217) fixada pela definição. */
export type CurrencyField = FieldBase<'currency'> & { readonly currency: string };
export type FileField = FieldBase<'file'> & {
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
  readonly maxSizeBytes?: number;
};
export type ReferenceField = FieldBase<'reference'> & { readonly entityKey: string };

/** Definição de campo: união discriminada pelo `type`. */
export type FieldDefinition =
  | TextField
  | TextareaField
  | NumberField
  | DecimalField
  | BooleanField
  | DateField
  | DateTimeField
  | EmailField
  | PhoneField
  | SelectField
  | MultiSelectField
  | CurrencyField
  | FileField
  | ReferenceField;

export type FieldOf<T extends FieldType> = Extract<FieldDefinition, { type: T }>;

export function hasOptions(field: FieldDefinition): field is SelectField | MultiSelectField {
  return field.type === 'select' || field.type === 'multiselect';
}
