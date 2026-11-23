/** Clientes (10.1): tipos da API, rótulos, formulário e corpo para a API. */
export type CustomerStatus = 'ACTIVE' | 'BLOCKED' | 'INACTIVE';
export type AddressKind = 'BILLING' | 'DELIVERY';
export type PartnerType = 'ORGANIZATION' | 'INDIVIDUAL';

export interface Partner {
  id: string;
  version: number;
  code: string;
  name: string;
  partnerType: PartnerType;
  taxId: string | null;
  countryCode: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  status: string;
  contacts: {
    id: string;
    version: number;
    name: string;
    role: string | null;
    email: string | null;
    phone: string | null;
    isPrimary: boolean;
    status: string;
  }[];
}

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  countryCode: string;
  partnerType: PartnerType;
  currency: string;
  paymentTermsDays: number;
  creditLimit: string | null;
  segment: string | null;
  status: CustomerStatus;
}

export interface CustomerAddress {
  id: string;
  version: number;
  kind: AddressKind;
  label: string;
  addressLine: string;
  city: string | null;
  municipality: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string;
  isDefault: boolean;
  status: string;
}

export interface CustomerVersionData {
  code: string;
  name: string;
  partnerType: string;
  taxId: string | null;
  countryCode: string;
  email: string | null;
  billingAddress: {
    addressLine: string | null;
    city: string | null;
    municipality: string | null;
    province: string | null;
    postalCode: string | null;
    countryCode: string;
  };
}

export interface Customer {
  id: string;
  version: number;
  status: CustomerStatus;
  statusReason: string | null;
  partner: Partner;
  currency: string;
  paymentTermsDays: number;
  creditLimit: string | null;
  segment: { id: string; code: string; name: string } | null;
  notes: string | null;
  alsoSupplier: boolean;
  addresses: CustomerAddress[];
  versions: {
    id: string;
    versionNo: number;
    data: CustomerVersionData;
    at: string;
    by: string | null;
  }[];
  history: {
    kind: string;
    from: string | null;
    to: string | null;
    reason: string | null;
    details: Record<string, unknown> | null;
    at: string;
    by: string | null;
  }[];
  can: { manage: boolean; credit: boolean };
}

export interface Segment {
  id: string;
  version: number;
  code: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  customers: number;
}

export const CUSTOMER_STATUS: Record<CustomerStatus, string> = {
  ACTIVE: 'Activo',
  BLOCKED: 'Bloqueado',
  INACTIVE: 'Inactivo',
};
export const ADDRESS_KIND: Record<AddressKind, string> = {
  BILLING: 'Facturação',
  DELIVERY: 'Entrega',
};
export const PARTNER_TYPE: Record<PartnerType, string> = {
  ORGANIZATION: 'Pessoa colectiva',
  INDIVIDUAL: 'Pessoa singular',
};
export const CUSTOMER_EVENT: Record<string, string> = {
  CREATED: 'Criado',
  UPDATED: 'Condições alteradas',
  PARTNER_UPDATED: 'Ficha do terceiro alterada',
  VERSION: 'Nova versão dos dados fiscais',
  CREDIT_LIMIT: 'Limite de crédito alterado',
  STATUS: 'Estado alterado',
  ADDRESS_ADDED: 'Morada acrescentada',
  ADDRESS_UPDATED: 'Morada alterada',
  CONTACT_ADDED: 'Contacto acrescentado',
  CONTACT_UPDATED: 'Contacto alterado',
};

export function customerTone(s: CustomerStatus): string {
  if (s === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (s === 'BLOCKED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

export interface CustomerForm {
  code: string;
  name: string;
  partnerType: PartnerType;
  taxId: string;
  countryCode: string;
  email: string;
  phone: string;
  addressLine: string;
  city: string;
  province: string;
  postalCode: string;
  currency: string;
  paymentTermsDays: string;
  segmentId: string;
  notes: string;
}

export const emptyCustomerForm = (): CustomerForm => ({
  code: '',
  name: '',
  partnerType: 'ORGANIZATION',
  taxId: '',
  countryCode: 'AO',
  email: '',
  phone: '',
  addressLine: '',
  city: '',
  province: '',
  postalCode: '',
  currency: 'AOA',
  paymentTermsDays: '0',
  segmentId: '',
  notes: '',
});

export function formFromCustomer(c: Customer): CustomerForm {
  const p = c.partner;
  return {
    code: p.code,
    name: p.name,
    partnerType: p.partnerType,
    taxId: p.taxId ?? '',
    countryCode: p.countryCode,
    email: p.email ?? '',
    phone: p.phone ?? '',
    addressLine: p.addressLine ?? '',
    city: p.city ?? '',
    province: p.province ?? '',
    postalCode: p.postalCode ?? '',
    currency: c.currency,
    paymentTermsDays: String(c.paymentTermsDays),
    segmentId: c.segment?.id ?? '',
    notes: c.notes ?? '',
  };
}

const t = (v: string) => v.trim();
const opt = (v: string) => (t(v) === '' ? null : t(v));

/** Corpo para criar: ficha do terceiro e condições de venda. */
export function customerPayload(f: CustomerForm) {
  return {
    currency: t(f.currency).toUpperCase(),
    paymentTermsDays: Number(f.paymentTermsDays || 0),
    segmentId: f.segmentId || null,
    notes: opt(f.notes),
    partner: {
      code: t(f.code),
      name: t(f.name),
      partnerType: f.partnerType,
      taxId: opt(f.taxId),
      countryCode: t(f.countryCode).toUpperCase(),
      email: opt(f.email),
      phone: opt(f.phone),
      addressLine: opt(f.addressLine),
      city: opt(f.city),
      province: opt(f.province),
      postalCode: opt(f.postalCode),
    },
  };
}

/** Só os campos do terceiro que mudaram (para a edição). */
export function partnerChanges(before: CustomerForm, after: CustomerForm) {
  const a = customerPayload(after).partner as Record<string, unknown>;
  const b = customerPayload(before).partner as Record<string, unknown>;
  return Object.fromEntries(Object.entries(a).filter(([k, v]) => b[k] !== v));
}

/** Morada numa linha (para listas e versões). */
export function addressLine(a: {
  addressLine: string | null;
  city?: string | null;
  municipality?: string | null;
  province?: string | null;
  postalCode?: string | null;
  countryCode: string;
}): string {
  return [a.addressLine, a.municipality, a.city, a.province, a.postalCode, a.countryCode]
    .filter((x) => x)
    .join(', ');
}
