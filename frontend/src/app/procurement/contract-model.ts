/** Contratos de fornecedor (9.6): tipos da API, rótulos, cores e ajudas do formulário. */
import { scaled } from './requisition-model';
import { plain } from './rfq-model';

export type ContractStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED' | 'TERMINATED' | 'CANCELLED';
export type EffectiveStatus = ContractStatus | 'NOT_STARTED' | 'EXPIRED';
export type SlaMetric = 'DELIVERY_DAYS' | 'FILL_RATE' | 'QUALITY_RATE' | 'RESPONSE_HOURS' | 'OTHER';

export interface ContractRow {
  id: string;
  version: number;
  number: string | null;
  title: string;
  status: ContractStatus;
  effectiveStatus: EffectiveStatus;
  legalEntity: { id: string; code: string };
  supplier: { id: string; code: string; name: string };
  startDate: string;
  endDate: string;
  currency: string;
  maxAmount: string;
  consumedAmount: string;
  renewalDue: boolean;
}

export interface ContractPrice {
  id: string;
  lineNo: number;
  product: { id: string; sku: string } | null;
  variantId: string | null;
  description: string;
  uom: { id: string; code: string } | null;
  unitPrice: string;
  notes: string | null;
}
export interface ContractSla {
  lineNo: number;
  metric: SlaMetric;
  target: string;
  description: string | null;
  penalty: string | null;
}
export interface Amendment {
  id: string;
  version: number;
  amendmentNo: number;
  kind: 'CHANGE' | 'RENEWAL';
  reason: string;
  effectiveDate: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  proposed: {
    header: { endDate: string; maxAmount: string; paymentTermsDays: number | null; title: string };
    prices: unknown[] | null;
    slas: unknown[] | null;
  };
  previous: {
    header: { endDate: string; maxAmount: string; paymentTermsDays: number | null; title: string };
  } | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  canDecide: boolean;
  decideBlockedBy: string | null;
  canCancel: boolean;
}

export interface Contract {
  id: string;
  version: number;
  number: string | null;
  status: ContractStatus;
  effectiveStatus: EffectiveStatus;
  legalEntity: { id: string; code: string };
  supplier: { id: string; code: string; name: string };
  title: string;
  object: string;
  currency: string;
  startDate: string;
  endDate: string;
  maxAmount: string;
  consumedAmount: string;
  remainingAmount: string;
  paymentTermsDays: number | null;
  autoRenew: boolean;
  renewalNoticeDays: number;
  renewalMonths: number | null;
  renewalDue: boolean;
  notes: string | null;
  amendmentCount: number;
  submittedAt: string | null;
  submittedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectReason: string | null;
  suspendReason: string | null;
  terminationReason: string | null;
  cancelReason: string | null;
  prices: ContractPrice[];
  slas: ContractSla[];
  amendments: Amendment[];
  orders: {
    id: string;
    number: string | null;
    approvalStatus: string;
    totalNet: string;
    consumed: string;
  }[];
  history: { kind: string; reason: string | null; at: string; by: string | null }[];
  can: {
    edit: boolean;
    submit: boolean;
    decide: boolean;
    decideBlockedBy: string | null;
    amend: boolean;
    suspend: boolean;
    reactivate: boolean;
    terminate: boolean;
    cancel: boolean;
  };
}

export interface ContractOptions {
  legalEntities: { id: string; code: string; currency: string }[];
  suppliers: {
    id: string;
    code: string;
    name: string;
    currency: string;
    paymentTermsDays: number | null;
  }[];
  uoms: { id: string; code: string; name: string }[];
  products: { id: string; sku: string; name: string; uomId: string }[];
}

export const CONTRACT_STATUS: Record<EffectiveStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Em aprovação',
  ACTIVE: 'Activo',
  REJECTED: 'Recusado',
  SUSPENDED: 'Suspenso',
  TERMINATED: 'Terminado',
  CANCELLED: 'Anulado',
  NOT_STARTED: 'Por iniciar',
  EXPIRED: 'Caducado',
};
export const SLA_METRIC: Record<SlaMetric, string> = {
  DELIVERY_DAYS: 'Prazo de entrega (dias)',
  FILL_RATE: 'Taxa de satisfação (%)',
  QUALITY_RATE: 'Conformidade (%)',
  RESPONSE_HOURS: 'Tempo de resposta (horas)',
  OTHER: 'Outro',
};
export const AMENDMENT_STATUS: Record<Amendment['status'], string> = {
  PENDING: 'Pendente',
  APPROVED: 'Aprovada',
  REJECTED: 'Recusada',
  CANCELLED: 'Anulada',
};
export const CONTRACT_EVENT: Record<string, string> = {
  CREATED: 'Criado',
  UPDATED: 'Alterado',
  SUBMITTED: 'Aprovação pedida',
  APPROVED: 'Aprovado',
  REJECTED: 'Recusado',
  SUSPENDED: 'Suspenso',
  REACTIVATED: 'Reactivado',
  TERMINATED: 'Terminado',
  CANCELLED: 'Anulado',
  AMENDMENT_PROPOSED: 'Adenda proposta',
  RENEWAL_PROPOSED: 'Renovação proposta',
  AMENDED: 'Adenda aplicada',
  RENEWED: 'Renovado',
  AMENDMENT_REJECTED: 'Adenda recusada',
  AMENDMENT_CANCELLED: 'Adenda anulada',
  CONSUMED: 'Consumo de ordem',
  RELEASED: 'Devolução de ordem',
};

export function contractTone(s: EffectiveStatus): string {
  if (s === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_APPROVAL' || s === 'SUSPENDED' || s === 'NOT_STARTED')
    return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED' || s === 'EXPIRED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** Percentagem consumida (0–100, inteira) para a barra. */
export function consumedPct(consumed: string, max: string): number {
  const c = scaled(consumed, 2);
  const m = scaled(max, 2);
  if (c === null || m === null || m === 0n) return 0;
  return Math.min(100, Number((c * 100n) / m));
}

export interface PriceForm {
  productId: string;
  description: string;
  uomId: string;
  unitPrice: string;
}
export interface SlaForm {
  metric: SlaMetric;
  target: string;
  description: string;
  penalty: string;
}
export const emptyPrice = (): PriceForm => ({
  productId: '',
  description: '',
  uomId: '',
  unitPrice: '',
});
export const emptySla = (): SlaForm => ({
  metric: 'DELIVERY_DAYS',
  target: '',
  description: '',
  penalty: '',
});

export const priceForm = (p: ContractPrice): PriceForm => ({
  productId: p.product?.id ?? '',
  description: p.description,
  uomId: p.uom?.id ?? '',
  unitPrice: plain(p.unitPrice),
});
export const slaForm = (s: ContractSla): SlaForm => ({
  metric: s.metric,
  target: plain(s.target),
  description: s.description ?? '',
  penalty: s.penalty ?? '',
});

export function pricePayload(p: PriceForm) {
  const t = (v: string) => v.trim() || null;
  return {
    productId: t(p.productId),
    description: p.description.trim(),
    uomId: t(p.uomId),
    unitPrice: p.unitPrice.trim().replace(',', '.'),
  };
}
export function slaPayload(s: SlaForm) {
  const t = (v: string) => v.trim() || null;
  return {
    metric: s.metric,
    target: s.target.trim().replace(',', '.'),
    description: t(s.description),
    penalty: t(s.penalty),
  };
}
