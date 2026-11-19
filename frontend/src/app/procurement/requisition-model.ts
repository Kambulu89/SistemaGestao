/** Requisições de compra (9.2): tipos da API, rótulos, cores e cálculo da linha (o mesmo arredondamento do servidor). */

export type RequisitionStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PARTIALLY_ORDERED'
  | 'ORDERED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'CLOSED';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface RequisitionRow {
  id: string;
  version: number;
  number: string | null;
  status: RequisitionStatus;
  priority: Priority;
  neededBy: string;
  purpose: string;
  legalEntity: { id: string; code: string };
  department: { id: string; code: string; name: string };
  requestedBy: string | null;
  currency: string;
  totalAmount: string;
  createdAt: string;
}

export interface RequisitionLine {
  id: string;
  lineNo: number;
  product: { id: string; sku: string } | null;
  variant: { id: string; sku: string } | null;
  description: string;
  uom: { id: string; code: string } | null;
  quantity: string;
  estimatedUnitPrice: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  totalAmount: string;
  neededBy: string | null;
  suggestedSupplier: { id: string; code: string; name: string } | null;
  notes: string | null;
  orderedQuantity: string;
  closedQuantity: string;
  openQuantity: string;
}

export interface Requisition {
  id: string;
  version: number;
  number: string | null;
  status: RequisitionStatus;
  legalEntity: { id: string; code: string };
  department: { id: string; code: string; name: string };
  costCenter: { id: string; code: string; name: string } | null;
  requestedBy: { membershipId: string; name: string | null };
  priority: Priority;
  neededBy: string;
  purpose: string;
  budgetReference: string | null;
  currency: string;
  totalNet: string;
  totalTax: string;
  totalAmount: string;
  totalFunctional: string | null;
  exchangeRate: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  cancelReason: string | null;
  closeReason: string | null;
  copiedFromId: string | null;
  lines: RequisitionLine[];
  approval: {
    sequence: number;
    code: string;
    name: string;
    requiresRole: boolean;
    decision: 'APPROVE' | 'REJECT' | null;
    decidedBy: string | null;
    decidedAt: string | null;
    reason: string | null;
    current: boolean;
  }[];
  history: {
    kind: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    at: string;
    by: string | null;
  }[];
  can: {
    edit: boolean;
    submit: boolean;
    decide: boolean;
    decideBlockedBy: string | null;
    cancel: boolean;
    close: boolean;
    copy: boolean;
  };
}

export interface RequisitionOptions {
  departments: {
    id: string;
    code: string;
    name: string;
    legalEntityId: string;
    legalEntityCode: string;
    currency: string;
    costCenterId: string | null;
  }[];
  costCenters: { id: string; code: string; name: string; legalEntityId: string }[];
  uoms: { id: string; code: string; name: string }[];
  products: { id: string; sku: string; name: string; productType: string; uomId: string }[];
  suppliers: { id: string; code: string; name: string; status: string }[];
}

export interface DemandGroup {
  key: string;
  legalEntity: { id: string; code: string };
  product: { id: string; sku: string } | null;
  description: string;
  uom: string | null;
  currency: string;
  open: string;
  estimatedValue: string;
  neededBy: string;
  priority: Priority;
  lines: { lineId: string; requisitionId: string; number: string; open: string }[];
}

export interface ApprovalLevel {
  id: string;
  version: number;
  code: string;
  name: string;
  sequence: number;
  minAmount: string;
  legalEntity: { id: string; code: string } | null;
  approverRole: { id: string; code: string; name: string } | null;
  status: 'ACTIVE' | 'INACTIVE';
}

export const REQUISITION_STATUS: Record<RequisitionStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Em aprovação',
  APPROVED: 'Aprovada',
  PARTIALLY_ORDERED: 'Parcialmente encomendada',
  ORDERED: 'Encomendada',
  REJECTED: 'Recusada',
  CANCELLED: 'Anulada',
  CLOSED: 'Fechada',
};
export const PRIORITY: Record<Priority, string> = {
  LOW: 'Baixa',
  NORMAL: 'Normal',
  HIGH: 'Alta',
  URGENT: 'Urgente',
};
export const REQ_EVENT: Record<string, string> = {
  CREATED: 'Criada',
  UPDATED: 'Alterada',
  SUBMITTED: 'Aprovação pedida',
  STEP_APPROVED: 'Etapa aprovada',
  REJECTED: 'Recusada',
  CANCELLED: 'Anulada',
  CLOSED: 'Resto fechado',
  ALLOCATED: 'Encomendado',
  RELEASED: 'Encomenda devolvida',
  STATUS: 'Estado',
};
export const BLOCKED_BY: Record<string, string> = {
  SELF_APPROVAL: 'Pediu esta requisição: não a pode aprovar.',
  SAME_APPROVER: 'Já decidiu uma etapa anterior desta requisição.',
  ROLE_REQUIRED: 'A etapa actual exige outro perfil.',
};

export function requisitionTone(s: RequisitionStatus): string {
  if (s === 'APPROVED' || s === 'ORDERED') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_APPROVAL' || s === 'PARTIALLY_ORDERED')
    return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** Decimal em texto → inteiro com `scale` casas (vírgula aceite); `null` se inválido. */
export function scaled(raw: string, scale: number): bigint | null {
  const t = raw.trim().replace(',', '.');
  if (!/^\d{1,14}(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  if (f.length > scale) return null;
  return BigInt(i) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale) || '0');
}
const divRound = (n: bigint, d: bigint) => (n + d / 2n) / d;
const centsText = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

/** Total previsto da linha (líquido + imposto), com o arredondamento do servidor; `null` se algo for inválido. */
export function lineTotal(quantity: string, price: string, taxRate: string): string | null {
  const q = scaled(quantity, 6);
  const p = scaled(price || '0', 6);
  const t = scaled(taxRate || '0', 3);
  if (q === null || p === null || t === null) return null;
  const net = divRound(q * p * 100n, 10n ** 12n);
  const tax = divRound(net * t, 100_000n);
  return centsText(net + tax);
}

export interface LineForm {
  productId: string;
  description: string;
  uomId: string;
  quantity: string;
  estimatedUnitPrice: string;
  taxRate: string;
  neededBy: string;
  suggestedSupplierId: string;
}
export const emptyLine = (): LineForm => ({
  productId: '',
  description: '',
  uomId: '',
  quantity: '1',
  estimatedUnitPrice: '',
  taxRate: '',
  neededBy: '',
  suggestedSupplierId: '',
});

export function linePayload(l: LineForm) {
  const t = (v: string) => v.trim() || null;
  return {
    productId: t(l.productId),
    description: l.description.trim(),
    uomId: t(l.uomId),
    quantity: l.quantity.trim().replace(',', '.'),
    estimatedUnitPrice: (l.estimatedUnitPrice.trim() || '0').replace(',', '.'),
    taxRate: (l.taxRate.trim() || '0').replace(',', '.'),
    neededBy: t(l.neededBy),
    suggestedSupplierId: t(l.suggestedSupplierId),
  };
}
