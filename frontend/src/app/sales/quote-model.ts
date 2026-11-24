/** Orçamentos e propostas (10.3): tipos, rótulos e conversões do formulário. */

export type QuoteStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'CONVERTED';

export interface QuoteRow {
  id: string;
  number: string | null;
  versionNo: number;
  customer: { code: string; name: string };
  legalEntity: string;
  quoteDate: string;
  validUntil: string;
  currency: string;
  grossTotal: string;
  status: QuoteStatus;
  expired: boolean;
}

export interface QuoteLine {
  id: string;
  lineNo: number;
  product: { id: string; sku: string };
  variant: { id: string; sku: string } | null;
  description: string;
  quantity: string;
  manualDiscountPct: string | null;
  manualUnitPrice: string | null;
  taxRate: string;
  taxExemptionReason: string | null;
  priceSource: 'LIST' | 'CATALOG' | 'MANUAL' | 'NONE';
  basePrice: string | null;
  netUnitPrice: string | null;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  requiresApproval: boolean;
  pricing: {
    priceListCode?: string | null;
    ruleCode?: string | null;
    rulePct?: string;
    manualDiscountPct?: string;
    limitPct?: string;
    reasons?: string[];
  };
}

export interface Quote {
  id: string;
  version: number;
  number: string | null;
  versionNo: number;
  status: QuoteStatus;
  expired: boolean;
  legalEntity: { id: string; code: string; name: string };
  customer: { id: string; code: string; name: string; status: string };
  salesperson: { membershipId: string; name: string };
  series: { id: string; code: string } | null;
  quoteDate: string;
  validUntil: string;
  currency: string;
  paymentTermsDays: number;
  customerReference: string | null;
  notes: string | null;
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  requiresApproval: boolean;
  sentAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  convertedOrderId: string | null;
  lines: QuoteLine[];
  versions: {
    versionNo: number;
    hash: string;
    channel: string;
    sentTo: string | null;
    at: string;
    by: string | null;
    customerVersionNo: number;
  }[];
  history: {
    kind: string;
    versionNo: number;
    to: string | null;
    reason: string | null;
    details: Record<string, unknown> | null;
    at: string;
    by: string | null;
  }[];
  can: Record<
    'edit' | 'submit' | 'approve' | 'reject' | 'send' | 'accept' | 'decline' | 'revise' | 'cancel',
    boolean
  >;
}

export interface QuoteOptions {
  legalEntities: { id: string; code: string; name: string }[];
  salespeople: { membershipId: string; name: string }[];
  series: { id: string; code: string; prefix: string; legalEntityId: string }[];
  me: string;
  ownOnly: boolean;
}

export const QUOTE_STATUS: Record<QuoteStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Para aprovação',
  APPROVED: 'Aprovado',
  SENT: 'Enviado',
  ACCEPTED: 'Aceite',
  DECLINED: 'Recusado',
  CANCELLED: 'Anulado',
  CONVERTED: 'Convertido em encomenda',
};
export const SEND_CHANNEL: Record<string, string> = {
  EMAIL: 'E-mail',
  HAND: 'Em mão',
  PORTAL: 'Portal',
  OTHER: 'Outro',
};
export const QUOTE_EVENT: Record<string, string> = {
  CREATED: 'Criado',
  SUBMITTED: 'Submetido',
  APPROVED: 'Aprovado',
  REJECTED: 'Devolvido',
  SENT: 'Enviado',
  ACCEPTED: 'Aceite pelo cliente',
  DECLINED: 'Recusado pelo cliente',
  REVISED: 'Revisto',
  CANCELLED: 'Anulado',
  CONVERTED: 'Convertido em encomenda',
};

/** Estado para mostrar: um enviado fora de validade aparece como expirado. */
export function quoteStatusLabel(q: { status: QuoteStatus; expired: boolean }): string {
  return q.expired ? 'Expirado' : QUOTE_STATUS[q.status];
}

export function quoteTone(q: { status: QuoteStatus; expired: boolean }): string {
  if (q.expired || q.status === 'DECLINED' || q.status === 'CANCELLED')
    return q.status === 'CANCELLED' ? 'bg-surface-2 text-muted' : 'bg-danger-soft text-danger-text';
  if (q.status === 'ACCEPTED' || q.status === 'CONVERTED')
    return 'bg-success-soft text-success-text';
  if (q.status === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  if (q.status === 'SENT' || q.status === 'APPROVED') return 'bg-primary-soft text-on-primary-soft';
  return 'bg-surface-2 text-muted';
}

export interface LineForm {
  key: number;
  productId: string;
  productLabel: string;
  description: string;
  quantity: string;
  manualDiscountPct: string;
  manualUnitPrice: string;
  taxRate: string;
  taxExemptionReason: string;
}

export interface QuoteForm {
  legalEntityId: string;
  customerId: string;
  customerLabel: string;
  salespersonMembershipId: string;
  quoteDate: string;
  validUntil: string;
  currency: string;
  paymentTermsDays: string;
  customerReference: string;
  notes: string;
  lines: LineForm[];
}

let seq = 0;
export function emptyLine(): LineForm {
  return {
    key: ++seq,
    productId: '',
    productLabel: '',
    description: '',
    quantity: '1',
    manualDiscountPct: '',
    manualUnitPrice: '',
    taxRate: '',
    taxExemptionReason: '',
  };
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function emptyQuoteForm(today: string): QuoteForm {
  return {
    legalEntityId: '',
    customerId: '',
    customerLabel: '',
    salespersonMembershipId: '',
    quoteDate: today,
    validUntil: addDays(today, 30),
    currency: '',
    paymentTermsDays: '',
    customerReference: '',
    notes: '',
    lines: [emptyLine()],
  };
}

const plain = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

export function formFromQuote(q: Quote): QuoteForm {
  return {
    legalEntityId: q.legalEntity.id,
    customerId: q.customer.id,
    customerLabel: `${q.customer.code} — ${q.customer.name}`,
    salespersonMembershipId: q.salesperson.membershipId,
    quoteDate: q.quoteDate,
    validUntil: q.validUntil,
    currency: q.currency,
    paymentTermsDays: String(q.paymentTermsDays),
    customerReference: q.customerReference ?? '',
    notes: q.notes ?? '',
    lines: q.lines.map((l) => ({
      key: ++seq,
      productId: l.product.id,
      productLabel: `${l.product.sku} — ${l.description}`,
      description: l.description,
      quantity: plain(l.quantity),
      manualDiscountPct: l.manualDiscountPct === null ? '' : plain(l.manualDiscountPct),
      manualUnitPrice: l.manualUnitPrice === null ? '' : plain(l.manualUnitPrice),
      taxRate: plain(l.taxRate),
      taxExemptionReason: l.taxExemptionReason ?? '',
    })),
  };
}

const nz = (v: string) => (v.trim() === '' ? null : v.trim());

/** Corpo do pedido: vazios como null; a entidade só ao criar; moeda e prazo vazios = os do cliente. */
export function quotePayload(f: QuoteForm, creating: boolean) {
  return {
    ...(creating ? { legalEntityId: f.legalEntityId } : {}),
    customerId: f.customerId,
    salespersonMembershipId: nz(f.salespersonMembershipId),
    quoteDate: f.quoteDate,
    validUntil: f.validUntil,
    ...(nz(f.currency) ? { currency: f.currency.trim().toUpperCase() } : {}),
    ...(nz(f.paymentTermsDays) ? { paymentTermsDays: Number(f.paymentTermsDays) } : {}),
    customerReference: nz(f.customerReference),
    notes: nz(f.notes),
    lines: f.lines.map((l) => ({
      productId: l.productId,
      description: nz(l.description),
      quantity: l.quantity.trim().replace(',', '.'),
      manualDiscountPct: nz(l.manualDiscountPct)?.replace(',', '.') ?? null,
      manualUnitPrice: nz(l.manualUnitPrice)?.replace(',', '.') ?? null,
      taxRate: l.taxRate.trim().replace(',', '.'),
      taxExemptionReason: nz(l.taxExemptionReason),
    })),
  };
}

/** Taxa zero (com ou sem casas decimais). */
export const zeroRate = (v: string) => /^0+([.,]0*)?$/.test(v.trim());
