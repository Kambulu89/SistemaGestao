import type { DefinitionIssue } from '../engine/definition-integrity';
import { defineEntity, defineField, type FieldInput } from '../engine/define-entity';
import type { EntityDefinition } from '../models/entity-definition.model';
import type {
  FieldDefinition,
  FieldOption,
  FieldType,
  FieldValue,
} from '../models/field-definition.model';
import { hasOptions } from '../models/field-definition.model';
import type { Condition } from '../models/condition.model';
import type {
  FormColumns,
  FormDefinition,
  FormFieldItem,
  FormSection,
} from '../models/form-definition.model';
import type { RecordData } from '../models/entity-record.model';
import type { ValidationRule } from '../models/validation-rule.model';
import type {
  EntityDetailDto,
  ConditionDto,
  EntityDto,
  FieldDto,
  FormDto,
  FormSectionDto,
  FieldInputDto,
  FieldPresentationDto,
  VersionDto,
} from './dynamic-dto';

/**
 * Tradução entre o modelo da interface (chaves `kebab-case` nas entidades e `camelCase` nos campos,
 * decimais como número) e a API (códigos `snake_case`, decimais em texto). É o **único** ponto onde isto
 * acontece. O que o servidor não suporta nunca se perde em silêncio: ou viaja em `serverValidation`
 * ou a operação é recusada com a lista de problemas.
 */

// --- códigos ↔ chaves -------------------------------------------------------------------------

export const entityKeyOf = (code: string): string => code.replaceAll('_', '-');
export const entityCodeOf = (key: string): string => key.replaceAll('-', '_');

export const fieldKeyOf = (code: string): string =>
  code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const fieldCodeOf = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Um código que não volta a si próprio (ex.: `a__b`) não tem chave na interface. */
export class UnrepresentableDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrepresentableDefinitionError';
  }
}

function checkedFieldKey(code: string): string {
  const key = fieldKeyOf(code);
  if (!/^[a-z][a-zA-Z0-9]*$/.test(key) || fieldCodeOf(key) !== code) {
    throw new UnrepresentableDefinitionError(
      `O campo "${code}" tem um código que a interface não consegue representar.`,
    );
  }
  return key;
}

// --- tipos -------------------------------------------------------------------------------------

const TYPE_TO_SERVER: Readonly<Partial<Record<FieldType, string>>> = {
  text: 'TEXT',
  textarea: 'TEXTAREA',
  number: 'NUMBER',
  decimal: 'DECIMAL',
  boolean: 'BOOLEAN',
  date: 'DATE',
  datetime: 'DATETIME',
  email: 'EMAIL',
  phone: 'PHONE',
  url: 'URL',
  select: 'SELECT',
  radio: 'RADIO',
  multiselect: 'MULTISELECT',
  'entity-reference': 'ENTITY_REFERENCE',
  'user-reference': 'USER_REFERENCE',
  formula: 'FORMULA',
  lookup: 'LOOKUP',
};
const TYPE_FROM_SERVER = new Map(
  Object.entries(TYPE_TO_SERVER).map(([type, server]) => [server, type as FieldType]),
);

/** Tipos que o servidor sabe guardar e validar (os restantes ainda não têm backend). */
export const SERVER_FIELD_TYPES: ReadonlySet<FieldType> = new Set(
  Object.keys(TYPE_TO_SERVER) as FieldType[],
);

/** Precisão fixa dos decimais: 15 dígitos cabem exactamente num número da interface. */
export const DECIMAL_PRECISION = 15;
const DEFAULT_SCALE = 2;

// --- fórmulas ----------------------------------------------------------------------------------

const FORMULA_FUNCTIONS = new Set(['round', 'min', 'max', 'abs']);

/** Reescreve os identificadores de campo de uma fórmula (as funções, seguidas de `(`, ficam). */
function mapFormulaIdentifiers(source: string, map: (name: string) => string): string {
  return source.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name, offset: number) =>
    FORMULA_FUNCTIONS.has(name) && /^\s*\(/.test(source.slice(offset + name.length))
      ? name
      : map(name),
  );
}

// --- decimais ----------------------------------------------------------------------------------

/** Decimal do servidor (texto) → número da interface; recusa o que o número não representa exactamente. */
export function decimalToNumber(text: string, scale: number): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value.toFixed(scale) !== text) {
    throw new UnrepresentableDefinitionError(
      `O valor decimal "${text}" não cabe num número da interface sem perder precisão.`,
    );
  }
  return value;
}

export function decimalToText(value: number, scale: number): string {
  const text = value.toFixed(scale);
  if (!Number.isFinite(value) || Number(text) !== value) {
    throw new UnrepresentableDefinitionError(
      `O valor ${value} tem mais de ${scale} casas decimais.`,
    );
  }
  return text;
}

// --- servidor → interface ----------------------------------------------------------------------

function rulesFromServer(
  type: FieldType,
  validation: Readonly<Record<string, unknown>>,
  scale: number,
): { rules: ValidationRule[]; server: Record<string, unknown> } {
  const rules: ValidationRule[] = [];
  const server: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validation)) {
    switch (key) {
      case 'unique':
        if (value === true) rules.push({ type: 'unique' });
        break;
      case 'minLength':
      case 'maxLength':
        rules.push({ type: key, value: value as number });
        break;
      case 'pattern':
        rules.push({ type: 'pattern', pattern: value as string });
        break;
      case 'min':
      case 'max':
        if (type === 'number') rules.push({ type: key, value: value as number });
        else if (type === 'decimal')
          rules.push({ type: key, value: decimalToNumber(value as string, scale) });
        else server[key] = value;
        break;
      default:
        server[key] = value;
    }
  }
  return { rules, server };
}

function fieldFromServer(dto: FieldDto): FieldDefinition {
  const type = TYPE_FROM_SERVER.get(dto.type);
  if (!type) throw new UnrepresentableDefinitionError(`Tipo de campo desconhecido: ${dto.type}.`);
  const hasScale = type === 'decimal' || type === 'formula';
  const scale = hasScale ? ((dto.validation['scale'] as number) ?? DEFAULT_SCALE) : 0;
  const { rules, server } = rulesFromServer(type, dto.validation, scale);
  if (hasScale) delete server['scale'];
  // A árvore e as dependências são derivadas pelo servidor da expressão; a interface só conhece o texto.
  delete server['ast'];
  delete server['dependencies'];
  delete server['expression'];
  // O que a interface edita num valor relacionado vive em `lookup`; `sourceType` e `scale` (derivados pelo servidor) ficam em serverValidation.
  if (type === 'lookup') {
    delete server['relationField'];
    delete server['sourceField'];
    delete server['onMissing'];
  }
  const key = checkedFieldKey(dto.code);

  const defaultValue =
    dto.defaultValue === null || dto.defaultValue === undefined
      ? undefined
      : type === 'decimal'
        ? decimalToNumber(dto.defaultValue as string, scale)
        : dto.defaultValue;

  const base = {
    type,
    key,
    label: dto.label,
    description: dto.presentation.description,
    placeholder: dto.presentation.placeholder,
    required: dto.required,
    editable: !dto.readOnly,
    order: (dto.position + 1) * 10,
    validations: rules,
    searchable: dto.presentation.searchable ?? false,
    filterable: dto.presentation.filterable ?? false,
    sortable: dto.presentation.sortable ?? false,
    archived: dto.archived || undefined,
    defaultValue,
    ...(Object.keys(server).length > 0 ? { serverValidation: server } : {}),
    ...(dto.sensitive
      ? {
          sensitivity: 'sensitive' as const,
          permissions: { read: 'dynamic.sensitive', write: 'dynamic.sensitive' },
        }
      : {}),
  };

  const options: FieldOption[] = dto.options.map((o) => ({
    value: o.code,
    label: o.label,
    ...(o.archived ? { active: false } : {}),
  }));
  let input: FieldInput;
  switch (type) {
    case 'select':
    case 'multiselect':
    case 'radio':
      input = { ...base, type, options } as FieldInput;
      break;
    case 'decimal':
      input = { ...base, type, scale } as FieldInput;
      break;
    case 'formula': {
      const expression = dto.validation['expression'];
      if (typeof expression !== 'string')
        throw new UnrepresentableDefinitionError(`O campo "${dto.code}" não tem expressão.`);
      input = {
        ...base,
        type,
        scale,
        formula: { source: mapFormulaIdentifiers(expression, fieldKeyOf) },
      } as FieldInput;
      break;
    }
    case 'lookup': {
      const { relationField, sourceField, onMissing } = dto.validation;
      if (typeof relationField !== 'string' || typeof sourceField !== 'string')
        throw new UnrepresentableDefinitionError(`O campo "${dto.code}" não tem origem.`);
      input = {
        ...base,
        type,
        lookup: {
          relationField: checkedFieldKey(relationField),
          sourceField: checkedFieldKey(sourceField),
          onMissing: onMissing === 'error' ? 'error' : 'empty',
        },
      } as FieldInput;
      break;
    }
    case 'entity-reference': {
      if (!dto.referenceEntityCode)
        throw new UnrepresentableDefinitionError(`O campo "${dto.code}" não indica o destino.`);
      input = { ...base, type, entityKey: entityKeyOf(dto.referenceEntityCode) } as FieldInput;
      break;
    }
    default:
      input = { ...base, type } as FieldInput;
  }
  const defined = defineField(input);
  return { ...defined, origin: 'core' } as FieldDefinition;
}

/** Operações → permissões do servidor (o que o servidor não tem, mapeia para uma permissão nunca concedida). */
export const SERVER_ENTITY_OPERATIONS: EntityDefinition['permissions']['operations'] = {
  read: 'dynamic.read',
  create: 'dynamic.create',
  update: 'dynamic.update',
  delete: 'dynamic.archive',
  export: 'dynamic.export',
  approve: 'dynamic.approve',
  transition: 'dynamic.transition',
};

function versionToDefinition(
  tenantId: string,
  entity: EntityDto,
  version: VersionDto,
  state: EntityDefinition['state'],
  forms: readonly FormDefinition[] = [],
): EntityDefinition {
  const key = entityKeyOf(entity.code);
  const base = defineEntity({
    key,
    scope: 'tenant',
    tenantId,
    moduleId: null,
    version: version.revision,
    state,
    names: { singular: entity.name, plural: entity.presentation.pluralName ?? entity.name },
    description: entity.description ?? undefined,
    icon: entity.presentation.icon ?? 'cube',
    fields: version.fields.map((f) => fieldFromServer(f)),
    forms,
    publishedAt: version.publishedAt ?? undefined,
    meta: {
      createdAt: entity.createdAt,
      createdBy: '',
      updatedAt: entity.updatedAt,
      updatedBy: '',
    },
  });
  return {
    ...base,
    id: version.id,
    permissions: { operations: SERVER_ENTITY_OPERATIONS, policies: [] },
    rowVersion: entity.version,
  };
}

// --- formulários ---------------------------------------------------------------------------------

/** Condição do servidor (códigos de campo) → condição da interface (chaves de campo). */
function conditionFromServer(dto: ConditionDto): Condition {
  switch (dto.op) {
    case 'and':
    case 'or':
      return { op: dto.op, conditions: dto.conditions.map(conditionFromServer) };
    case 'not':
      return { op: 'not', condition: conditionFromServer(dto.condition) };
    case 'in':
    case 'nin':
      return { op: dto.op, field: checkedFieldKey(dto.field), values: dto.values };
    case 'empty':
    case 'notEmpty':
      return { op: dto.op, field: checkedFieldKey(dto.field) };
    default:
      return { op: dto.op, field: checkedFieldKey(dto.field), value: dto.value };
  }
}

function sectionFromServer(dto: FormSectionDto): FormSection {
  return {
    key: dto.key.replaceAll('_', '-'),
    title: dto.title,
    ...(dto.description ? { description: dto.description } : {}),
    columns: dto.columns as FormColumns,
    ...(dto.visibleWhen ? { visibleWhen: conditionFromServer(dto.visibleWhen) } : {}),
    items: dto.items.map<FormFieldItem>((item) => ({
      kind: 'field',
      field: checkedFieldKey(item.field),
      ...(item.span ? { span: item.span as FormColumns } : {}),
      ...(item.label ? { label: item.label } : {}),
      ...(item.placeholder ? { placeholder: item.placeholder } : {}),
      ...(item.help ? { help: item.help } : {}),
      ...(item.visible === undefined ? {} : { visible: item.visible }),
      ...(item.editable === undefined ? {} : { editable: item.editable }),
      ...(item.required === undefined ? {} : { required: item.required }),
      ...(item.visibleWhen ? { visibleWhen: conditionFromServer(item.visibleWhen) } : {}),
      ...(item.editableWhen ? { editableWhen: conditionFromServer(item.editableWhen) } : {}),
      ...(item.requiredWhen ? { requiredWhen: conditionFromServer(item.requiredWhen) } : {}),
    })),
  };
}

/**
 * Formulários publicados do servidor → formulários da interface. Um formulário que o servidor já não considera
 * utilizável (campos retirados, por exemplo) ou que a interface não representa fica de fora: a entidade volta ao
 * formulário gerado, em vez de mostrar um formulário partido.
 */
export function formFromDto(tenantId: string, dto: FormDto): FormDefinition {
  return {
    id: dto.id,
    key: entityKeyOf(dto.code),
    name: dto.name,
    ...(dto.description ? { description: dto.description } : {}),
    entityKey: entityKeyOf(dto.entityCode),
    scope: 'tenant',
    tenantId,
    version: dto.revision,
    state: 'published',
    modes: dto.modes,
    isDefault: dto.isDefault,
    sections: dto.sections.map(sectionFromServer),
    ...(dto.publishedAt ? { publishedAt: dto.publishedAt } : {}),
  };
}

export function formsFromServer(tenantId: string, forms: readonly FormDto[]): FormDefinition[] {
  const result: FormDefinition[] = [];
  for (const dto of forms) {
    if (dto.status !== 'PUBLISHED' || dto.issues.length > 0) continue;
    try {
      result.push(formFromDto(tenantId, dto));
    } catch (error) {
      if (!(error instanceof UnrepresentableDefinitionError)) throw error;
    }
  }
  return result;
}

/** Uma entidade do servidor → as suas definições para a interface: a publicada (ou arquivada) e o rascunho. */
export function definitionsFromServer(
  tenantId: string,
  detail: EntityDetailDto,
  forms: readonly FormDefinition[] = [],
): EntityDefinition[] {
  const result: EntityDefinition[] = [];
  const { entity, published, draft } = detail;
  if (published) {
    result.push(
      versionToDefinition(
        tenantId,
        entity,
        published,
        entity.status === 'ARCHIVED' ? 'archived' : 'published',
        forms,
      ),
    );
  }
  if (draft) result.push(versionToDefinition(tenantId, entity, draft, 'draft'));
  return result;
}

// --- interface → servidor ----------------------------------------------------------------------

const issue = (path: string, message: string): DefinitionIssue => ({
  severity: 'error',
  path,
  message,
});

/** O que o servidor não representa: problemas reportados em vez de gravados pela metade. */
export function fieldToServer(
  field: FieldDefinition,
  issues: DefinitionIssue[],
  path: string,
): FieldInputDto | null {
  const serverType = TYPE_TO_SERVER[field.type];
  if (!serverType) {
    issues.push(issue(path, `O tipo "${field.type}" ainda não está disponível no servidor.`));
    return null;
  }
  if (field.visible === false || field.visibleWhen || field.editableWhen || field.requiredWhen) {
    issues.push(
      issue(path, 'As condições de visibilidade e edição ainda não existem no servidor.'),
    );
    return null;
  }

  const scale =
    field.type === 'decimal' || field.type === 'formula' ? (field.scale ?? DEFAULT_SCALE) : 0;
  const validation: Record<string, unknown> = { ...field.serverValidation };
  for (const rule of field.validations) {
    if (rule.when) {
      issues.push(issue(path, 'As regras condicionais ainda não existem no servidor.'));
      continue;
    }
    switch (rule.type) {
      case 'unique':
        validation['unique'] = true;
        break;
      case 'minLength':
      case 'maxLength':
        validation[rule.type] = rule.value;
        break;
      case 'min':
      case 'max':
        validation[rule.type] =
          field.type === 'decimal' ? decimalToText(rule.value, scale) : rule.value;
        break;
      case 'pattern':
        if (rule.ignoreCase)
          issues.push(issue(path, 'O padrão sem distinção de maiúsculas não existe no servidor.'));
        else validation['pattern'] = rule.pattern;
        break;
      case 'required':
      case 'email':
        break;
      case 'compare':
        issues.push(issue(path, 'As comparações entre campos ainda não existem no servidor.'));
        break;
    }
  }
  if (field.type === 'decimal') {
    validation['precision'] ??= DECIMAL_PRECISION;
    validation['scale'] = scale;
  }

  if (field.type === 'lookup') {
    validation['relationField'] = fieldCodeOf(field.lookup.relationField);
    validation['sourceField'] = fieldCodeOf(field.lookup.sourceField);
    validation['onMissing'] = field.lookup.onMissing;
  }
  if (field.type === 'formula') {
    validation['expression'] = mapFormulaIdentifiers(field.formula.source, fieldCodeOf);
    validation['scale'] = scale;
  }

  const presentation: FieldPresentationDto = {
    ...(field.description ? { description: field.description } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    searchable: field.searchable,
    filterable: field.filterable,
    sortable: field.sortable,
  };

  return {
    code: fieldCodeOf(field.key),
    label: field.label,
    type: serverType,
    required: field.required,
    ...(field.defaultValue === undefined || field.defaultValue === null
      ? {}
      : {
          defaultValue:
            field.type === 'decimal'
              ? decimalToText(field.defaultValue as number, scale)
              : field.defaultValue,
        }),
    validation,
    ...(hasOptions(field)
      ? {
          // Uma opção inactiva sai do rascunho: a publicação arquiva-a (os registos antigos continuam legíveis).
          options: field.options
            .filter((o) => o.active !== false)
            .map((o) => ({ code: o.value, label: o.label })),
        }
      : {}),
    ...(field.type === 'entity-reference'
      ? { referenceEntityCode: entityCodeOf(field.entityKey) }
      : {}),
    sensitive: field.sensitivity === 'sensitive',
    readOnly: field.editable === false || field.type === 'formula' || field.type === 'lookup',
    presentation,
  };
}

// --- registos ----------------------------------------------------------------------------------

type FieldsByCode = ReadonlyMap<string, FieldDefinition>;

export const fieldsByCode = (fields: readonly FieldDefinition[]): FieldsByCode =>
  new Map(fields.map((f) => [fieldCodeOf(f.key), f]));

/** Decimais, fórmulas e valores relacionados cuja origem é decimal chegam como texto. */
function isDecimalValue(field: FieldDefinition): boolean {
  if (field.type === 'decimal' || field.type === 'formula') return true;
  return (
    field.type === 'lookup' &&
    ['DECIMAL', 'FORMULA'].includes(String(field.serverValidation?.['sourceType']))
  );
}

function decimalScaleOf(field: FieldDefinition): number {
  if (field.type === 'decimal' || field.type === 'formula') return field.scale ?? DEFAULT_SCALE;
  const scale = field.serverValidation?.['scale'];
  return typeof scale === 'number' ? scale : DEFAULT_SCALE;
}

/** `data` do servidor → valores da interface (chaves `camelCase`, decimais como número). */
export function recordDataFromServer(
  data: Readonly<Record<string, unknown>>,
  fields: FieldsByCode,
): RecordData {
  const result: Record<string, FieldValue> = {};
  for (const [code, value] of Object.entries(data)) {
    const field = fields.get(code);
    result[checkedFieldKey(code)] = (
      typeof value === 'string' && field && isDecimalValue(field)
        ? decimalToNumber(value, decimalScaleOf(field))
        : value
    ) as FieldValue;
  }
  return result;
}

/**
 * Valores da interface → `data` do servidor. Só seguem campos que o utilizador pode escrever; um valor
 * vazio apaga o valor guardado (`null`).
 */
export function recordDataToServer(
  data: RecordData,
  fields: readonly FieldDefinition[],
): Record<string, unknown> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = byKey.get(key);
    if (value === undefined || (field && (field.archived || field.editable === false))) continue;
    const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0);
    result[fieldCodeOf(key)] = empty
      ? null
      : field?.type === 'decimal'
        ? decimalToText(value as number, field.scale ?? DEFAULT_SCALE)
        : value;
  }
  return result;
}
