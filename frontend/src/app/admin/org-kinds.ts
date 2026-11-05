/**
 * Metadados das entidades organizacionais para a interface. As regras são as do servidor
 * (`backend/app/modules/organization/domain/organization.ts`); aqui só rótulos, tipos de campo e referências.
 */
export type FieldType = 'text' | 'textarea' | 'date' | 'select' | 'number' | 'ref';

export interface OrgField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  immutable?: boolean;
  options?: { value: string; label: string }[];
  /** Tipo referido (segmento do URL), para campos `ref`. */
  ref?: string;
  hint?: string;
}

export interface OrgKind {
  segment: string;
  title: string;
  singular: string;
  /** `subjectType` dos anexos. */
  entityType: string;
  fields: OrgField[];
  columns: string[];
}

const STATUS: OrgField = {
  key: 'status',
  label: 'Estado',
  type: 'select',
  options: [
    { value: 'ACTIVE', label: 'Activo' },
    { value: 'INACTIVE', label: 'Inactivo' },
  ],
};
const VALIDITY: OrgField[] = [
  { key: 'validFrom', label: 'Válido desde', type: 'date' },
  { key: 'validTo', label: 'Válido até', type: 'date' },
];
const CODE: OrgField = {
  key: 'code',
  label: 'Código',
  type: 'text',
  required: true,
  immutable: true,
  hint: 'Letras, números, . _ - (até 30). Não se altera depois de criado.',
};
const NAME: OrgField = { key: 'name', label: 'Nome', type: 'text', required: true };
const LEGAL_ENTITY: OrgField = {
  key: 'legalEntityId',
  label: 'Entidade legal',
  type: 'ref',
  ref: 'legal-entities',
  required: true,
  immutable: true,
};

export const BRANCH_TYPES = [
  { value: 'HEADQUARTERS', label: 'Sede' },
  { value: 'BRANCH', label: 'Filial' },
  { value: 'OFFICE', label: 'Escritório' },
  { value: 'STORE', label: 'Loja' },
  { value: 'WAREHOUSE', label: 'Armazém' },
  { value: 'PLANT', label: 'Fábrica' },
];

export const ORG_KINDS: Record<string, OrgKind> = {
  'legal-entities': {
    segment: 'legal-entities',
    title: 'Entidades legais',
    singular: 'entidade legal',
    entityType: 'legal_entity',
    columns: ['code', 'legalName', 'taxId', 'countryCode', 'functionalCurrency', 'status'],
    fields: [
      CODE,
      { key: 'legalName', label: 'Denominação social', type: 'text', required: true },
      { key: 'tradeName', label: 'Nome comercial', type: 'text' },
      { key: 'taxId', label: 'NIF', type: 'text', required: true },
      { key: 'countryCode', label: 'País (ISO, ex.: AO)', type: 'text', required: true },
      {
        key: 'functionalCurrency',
        label: 'Moeda funcional (ISO, ex.: AOA)',
        type: 'text',
        required: true,
      },
      STATUS,
      ...VALIDITY,
    ],
  },
  branches: {
    segment: 'branches',
    title: 'Filiais',
    singular: 'filial',
    entityType: 'branch',
    columns: ['code', 'name', 'type', 'legalEntityId', 'status'],
    fields: [
      CODE,
      NAME,
      LEGAL_ENTITY,
      { key: 'type', label: 'Tipo', type: 'select', options: BRANCH_TYPES },
      STATUS,
      ...VALIDITY,
    ],
  },
  departments: {
    segment: 'departments',
    title: 'Departamentos',
    singular: 'departamento',
    entityType: 'department',
    columns: ['code', 'name', 'legalEntityId', 'parentId', 'status'],
    fields: [
      CODE,
      NAME,
      LEGAL_ENTITY,
      { key: 'branchId', label: 'Filial', type: 'ref', ref: 'branches' },
      { key: 'parentId', label: 'Departamento pai', type: 'ref', ref: 'departments' },
      STATUS,
      ...VALIDITY,
    ],
  },
  positions: {
    segment: 'positions',
    title: 'Cargos',
    singular: 'cargo',
    entityType: 'position',
    columns: ['code', 'name', 'jobFamily', 'level', 'status'],
    fields: [
      CODE,
      NAME,
      { key: 'departmentId', label: 'Departamento', type: 'ref', ref: 'departments' },
      { key: 'jobFamily', label: 'Família profissional', type: 'text' },
      { key: 'category', label: 'Categoria', type: 'text' },
      { key: 'level', label: 'Nível (1 a 20)', type: 'number' },
      { key: 'description', label: 'Descrição', type: 'textarea' },
      STATUS,
      ...VALIDITY,
    ],
  },
  'cost-centers': {
    segment: 'cost-centers',
    title: 'Centros de custo',
    singular: 'centro de custo',
    entityType: 'cost_center',
    columns: ['code', 'name', 'legalEntityId', 'parentId', 'status'],
    fields: [
      CODE,
      NAME,
      LEGAL_ENTITY,
      { key: 'parentId', label: 'Centro de custo pai', type: 'ref', ref: 'cost-centers' },
      { key: 'departmentId', label: 'Departamento', type: 'ref', ref: 'departments' },
      STATUS,
      ...VALIDITY,
    ],
  },
};

export type OrgRecord = Record<string, unknown> & { id: string; version: number };

/** Rótulo curto de um registo para listas de escolha. */
export const recordLabel = (r: OrgRecord) =>
  `${r['code']} — ${(r['name'] ?? r['legalName'] ?? '') as string}`;

/**
 * Valores a enviar: na criação, os preenchidos; na alteração, só os que mudaram (o servidor recusa alterar campos
 * imutáveis, por isso nunca se reenviam).
 */
export function payloadFor(
  kind: OrgKind,
  form: Record<string, unknown>,
  original: OrgRecord | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of kind.fields) {
    let value = form[field.key];
    if (typeof value === 'string') value = value.trim();
    if (value === '' || value === undefined) value = null;
    if (field.type === 'number' && value !== null) value = Number(value);
    if (!original) {
      if (value !== null) out[field.key] = value;
    } else if (!field.immutable && value !== (original[field.key] ?? null)) {
      out[field.key] = value;
    }
  }
  return out;
}
