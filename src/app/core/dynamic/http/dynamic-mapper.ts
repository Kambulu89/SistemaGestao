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
import type { RecordData } from '../models/entity-record.model';
import type { ValidationRule } from '../models/validation-rule.model';
import type {
  EntityDetailDto,
  EntityDto,
  FieldDto,
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
  const scale = type === 'decimal' ? ((dto.validation['scale'] as number) ?? DEFAULT_SCALE) : 0;
  const { rules, server } = rulesFromServer(type, dto.validation, scale);
  if (type === 'decimal') delete server['scale'];
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

/** Uma entidade do servidor → as suas definições para a interface: a publicada (ou arquivada) e o rascunho. */
export function definitionsFromServer(
  tenantId: string,
  detail: EntityDetailDto,
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

  const scale = field.type === 'decimal' ? (field.scale ?? DEFAULT_SCALE) : 0;
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
    readOnly: field.editable === false,
    presentation,
  };
}

// --- registos ----------------------------------------------------------------------------------

type FieldsByCode = ReadonlyMap<string, FieldDefinition>;

export const fieldsByCode = (fields: readonly FieldDefinition[]): FieldsByCode =>
  new Map(fields.map((f) => [fieldCodeOf(f.key), f]));

/** `data` do servidor → valores da interface (chaves `camelCase`, decimais como número). */
export function recordDataFromServer(
  data: Readonly<Record<string, unknown>>,
  fields: FieldsByCode,
): RecordData {
  const result: Record<string, FieldValue> = {};
  for (const [code, value] of Object.entries(data)) {
    const field = fields.get(code);
    result[checkedFieldKey(code)] = (
      field?.type === 'decimal' && typeof value === 'string'
        ? decimalToNumber(value, field.scale ?? DEFAULT_SCALE)
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
