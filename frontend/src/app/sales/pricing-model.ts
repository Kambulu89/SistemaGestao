/** Preços e descontos (10.2): tipos, rótulos e conversões dos formulários. */

export type PricingStatus = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'INACTIVE';
export type ListTarget = 'GENERAL' | 'SEGMENT' | 'CUSTOMER';
export type RuleTarget = 'ALL' | 'SEGMENT' | 'CUSTOMER';

interface Ref {
  id: string;
  code: string;
  name: string;
}

export interface PricingCan {
  edit: boolean;
  submit: boolean;
  approve: boolean;
  reject: boolean;
  deactivate: boolean;
  copy: boolean;
}

export interface PricingEvent {
  kind: string;
  reason: string | null;
  at: string;
  by: string | null;
}

export interface PriceListRow {
  id: string;
  code: string;
  name: string;
  currency: string;
  targetType: ListTarget;
  segment: Ref | null;
  customer: Ref | null;
  validFrom: string;
  validTo: string | null;
  priority: number;
  status: PricingStatus;
  lines: number;
}

export interface PriceLine {
  id: string;
  version: number;
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  minQuantity: string;
  unitPrice: string;
  maxDiscountPct: string | null;
}

export interface PriceList extends Omit<PriceListRow, 'lines'> {
  version: number;
  legalEntity: { id: string; code: string } | null;
  notes: string | null;
  copiedFrom: { id: string; code: string } | null;
  submittedAt: string | null;
  approvedAt: string | null;
  inactiveReason: string | null;
  can: PricingCan;
  lines: PriceLine[];
  history: PricingEvent[];
}

export interface DiscountRule {
  id: string;
  version: number;
  code: string;
  name: string;
  targetType: RuleTarget;
  segment: Ref | null;
  customer: Ref | null;
  product: { id: string; sku: string; name: string } | null;
  category: Ref | null;
  minQuantity: string;
  discountPct: string;
  validFrom: string;
  validTo: string | null;
  priority: number;
  status: PricingStatus;
  notes?: string | null;
  inactiveReason?: string | null;
  can?: PricingCan;
  history?: PricingEvent[];
}

export interface DiscountLimit {
  id: string;
  targetType: ListTarget;
  segment: Ref | null;
  customer: Ref | null;
  maxPct: string;
}

export interface PricingOptions {
  segments: Ref[];
  legalEntities: Ref[];
  categories: Ref[];
  can: { manage: boolean; approve: boolean };
}

export interface ProductHit {
  id: string;
  sku: string;
  name: string;
  currency: string | null;
  salePrice: string | null;
  variants: { id: string; sku: string }[];
}

export interface ResolvedLine {
  index: number;
  productId: string;
  sku: string;
  name: string;
  variantSku: string | null;
  quantity: string;
  source: 'LIST' | 'CATALOG' | 'MANUAL' | 'NONE';
  priceListCode: string | null;
  tierMinQuantity: string | null;
  basePrice: string | null;
  ruleCode: string | null;
  rulePct: string;
  manualDiscountPct: string;
  limitPct: string;
  limitSource: 'CUSTOMER' | 'SEGMENT' | 'GENERAL' | 'LINE' | 'NONE';
  netUnitPrice: string | null;
  netAmount: string | null;
  requiresApproval: boolean;
  reasons: string[];
}

export interface PriceSnapshot {
  customer: { id: string; code: string; name: string; status: string };
  currency: string;
  date: string;
  lines: ResolvedLine[];
  requiresApproval: boolean;
  missingPrices: boolean;
  hash: string;
  resolvedAt: string;
}

export const PRICING_STATUS: Record<PricingStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING: 'Para aprovação',
  ACTIVE: 'Activa',
  INACTIVE: 'Inactiva',
};
export const LIST_TARGET: Record<ListTarget, string> = {
  GENERAL: 'Geral',
  SEGMENT: 'Segmento',
  CUSTOMER: 'Cliente',
};
export const RULE_TARGET: Record<RuleTarget, string> = {
  ALL: 'Todos os clientes',
  SEGMENT: 'Segmento',
  CUSTOMER: 'Cliente',
};
export const PRICE_SOURCE: Record<ResolvedLine['source'], string> = {
  LIST: 'Tabela',
  CATALOG: 'Catálogo',
  MANUAL: 'Manual',
  NONE: 'Sem preço',
};
export const LIMIT_SOURCE: Record<ResolvedLine['limitSource'], string> = {
  CUSTOMER: 'do cliente',
  SEGMENT: 'do segmento',
  GENERAL: 'geral',
  LINE: 'da linha da tabela',
  NONE: 'sem limite configurado',
};
export const PRICING_EVENT: Record<string, string> = {
  CREATED: 'Criada',
  COPIED: 'Criada por cópia',
  SUBMITTED: 'Submetida para aprovação',
  APPROVED: 'Aprovada e activa',
  REJECTED: 'Devolvida',
  DEACTIVATED: 'Inactivada',
};
export const REASON: Record<string, string> = {
  DISCOUNT_OVER_LIMIT: 'Desconto acima do limite',
  MANUAL_PRICE: 'Preço manual sem tabela',
  NO_PRICE: 'Sem preço',
};

export function pricingTone(s: PricingStatus): string {
  if (s === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (s === 'PENDING') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

/** Destino legível (geral, segmento X ou cliente Y). */
export function targetLabel(t: {
  targetType: string;
  segment: Ref | null;
  customer: Ref | null;
}): string {
  if (t.segment) return `Segmento ${t.segment.code}`;
  if (t.customer) return `Cliente ${t.customer.code} — ${t.customer.name}`;
  return t.targetType === 'ALL' ? 'Todos os clientes' : 'Geral';
}

export const period = (from: string, to: string | null) =>
  to ? `${from} a ${to}` : `desde ${from}`;

/** Percentagem para mostrar ("5.00" → "5 %", "2.50" → "2,5 %"). */
export function percent(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
  return `${s.replace('.', ',')} %`;
}

/** Quantidade para mostrar, sem zeros à direita. */
export function qty(v: string): string {
  const s = v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
  return s.replace('.', ',');
}

/** Preço com 4 casas para mostrar (até 2 casas, ou mais se forem significativas). */
export function price(v: string | null | undefined, currency?: string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const [i, f = ''] = v.split('.');
  const frac = f.replace(/0+$/, '');
  const shown = frac.length <= 2 ? (frac + '00').slice(0, 2) : frac;
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${shown}${currency ? ' ' + currency : ''}`;
}

export interface ListForm {
  code: string;
  name: string;
  currency: string;
  targetType: ListTarget;
  segmentId: string;
  customerId: string;
  customerLabel: string;
  legalEntityId: string;
  validFrom: string;
  validTo: string;
  priority: string;
  notes: string;
}

export function emptyListForm(today: string): ListForm {
  return {
    code: '',
    name: '',
    currency: 'AOA',
    targetType: 'GENERAL',
    segmentId: '',
    customerId: '',
    customerLabel: '',
    legalEntityId: '',
    validFrom: today,
    validTo: '',
    priority: '100',
    notes: '',
  };
}

export function formFromList(l: PriceList): ListForm {
  return {
    code: l.code,
    name: l.name,
    currency: l.currency,
    targetType: l.targetType,
    segmentId: l.segment?.id ?? '',
    customerId: l.customer?.id ?? '',
    customerLabel: l.customer ? `${l.customer.code} — ${l.customer.name}` : '',
    legalEntityId: l.legalEntity?.id ?? '',
    validFrom: l.validFrom,
    validTo: l.validTo ?? '',
    priority: String(l.priority),
    notes: l.notes ?? '',
  };
}

const nz = (v: string) => (v.trim() === '' ? null : v.trim());

/** Corpo do pedido (o código só vai ao criar). */
export function listPayload(f: ListForm, creating: boolean) {
  return {
    ...(creating ? { code: f.code.trim() } : {}),
    name: f.name.trim(),
    currency: f.currency.trim().toUpperCase(),
    targetType: f.targetType,
    segmentId: f.targetType === 'SEGMENT' ? nz(f.segmentId) : null,
    customerId: f.targetType === 'CUSTOMER' ? nz(f.customerId) : null,
    legalEntityId: nz(f.legalEntityId),
    validFrom: f.validFrom,
    validTo: nz(f.validTo),
    priority: Number(f.priority),
    notes: nz(f.notes),
  };
}

/** Âmbito legível da regra (produto, categoria ou tudo, e quantidade mínima). */
export function ruleScope(r: Pick<DiscountRule, 'product' | 'category' | 'minQuantity'>): string {
  const what = r.product
    ? `Produto ${r.product.sku}`
    : r.category
      ? `Categoria ${r.category.code}`
      : 'Todos os produtos';
  return /^0(\.0*)?$/.test(r.minQuantity) ? what : `${what} · a partir de ${qty(r.minQuantity)}`;
}
