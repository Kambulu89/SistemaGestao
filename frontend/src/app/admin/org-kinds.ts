/**
 * Metadados das entidades organizacionais para a interface. As regras são as do servidor
 * (`backend/app/modules/organization/domain/organization.ts`); aqui só rótulos, tipos de campo e referências.
 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'date'
  | 'select'
  | 'number'
  | 'ref'
  | 'member'
  | 'boolean'
  | 'email'
  | 'tel'
  | 'url'
  | 'weekdays';

/** Secções do formulário, pela ordem em que aparecem. */
export const ORG_SECTIONS = [
  { id: 'main', title: 'Identificação', description: 'Código e dados principais.' },
  {
    id: 'fiscal',
    title: 'Regime fiscal',
    description:
      'Identificação para os documentos. As regras de cálculo fiscal são de outro módulo.',
  },
  { id: 'role', title: 'Função', description: 'O que o cargo faz e o que exige.' },
  { id: 'contacts', title: 'Contactos', description: 'Contactos institucionais.' },
  {
    id: 'address',
    title: 'Morada',
    description: 'Texto livre (província, município, comuna, bairro).',
  },
  {
    id: 'links',
    title: 'Relações e responsáveis',
    description: 'Tudo da mesma entidade legal (o servidor verifica).',
  },
  {
    id: 'state',
    title: 'Estado e vigência',
    description: 'Inactivar em vez de eliminar: o histórico fica.',
  },
] as const;
export type OrgSection = (typeof ORG_SECTIONS)[number]['id'];

export interface OrgField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  immutable?: boolean;
  options?: { value: string | number; label: string }[];
  /** Tipo referido (segmento do URL), para campos `ref`. */
  ref?: string;
  hint?: string;
  /** Secção do formulário; por omissão deriva do tipo (ver `sectionOf`). */
  section?: OrgSection;
}

export const sectionOf = (f: OrgField): OrgSection =>
  f.section ??
  (f.key === 'status' || f.key.startsWith('valid')
    ? 'state'
    : f.type === 'ref' || f.type === 'member'
      ? 'links'
      : 'main');

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

const EMAIL: OrgField = { key: 'email', label: 'Email', type: 'email', section: 'contacts' };
const PHONE: OrgField = { key: 'phone', label: 'Telefone', type: 'tel', section: 'contacts' };
const addr = (key: string, label: string): OrgField => ({
  key,
  label,
  type: 'text',
  section: 'address',
});
const ADDRESS: OrgField[] = [
  addr('addressLine', 'Endereço'),
  addr('neighbourhood', 'Bairro'),
  addr('commune', 'Comuna'),
  addr('municipality', 'Município'),
  addr('province', 'Província'),
  addr('postalCode', 'Código postal'),
];
const MANAGER: OrgField = {
  key: 'managerMembershipId',
  label: 'Responsável',
  type: 'member',
  hint: 'Membro activo da empresa.',
};
const COST_CENTER: OrgField = {
  key: 'costCenterId',
  label: 'Centro de custo',
  type: 'ref',
  ref: 'cost-centers',
};

export const MONTHS = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
].map((label, i) => ({ value: i + 1, label }));

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
      {
        key: 'taxRegime',
        label: 'Regime fiscal',
        type: 'text',
        section: 'fiscal',
        hint: 'Designação do regime (ex.: geral, simplificado). Sem regras de cálculo aqui.',
      },
      {
        key: 'vatRegistered',
        label: 'Sujeito a IVA',
        type: 'boolean',
        section: 'fiscal',
      },
      {
        key: 'fiscalYearStartMonth',
        label: 'Início do exercício',
        type: 'select',
        section: 'fiscal',
        options: MONTHS,
      },
      EMAIL,
      PHONE,
      { key: 'website', label: 'Sítio web', type: 'url', section: 'contacts' },
      ...ADDRESS,
      {
        key: 'representativeName',
        label: 'Representante legal',
        type: 'text',
        section: 'links',
      },
      {
        key: 'representativeRole',
        label: 'Qualidade do representante',
        type: 'text',
        section: 'links',
        hint: 'Ex.: sócio-gerente, administrador.',
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
      EMAIL,
      PHONE,
      ...ADDRESS,
      MANAGER,
      COST_CENTER,
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
      MANAGER,
      COST_CENTER,
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
      { key: 'jobFunction', label: 'Função', type: 'text', section: 'role' },
      { key: 'requirements', label: 'Requisitos', type: 'textarea', section: 'role' },
      { key: 'responsibilities', label: 'Responsabilidades', type: 'textarea', section: 'role' },
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
      MANAGER,
      STATUS,
      ...VALIDITY,
    ],
  },
};

/** Tipos com organograma (`GET organization/:kind/tree`). */
export const TREE_KINDS = new Set(['departments', 'cost-centers']);

export interface TreeNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  legalEntityId: string;
  status: string;
  managerName: string | null;
}

export interface TreeItem {
  node: TreeNode;
  depth: number;
}

/**
 * Ordena a árvore em profundidade (filhos a seguir ao pai, por código). Nós cujo pai não está na lista (outro filtro)
 * ficam na raiz; ciclos nunca chegam do servidor, mas cada nó só é visitado uma vez.
 */
export function flattenTree(nodes: TreeNode[]): TreeItem[] {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), n]);
  }
  const out: TreeItem[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of (children.get(parent) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export type OrgRecord = Record<string, unknown> & { id: string; version: number };

/** Rótulo curto de um registo para listas de escolha. */
export const recordLabel = (r: OrgRecord) =>
  `${r['code']} — ${(r['name'] ?? r['legalName'] ?? '') as string}`;

/**
 * Valores a enviar: na criação, os preenchidos; na alteração, só os que mudaram (o servidor recusa alterar campos
 * imutáveis, por isso nunca se reenviam).
 */
export function payloadFor(
  kind: { fields: OrgField[] },
  form: Record<string, unknown>,
  original: OrgRecord | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of kind.fields) {
    let value = form[field.key];
    if (typeof value === 'string') value = value.trim();
    if (value === '' || value === undefined) value = null;
    if (field.type === 'number' && value !== null) value = Number(value);
    if (field.type === 'boolean') value = value === null ? null : value === true;
    if (!original) {
      if (value !== null) out[field.key] = value;
    } else if (!field.immutable && !same(value, original[field.key] ?? null)) {
      out[field.key] = value;
    }
  }
  return out;
}

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b;
