/** Fornecedores (9.1): tipos da API, rótulos, cores do estado e o corpo do pedido a partir do formulário. */

export type SupplierStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type SupplierType = 'GOODS' | 'SERVICES' | 'BOTH';
export type PaymentMethod = 'TRANSFER' | 'CHEQUE' | 'CASH' | 'OTHER';

export interface Contact {
  id: string;
  version: number;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface Partner {
  id: string;
  version: number;
  code: string;
  name: string;
  partnerType: 'ORGANIZATION' | 'INDIVIDUAL';
  taxId: string | null;
  countryCode: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  contacts: Contact[];
}

export interface SupplierRow {
  id: string;
  version: number;
  partner: Pick<
    Partner,
    'id' | 'code' | 'name' | 'taxId' | 'countryCode' | 'email' | 'phone' | 'status'
  >;
  supplierType: SupplierType;
  currency: string;
  paymentTermsDays: number;
  status: SupplierStatus;
  approvedAt: string | null;
  qualificationValid: boolean;
  qualificationExpiresOn: string | null;
  createdAt: string;
}

export interface Qualification {
  valid: boolean;
  missing: string[];
  expired: string[];
  expiring: string[];
  expiresOn: string | null;
  warningDays: number;
}

export interface BankAccount {
  id: string;
  version: number;
  holderName: string;
  bankName: string;
  iban: string | null;
  accountNumber: string | null;
  swiftBic: string | null;
  currency: string;
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'INACTIVE';
  requestedBy: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  masked: boolean;
  canDecide: boolean;
}

export interface SupplierDocument {
  id: string;
  version: number;
  documentType: { id: string; code: string; name: string; required: boolean };
  number: string | null;
  issuedOn: string | null;
  validUntil: string | null;
  attachment: { id: string; fileName: string } | null;
  status: 'ACTIVE' | 'INACTIVE';
  inactiveReason: string | null;
  valid: boolean;
}

export interface Review {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  submittedBy: { id: string; name: string | null };
  submittedAt: string;
  notes: string | null;
  decidedBy: { id: string; name: string | null } | null;
  decidedAt: string | null;
  decisionReason: string | null;
  items: {
    criterionId: string;
    code: string;
    name: string;
    required: boolean;
    result: string;
    notes: string | null;
  }[];
}

export interface Setting {
  id: string;
  version: number;
  code: string;
  name: string;
  description: string | null;
  required: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface Supplier {
  id: string;
  version: number;
  supplierType: SupplierType;
  currency: string;
  paymentTermsDays: number;
  paymentMethod: PaymentMethod;
  leadTimeDays: number | null;
  minOrderAmount: string | null;
  incoterm: string | null;
  notes: string | null;
  status: SupplierStatus;
  approvedAt: string | null;
  partner: Partner;
  qualification: Qualification;
  bankAccounts: BankAccount[];
  documents: SupplierDocument[];
  reviews: Review[];
  history: {
    kind: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    at: string;
    by: string | null;
  }[];
  criteria: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    required: boolean;
  }[];
  documentTypes: { id: string; code: string; name: string; required: boolean }[];
  can: {
    manage: boolean;
    submit: boolean;
    decide: boolean;
    suspend: boolean;
    approveBank: boolean;
    seeBank: boolean;
  };
}

export const SUPPLIER_STATUS: Record<SupplierStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Em aprovação',
  APPROVED: 'Homologado',
  REJECTED: 'Recusado',
  SUSPENDED: 'Suspenso',
};
export const SUPPLIER_TYPE: Record<SupplierType, string> = {
  GOODS: 'Bens',
  SERVICES: 'Serviços',
  BOTH: 'Bens e serviços',
};
export const PAYMENT_METHOD: Record<PaymentMethod, string> = {
  TRANSFER: 'Transferência',
  CHEQUE: 'Cheque',
  CASH: 'Numerário',
  OTHER: 'Outro',
};
export const PARTNER_TYPE: Record<Partner['partnerType'], string> = {
  ORGANIZATION: 'Pessoa colectiva',
  INDIVIDUAL: 'Pessoa singular',
};
export const BANK_STATUS: Record<BankAccount['status'], string> = {
  PENDING_APPROVAL: 'Por aprovar',
  ACTIVE: 'Activa',
  REJECTED: 'Recusada',
  INACTIVE: 'Inactiva',
};
export const RESULT: Record<string, string> = {
  MET: 'Cumprido',
  NOT_MET: 'Não cumprido',
  NOT_APPLICABLE: 'Não aplicável',
};
export const EVENT: Record<string, string> = {
  CREATED: 'Criado',
  UPDATED: 'Condições alteradas',
  PARTNER_UPDATED: 'Ficha do terceiro alterada',
  SUBMITTED: 'Homologação pedida',
  APPROVED: 'Homologado',
  REJECTED: 'Homologação recusada',
  SUSPENDED: 'Suspenso',
  DOCUMENT_ADDED: 'Documento entregue',
  DOCUMENT_DEACTIVATED: 'Documento desactivado',
  BANK_ACCOUNT_REQUESTED: 'Conta bancária registada',
  BANK_ACCOUNT_APPROVED: 'Conta bancária aprovada',
  BANK_ACCOUNT_REJECTED: 'Conta bancária recusada',
  BANK_ACCOUNT_DEACTIVATED: 'Conta bancária desactivada',
};

export function supplierTone(s: SupplierStatus): string {
  if (s === 'APPROVED') return 'bg-success-soft text-success-text';
  if (s === 'REJECTED' || s === 'SUSPENDED') return 'bg-danger-soft text-danger-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}
export function bankTone(s: BankAccount['status']): string {
  if (s === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

/** Frase da homologação: o que falta ou caducou, ou até quando vale. */
export function qualificationText(q: Qualification): string {
  if (!q.valid) {
    const parts: string[] = [];
    if (q.missing.length) parts.push(`em falta: ${q.missing.join(', ')}`);
    if (q.expired.length) parts.push(`fora de validade: ${q.expired.join(', ')}`);
    return `Documentos obrigatórios ${parts.join('; ')}.`;
  }
  if (!q.expiresOn) return 'Documentos obrigatórios em dia, sem data de validade.';
  const [y, m, d] = q.expiresOn.split('-');
  return `Documentos obrigatórios em dia até ${d}/${m}/${y}${q.expiring.length ? ` (a caducar: ${q.expiring.join(', ')})` : ''}.`;
}

export interface SupplierForm {
  code: string;
  name: string;
  partnerType: Partner['partnerType'];
  taxId: string;
  countryCode: string;
  email: string;
  phone: string;
  website: string;
  addressLine: string;
  city: string;
  province: string;
  postalCode: string;
  supplierType: SupplierType;
  currency: string;
  paymentTermsDays: string;
  paymentMethod: PaymentMethod;
  leadTimeDays: string;
  minOrderAmount: string;
  incoterm: string;
  notes: string;
}

export const emptySupplierForm = (): SupplierForm => ({
  code: '',
  name: '',
  partnerType: 'ORGANIZATION',
  taxId: '',
  countryCode: 'AO',
  email: '',
  phone: '',
  website: '',
  addressLine: '',
  city: '',
  province: '',
  postalCode: '',
  supplierType: 'GOODS',
  currency: 'AOA',
  paymentTermsDays: '30',
  paymentMethod: 'TRANSFER',
  leadTimeDays: '',
  minOrderAmount: '',
  incoterm: '',
  notes: '',
});

export function formFromSupplier(s: Supplier): SupplierForm {
  const p = s.partner;
  return {
    code: p.code,
    name: p.name,
    partnerType: p.partnerType,
    taxId: p.taxId ?? '',
    countryCode: p.countryCode,
    email: p.email ?? '',
    phone: p.phone ?? '',
    website: p.website ?? '',
    addressLine: p.addressLine ?? '',
    city: p.city ?? '',
    province: p.province ?? '',
    postalCode: p.postalCode ?? '',
    supplierType: s.supplierType,
    currency: s.currency,
    paymentTermsDays: String(s.paymentTermsDays),
    paymentMethod: s.paymentMethod,
    leadTimeDays: s.leadTimeDays === null ? '' : String(s.leadTimeDays),
    minOrderAmount: s.minOrderAmount ?? '',
    incoterm: s.incoterm ?? '',
    notes: s.notes ?? '',
  };
}

const PARTNER_KEYS = [
  'code',
  'name',
  'partnerType',
  'taxId',
  'countryCode',
  'email',
  'phone',
  'website',
  'addressLine',
  'city',
  'province',
  'postalCode',
] as const;

/** Corpo do pedido: terceiro e condições (texto vazio → `null`; números em texto, como a API pede para dinheiro). */
export function supplierPayload(f: SupplierForm) {
  const t = (v: string) => v.trim() || null;
  const partner: Record<string, unknown> = {};
  for (const k of PARTNER_KEYS) partner[k] = k === 'partnerType' ? f[k] : t(f[k]);
  return {
    partner,
    supplierType: f.supplierType,
    currency: f.currency.trim().toUpperCase(),
    paymentTermsDays: Number(f.paymentTermsDays || 0),
    paymentMethod: f.paymentMethod,
    leadTimeDays: f.leadTimeDays.trim() === '' ? null : Number(f.leadTimeDays),
    minOrderAmount: t(f.minOrderAmount.replace(',', '.')),
    incoterm: t(f.incoterm),
    notes: t(f.notes),
  };
}

/** Só o que mudou na ficha do terceiro (para a edição: o NIF de um homologado não se envia se não mudou). */
export function partnerChanges(before: SupplierForm, after: SupplierForm) {
  const all = supplierPayload(after).partner;
  const prev = supplierPayload(before).partner;
  return Object.fromEntries(Object.entries(all).filter(([k, v]) => prev[k] !== v));
}
