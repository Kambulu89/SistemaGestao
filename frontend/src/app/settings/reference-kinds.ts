import type { OrgField } from '../admin/org-kinds';

/**
 * Metadados das tabelas de referência da empresa (câmbios, séries documentais, calendários, contas bancárias). As
 * regras são do servidor (`backend/app/modules/settings`); aqui só rótulos, tipos de campo e colunas.
 */
export interface RefKind {
  segment: string;
  title: string;
  singular: string;
  /** Género do nome singular (para "Nova"/"Novo"). */
  feminine: boolean;
  /** `entityType` da auditoria e dos anexos. */
  entityType: string;
  readPermission: string;
  managePermission: string;
  fields: OrgField[];
  columns: { key: string; label: string }[];
  /** Filtros de lista suportados pelo servidor. */
  filters: OrgField[];
  /** Campo que dá o título do detalhe. */
  title_: (r: Record<string, unknown>) => string;
}

export const DOCUMENT_TYPES = [
  { value: 'INVOICE', label: 'Factura' },
  { value: 'INVOICE_RECEIPT', label: 'Factura-recibo' },
  { value: 'SIMPLIFIED_INVOICE', label: 'Factura simplificada' },
  { value: 'CREDIT_NOTE', label: 'Nota de crédito' },
  { value: 'DEBIT_NOTE', label: 'Nota de débito' },
  { value: 'RECEIPT', label: 'Recibo' },
  { value: 'QUOTE', label: 'Proposta / orçamento' },
  { value: 'SALES_ORDER', label: 'Encomenda de cliente' },
  { value: 'PURCHASE_ORDER', label: 'Encomenda a fornecedor' },
  { value: 'DELIVERY_NOTE', label: 'Guia de remessa' },
  { value: 'TRANSPORT_GUIDE', label: 'Guia de transporte' },
  { value: 'PAYMENT', label: 'Pagamento' },
  { value: 'JOURNAL', label: 'Lançamento contabilístico' },
];
export const WEEKDAYS = [
  { value: 1, label: 'Segunda' },
  { value: 2, label: 'Terça' },
  { value: 3, label: 'Quarta' },
  { value: 4, label: 'Quinta' },
  { value: 5, label: 'Sexta' },
  { value: 6, label: 'Sábado' },
  { value: 7, label: 'Domingo' },
];
export const HOLIDAY_KINDS = [
  { value: 'NATIONAL', label: 'Nacional' },
  { value: 'REGIONAL', label: 'Regional' },
  { value: 'COMPANY', label: 'Da empresa' },
];

const LEGAL_ENTITY: OrgField = {
  key: 'legalEntityId',
  label: 'Entidade legal',
  type: 'ref',
  ref: 'legal-entities',
  required: true,
  immutable: true,
};
const BRANCH: OrgField = {
  key: 'branchId',
  label: 'Filial',
  type: 'ref',
  ref: 'branches',
  immutable: true,
};
const currency = (key: string, label: string, immutable = true): OrgField => ({
  key,
  label,
  type: 'text',
  required: true,
  immutable,
  hint: 'ISO 4217 (ex.: AOA, USD).',
});
const ACTIVE_INACTIVE = [
  { value: 'ACTIVE', label: 'Activo' },
  { value: 'INACTIVE', label: 'Inactivo' },
];

export const REF_KINDS: Record<string, RefKind> = {
  'exchange-rates': {
    segment: 'exchange-rates',
    title: 'Câmbios',
    singular: 'câmbio',
    feminine: false,
    entityType: 'exchange_rate',
    readPermission: 'settings.read',
    managePermission: 'settings.manage',
    fields: [
      currency('fromCurrency', 'De (moeda)'),
      currency('toCurrency', 'Para (moeda)'),
      {
        key: 'rate',
        label: 'Taxa',
        type: 'text',
        required: true,
        hint: '1 unidade "de" = taxa × "para". Até 10 casas decimais (ponto decimal).',
      },
      {
        key: 'validOn',
        label: 'Válido a partir de',
        type: 'date',
        required: true,
        immutable: true,
      },
      { key: 'source', label: 'Fonte', type: 'text', hint: 'Ex.: BNA, banco comercial.' },
    ],
    columns: [
      { key: 'validOn', label: 'Data' },
      { key: 'fromCurrency', label: 'De' },
      { key: 'toCurrency', label: 'Para' },
      { key: 'rate', label: 'Taxa' },
      { key: 'source', label: 'Fonte' },
    ],
    filters: [],
    title_: (r) => `${r['fromCurrency']} → ${r['toCurrency']} em ${r['validOn']}`,
  },
  'document-series': {
    segment: 'document-series',
    title: 'Séries documentais',
    singular: 'série',
    feminine: true,
    entityType: 'document_series',
    readPermission: 'settings.read',
    managePermission: 'settings.manage',
    fields: [
      LEGAL_ENTITY,
      BRANCH,
      {
        key: 'documentType',
        label: 'Tipo de documento',
        type: 'select',
        required: true,
        immutable: true,
        options: DOCUMENT_TYPES,
      },
      {
        key: 'code',
        label: 'Código da série',
        type: 'text',
        required: true,
        immutable: true,
        hint: 'Único por tipo e entidade legal (ex.: FT2026).',
      },
      { key: 'prefix', label: 'Prefixo', type: 'text', hint: 'Ex.: FT 2026/' },
      { key: 'fiscalYear', label: 'Exercício', type: 'number', immutable: true },
      {
        key: 'nextNumber',
        label: 'Próximo número',
        type: 'number',
        hint: 'Só avança: nunca se reutilizam números emitidos.',
      },
      { key: 'padding', label: 'Dígitos', type: 'number', hint: 'De 1 a 12 (zeros à esquerda).' },
      {
        key: 'status',
        label: 'Estado',
        type: 'select',
        options: [
          { value: 'ACTIVE', label: 'Aberta' },
          { value: 'CLOSED', label: 'Fechada (não reabre)' },
        ],
      },
      { key: 'validFrom', label: 'Válida desde', type: 'date' },
      { key: 'validTo', label: 'Válida até', type: 'date' },
    ],
    columns: [
      { key: 'documentType', label: 'Tipo' },
      { key: 'code', label: 'Série' },
      { key: 'legalEntityId', label: 'Entidade legal' },
      { key: 'nextFormatted', label: 'Próximo número' },
      { key: 'status', label: 'Estado' },
    ],
    filters: [
      {
        key: 'documentType',
        label: 'Tipo',
        type: 'select',
        options: DOCUMENT_TYPES,
      },
      {
        key: 'status',
        label: 'Estado',
        type: 'select',
        options: [
          { value: 'ACTIVE', label: 'Abertas' },
          { value: 'CLOSED', label: 'Fechadas' },
        ],
      },
    ],
    title_: (r) => `${r['code']}`,
  },
  calendars: {
    segment: 'calendars',
    title: 'Calendários',
    singular: 'calendário',
    feminine: false,
    entityType: 'calendar',
    readPermission: 'settings.read',
    managePermission: 'settings.manage',
    fields: [
      {
        key: 'code',
        label: 'Código',
        type: 'text',
        required: true,
        immutable: true,
      },
      { key: 'name', label: 'Nome', type: 'text', required: true },
      { key: 'countryCode', label: 'País (ISO, ex.: AO)', type: 'text', required: true },
      { key: 'province', label: 'Província', type: 'text' },
      { ...LEGAL_ENTITY, required: false, immutable: false },
      { ...BRANCH, immutable: false },
      { key: 'weekendDays', label: 'Dias de descanso', type: 'weekdays' },
      { key: 'status', label: 'Estado', type: 'select', options: ACTIVE_INACTIVE },
    ],
    columns: [
      { key: 'code', label: 'Código' },
      { key: 'name', label: 'Nome' },
      { key: 'countryCode', label: 'País' },
      { key: 'province', label: 'Província' },
      { key: 'status', label: 'Estado' },
    ],
    filters: [{ key: 'status', label: 'Estado', type: 'select', options: ACTIVE_INACTIVE }],
    title_: (r) => `${r['code']} — ${r['name']}`,
  },
  'bank-accounts': {
    segment: 'bank-accounts',
    title: 'Contas bancárias',
    singular: 'conta bancária',
    feminine: true,
    entityType: 'bank_account',
    readPermission: 'bank_accounts.read',
    managePermission: 'bank_accounts.manage',
    fields: [
      LEGAL_ENTITY,
      { key: 'holderName', label: 'Titular', type: 'text', required: true, immutable: true },
      { key: 'bankName', label: 'Banco', type: 'text', required: true, immutable: true },
      {
        key: 'iban',
        label: 'IBAN',
        type: 'text',
        immutable: true,
        hint: 'Validado pelos dígitos de controlo. Indique o IBAN ou o número de conta.',
      },
      { key: 'accountNumber', label: 'Número de conta', type: 'text', immutable: true },
      { key: 'swiftBic', label: 'SWIFT/BIC', type: 'text', immutable: true },
      currency('currency', 'Moeda'),
      {
        key: 'isDefault',
        label: 'Conta por omissão na moeda',
        type: 'boolean',
        hint: 'Só contas activas.',
      },
    ],
    columns: [
      { key: 'bankName', label: 'Banco' },
      { key: 'holderName', label: 'Titular' },
      { key: 'ibanMasked', label: 'IBAN / conta' },
      { key: 'currency', label: 'Moeda' },
      { key: 'isDefault', label: 'Por omissão' },
      { key: 'status', label: 'Estado' },
    ],
    filters: [
      {
        key: 'status',
        label: 'Estado',
        type: 'select',
        options: [
          { value: 'ACTIVE', label: 'Activas' },
          { value: 'PENDING_APPROVAL', label: 'Aguardam aprovação' },
          { value: 'REJECTED', label: 'Rejeitadas' },
          { value: 'INACTIVE', label: 'Inactivas' },
        ],
      },
    ],
    title_: (r) => `${r['bankName']} — ${r['holderName']}`,
  },
};

/** IBAN em grupos de 4 (só apresentação; o servidor guarda sem espaços). */
export const groupIban = (iban: string | null | undefined) =>
  iban ? iban.replace(/(.{4})/g, '$1 ').trim() : null;

export const weekdaysLabel = (days: number[] | null | undefined) =>
  (days ?? []).map((d) => WEEKDAYS.find((w) => w.value === d)?.label ?? d).join(', ') || '—';
