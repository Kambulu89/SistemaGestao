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
  readonly url: string;
  readonly radio: string;
  /** Mesmo valor que `boolean`; num campo obrigatório significa "tem de estar marcado". */
  readonly checkbox: boolean;
  readonly image: readonly FileValue[];
  /** Id do registo referenciado. */
  readonly 'entity-reference': string;
  /** Id de um utilizador do tenant. */
  readonly 'user-reference': string;
  /** Resultado calculado pelo servidor; nunca é escrito pelo cliente. */
  readonly formula: number;
  /** Valor lido de um registo relacionado; calculado pelo servidor. */
  readonly lookup: string | number | boolean;
  /** Identificador sequencial atribuído pelo servidor (ex.: `CLI-0007`). */
  readonly 'auto-number': string;
}

export type FieldType = keyof FieldValueTypes;

export type FieldValue = FieldValueTypes[FieldType] | null;

export interface FieldOption {
  /** Valor técnico estável, guardado nos registos. Nunca se reutiliza com outro significado. */
  readonly value: string;
  readonly label: string;
  /** `false` retira a opção de novas escolhas sem invalidar os registos que já a usam. */
  readonly active?: boolean;
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
  /** `core` (definido pela plataforma ou pela entidade) ou `custom` (acrescentado pelo tenant). */
  readonly origin?: FieldOrigin;
  /** Dados sensíveis exigem permissões explícitas de leitura e escrita (ver `permissions`). */
  readonly sensitivity?: FieldSensitivity;
  /**
   * Regras de validação do servidor que a interface não edita (ex.: limites de datas, precisão
   * decimal). Guardam-se tal como vieram e voltam ao servidor ao gravar, para não se perderem.
   */
  readonly serverValidation?: Readonly<Record<string, unknown>>;
}

export type FieldOrigin = 'core' | 'custom';
export type FieldSensitivity = 'normal' | 'sensitive';

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
/** Valor monetário numa moeda (ISO 4217) com precisão explícita (`scale`, por omissão 2). */
export type CurrencyField = FieldBase<'currency'> & {
  readonly currency: string;
  readonly scale?: number;
};
export type FileField = FieldBase<'file'> & {
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
  readonly maxSizeBytes?: number;
};
export type UrlField = FieldBase<'url'>;
export type RadioField = FieldBase<'radio'> & { readonly options: readonly FieldOption[] };
export type CheckboxField = FieldBase<'checkbox'>;
export type ImageField = FieldBase<'image'> & {
  /** Tipos MIME aceites (por omissão, qualquer `image/*`). */
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
  readonly maxSizeBytes?: number;
};

/** Referência a um registo de outra entidade do mesmo tenant. */
export type EntityReferenceField = FieldBase<'entity-reference'> & {
  readonly entityKey: string;
  /** Campo da entidade alvo usado como rótulo (por omissão, o primeiro campo da listagem). */
  readonly displayField?: string;
  /** Só `one` está suportado nesta fase. */
  readonly cardinality?: 'one';
};

export type UserReferenceField = FieldBase<'user-reference'>;

/** Operadores e funções permitidos numa fórmula: ver `formula.ts`. */
export interface FormulaDefinition {
  /** Expressão declarativa, ex.: `quantidade * precoUnitario - desconto`. */
  readonly source: string;
}

export interface LookupDefinition {
  /** Campo `entity-reference` desta entidade que aponta para o registo de origem. */
  readonly relationField: string;
  /** Campo do registo referenciado cujo valor se mostra. */
  readonly sourceField: string;
  /** O que fazer quando o registo referenciado já não existe. */
  readonly onMissing: 'empty' | 'error';
  /**
   * Só no cliente, nunca gravado: a definição do campo de origem, resolvida pelo registo para que
   * os renderers formatem o valor (data, moeda, opção…) como o campo original.
   */
  readonly resolvedSource?: FieldDefinition;
}

export interface AutoNumberDefinition {
  readonly prefix: string;
  /** Número de dígitos, com zeros à esquerda. */
  readonly padding: number;
  readonly start: number;
  /** `yearly`/`monthly` reiniciam a sequência todos os anos/meses (o período entra no número). */
  readonly reset: 'never' | 'yearly' | 'monthly';
}

export type FormulaField = FieldBase<'formula'> & {
  readonly formula: FormulaDefinition;
  /** Casas decimais do resultado (arredondamento exacto, sem vírgula flutuante). */
  readonly scale: number;
};
export type LookupField = FieldBase<'lookup'> & { readonly lookup: LookupDefinition };
export type AutoNumberField = FieldBase<'auto-number'> & {
  readonly autoNumber: AutoNumberDefinition;
};

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
  | UrlField
  | RadioField
  | CheckboxField
  | ImageField
  | EntityReferenceField
  | UserReferenceField
  | FormulaField
  | LookupField
  | AutoNumberField;

export type FieldOf<T extends FieldType> = Extract<FieldDefinition, { type: T }>;

export function hasOptions(
  field: FieldDefinition,
): field is SelectField | MultiSelectField | RadioField {
  return field.type === 'select' || field.type === 'multiselect' || field.type === 'radio';
}

/** Opções que se podem escolher agora (as inactivas só existem para ler dados antigos). */
export function activeOptions(
  field: SelectField | MultiSelectField | RadioField,
): readonly FieldOption[] {
  return field.options.filter((o) => o.active !== false);
}
