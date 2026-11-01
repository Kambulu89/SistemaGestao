import type { ValidationRule } from '../models/validation-rule.model';
import {
  type AutoNumberDefinition,
  type FieldDefinition,
  type FieldOption,
  type FieldType,
  hasOptions,
} from '../models/field-definition.model';
import { defineField, type FieldInput } from './define-entity';
import { fieldCapabilities } from './field-types';

/**
 * Representação plana de um campo, tal como os designers a editam (valores de formulário).
 * `buildField` e `draftOf` convertem entre isto e o `FieldDefinition` — a única fonte de verdade
 * dos tipos, partilhada pelo designer de campos personalizados e pelo de entidades.
 */
export interface FieldDraft {
  readonly type: FieldType;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly searchable: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly unique: boolean;
  readonly sensitive: boolean;
  readonly options: readonly FieldOption[];
  readonly scale: number | null;
  readonly currency: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly accept: string;
  readonly maxSizeMb: number | null;
  readonly multiple: boolean;
  /** Chave da entidade alvo (`entity-reference`). */
  readonly referenceEntity: string;
  /** `auto-number` */
  readonly autoPrefix: string;
  readonly autoPadding: number | null;
  readonly autoStart: number | null;
  readonly autoReset: AutoNumberDefinition['reset'];
  /** `formula` */
  readonly formulaSource: string;
  readonly formulaScale: number | null;
  /** `lookup` */
  readonly lookupRelation: string;
  readonly lookupSource: string;
  readonly lookupOnMissing: 'empty' | 'error';
}

export const EMPTY_DRAFT: FieldDraft = {
  type: 'text',
  code: '',
  name: '',
  description: '',
  placeholder: '',
  required: false,
  searchable: false,
  filterable: false,
  sortable: false,
  unique: false,
  sensitive: false,
  options: [],
  scale: null,
  currency: 'EUR',
  min: null,
  max: null,
  minLength: null,
  maxLength: null,
  accept: '',
  maxSizeMb: null,
  multiple: false,
  referenceEntity: '',
  autoPrefix: '',
  autoPadding: 4,
  autoStart: 1,
  autoReset: 'never',
  formulaSource: '',
  formulaScale: 2,
  lookupRelation: '',
  lookupSource: '',
  lookupOnMissing: 'empty',
};

/** `Gestor comercial` → `gestorComercial`: sem acentos, camelCase, a começar por letra. */
export function codeFromName(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return /^[a-z]/.test(camel)
    ? camel
    : camel
      ? `campo${camel[0]!.toUpperCase()}${camel.slice(1)}`
      : '';
}

/** Chave de uma entidade (minúsculas, números e hífen), alinhada com a regra de integridade. */
export const ENTITY_KEY_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;

/** `Ordem de serviço` → `ordem-de-servico`. */
export function entityKeyFromName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return /^[a-z]/.test(slug) ? slug : slug ? `e-${slug}`.slice(0, 30) : '';
}

/** Permissões de leitura/escrita de um campo sensível: `entities.<entidade>.sensitive.*`. */
export const sensitivePermissions = (entityKey: string) => ({
  read: `entities.${entityKey}.sensitive.read`,
  write: `entities.${entityKey}.sensitive.write`,
});

const MANAGED_RULES: readonly ValidationRule['type'][] = [
  'unique',
  'min',
  'max',
  'minLength',
  'maxLength',
];

/** Propriedades que o designer não mostra mas que um campo existente pode ter. */
function preservedProps(base: FieldDefinition | undefined) {
  if (!base) return {};
  const {
    defaultValue,
    visible,
    editable,
    visibleWhen,
    editableWhen,
    requiredWhen,
    archived,
    serverValidation,
  } = base;
  return Object.fromEntries(
    Object.entries({
      defaultValue,
      visible,
      editable,
      visibleWhen,
      editableWhen,
      requiredWhen,
      archived,
      serverValidation,
      origin: base.origin,
    }).filter(([, v]) => v !== undefined),
  );
}

const num = (value: number | null): number | undefined => value ?? undefined;
const list = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Constrói o campo a partir do rascunho; só aplica o que o tipo admite. */
export function buildField(
  draft: FieldDraft,
  context: { readonly entityKey: string; readonly order?: number },
  base?: FieldDefinition,
): FieldDefinition {
  const caps = fieldCapabilities(draft.type);
  // O que o designer não edita (padrão, e-mail, comparações…) mantém-se ao alterar um campo existente.
  const validations: ValidationRule[] = (base?.validations ?? []).filter(
    (r) => !MANAGED_RULES.includes(r.type),
  );
  if (caps.unique && draft.unique) validations.push({ type: 'unique' });
  if (draft.min !== null) validations.push({ type: 'min', value: draft.min });
  if (draft.max !== null) validations.push({ type: 'max', value: draft.max });
  if (draft.minLength !== null) validations.push({ type: 'minLength', value: draft.minLength });
  if (draft.maxLength !== null) validations.push({ type: 'maxLength', value: draft.maxLength });

  const common = {
    ...preservedProps(base),
    key: draft.code,
    label: draft.name.trim(),
    description: draft.description.trim() || undefined,
    placeholder: draft.placeholder.trim() || undefined,
    required: caps.required && draft.required,
    permissions: undefined,
    sensitivity: undefined,
    searchable: caps.searchable && draft.searchable,
    filterable: caps.filterable && draft.filterable,
    sortable: caps.sortable && draft.sortable,
    validations,
    ...(draft.sensitive
      ? {
          sensitivity: 'sensitive' as const,
          permissions: sensitivePermissions(context.entityKey),
        }
      : {}),
    ...(context.order !== undefined ? { order: context.order } : {}),
  };

  const options = draft.options.map((o) => ({
    value: o.value.trim(),
    label: o.label.trim(),
    ...(o.active === false ? { active: false } : {}),
  }));
  const rules = (...allowed: ValidationRule['type'][]) =>
    validations.filter(
      (r) => !MANAGED_RULES.includes(r.type) || allowed.includes(r.type) || r.type === 'unique',
    );

  let input: FieldInput;
  switch (draft.type) {
    case 'select':
    case 'multiselect':
    case 'radio':
      input = { ...common, type: draft.type, options, validations: rules() };
      break;
    case 'decimal':
      input = {
        ...common,
        type: 'decimal',
        scale: num(draft.scale),
        validations: rules('min', 'max'),
      };
      break;
    case 'currency':
      input = {
        ...common,
        type: 'currency',
        currency: draft.currency.trim().toUpperCase(),
        scale: num(draft.scale),
        validations: rules('min', 'max'),
      };
      break;
    case 'number':
      input = { ...common, type: 'number', validations: rules('min', 'max') };
      break;
    case 'text':
    case 'textarea':
      input = { ...common, type: draft.type, validations: rules('minLength', 'maxLength') };
      break;
    case 'file':
    case 'image':
      input = {
        ...common,
        type: draft.type,
        accept: list(draft.accept),
        multiple: draft.multiple,
        maxSizeBytes:
          draft.maxSizeMb !== null ? Math.round(draft.maxSizeMb * 1024 * 1024) : undefined,
        validations: rules(),
      };
      break;
    case 'formula':
      input = {
        ...common,
        type: 'formula',
        formula: { source: draft.formulaSource.trim() },
        scale: draft.formulaScale ?? 0,
        required: false,
        validations: rules(),
      };
      break;
    case 'lookup':
      input = {
        ...common,
        type: 'lookup',
        lookup: {
          relationField: draft.lookupRelation,
          sourceField: draft.lookupSource,
          onMissing: draft.lookupOnMissing,
        },
        required: false,
        validations: rules(),
      };
      break;
    case 'auto-number':
      input = {
        ...common,
        type: 'auto-number',
        autoNumber: {
          prefix: draft.autoPrefix.trim(),
          padding: draft.autoPadding ?? 0,
          start: draft.autoStart ?? 0,
          reset: draft.autoReset,
        },
        required: false,
        validations: rules(),
      };
      break;
    case 'entity-reference':
      input = {
        ...common,
        type: 'entity-reference',
        entityKey: draft.referenceEntity,
        validations: rules(),
      };
      break;
    default:
      // Restantes tipos simples (boolean, date, email, …) não têm configuração própria.
      input = { ...common, type: draft.type, validations: rules() } as FieldInput;
  }
  return defineField(input);
}

const ruleValue = (field: FieldDefinition, type: 'min' | 'max' | 'minLength' | 'maxLength') => {
  const rule = field.validations.find((r) => r.type === type);
  return rule && 'value' in rule ? rule.value : null;
};

/** Operação inversa de `buildField`, para editar um campo existente. */
export function draftOf(field: FieldDefinition): FieldDraft {
  return {
    ...EMPTY_DRAFT,
    type: field.type,
    code: field.key,
    name: field.label,
    description: field.description ?? '',
    placeholder: field.placeholder ?? '',
    required: field.required,
    searchable: field.searchable,
    filterable: field.filterable,
    sortable: field.sortable,
    unique: field.validations.some((r) => r.type === 'unique'),
    sensitive: field.sensitivity === 'sensitive',
    options: hasOptions(field) ? field.options : [],
    scale: 'scale' in field ? (field.scale ?? null) : null,
    currency: field.type === 'currency' ? field.currency : EMPTY_DRAFT.currency,
    min: ruleValue(field, 'min'),
    max: ruleValue(field, 'max'),
    minLength: ruleValue(field, 'minLength'),
    maxLength: ruleValue(field, 'maxLength'),
    accept: field.type === 'file' || field.type === 'image' ? (field.accept ?? []).join(', ') : '',
    maxSizeMb:
      (field.type === 'file' || field.type === 'image') && field.maxSizeBytes !== undefined
        ? field.maxSizeBytes / (1024 * 1024)
        : null,
    multiple: field.type === 'file' || field.type === 'image' ? (field.multiple ?? false) : false,
    referenceEntity: field.type === 'entity-reference' ? field.entityKey : '',
    autoPrefix: field.type === 'auto-number' ? field.autoNumber.prefix : '',
    autoPadding: field.type === 'auto-number' ? field.autoNumber.padding : EMPTY_DRAFT.autoPadding,
    autoStart: field.type === 'auto-number' ? field.autoNumber.start : EMPTY_DRAFT.autoStart,
    autoReset: field.type === 'auto-number' ? field.autoNumber.reset : EMPTY_DRAFT.autoReset,
    formulaSource: field.type === 'formula' ? field.formula.source : '',
    formulaScale: field.type === 'formula' ? field.scale : EMPTY_DRAFT.formulaScale,
    lookupRelation: field.type === 'lookup' ? field.lookup.relationField : '',
    lookupSource: field.type === 'lookup' ? field.lookup.sourceField : '',
    lookupOnMissing: field.type === 'lookup' ? field.lookup.onMissing : 'empty',
  };
}
