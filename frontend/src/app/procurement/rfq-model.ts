/** Pedidos de cotação (9.3): tipos da API, rótulos, cores e ajudas do formulário de proposta. */
import { lineTotal, scaled } from './requisition-model';

export type RfqStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'AWARDED' | 'CANCELLED';
export type InvitationStatus = 'INVITED' | 'RESPONDED' | 'DECLINED';
export type QuoteStatus = 'ACTIVE' | 'SUPERSEDED' | 'WITHDRAWN';

export interface RfqRow {
  id: string;
  version: number;
  number: string | null;
  status: RfqStatus;
  title: string;
  legalEntity: { id: string; code: string };
  closesAt: string;
  sealed: boolean;
  revision: number;
  invited: number;
  quotes: number;
  createdAt: string;
}

export interface RfqLine {
  id: string;
  version: number;
  lineNo: number;
  product: { id: string; sku: string } | null;
  description: string;
  uom: { id: string; code: string } | null;
  quantity: string;
  specifications: string | null;
  neededBy: string | null;
  requisition: { id: string; number: string; lineId: string } | null;
}

export interface QuoteLine {
  id: string;
  rfqLineId: string;
  lineNo: number;
  alternativeNo: number;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  totalAmount: string;
  deliveryDays: number | null;
  notes: string | null;
}

export interface Quote {
  id: string;
  version: number;
  supplier: { id: string; code: string; name: string };
  quoteVersion: number;
  rfqRevision: number;
  outdated: boolean;
  status: QuoteStatus;
  withdrawReason: string | null;
  receivedAt: string;
  receivedBy: string | null;
  supplierReference: string | null;
  currency: string | null;
  validUntil: string | null;
  deliveryDays: number | null;
  paymentTermsDays: number | null;
  notes: string | null;
  totalNet: string | null;
  totalTax: string | null;
  totalAmount: string | null;
  attachment: { id: string; fileName: string } | null;
  lines: QuoteLine[];
}

export interface Rfq {
  id: string;
  version: number;
  number: string | null;
  status: RfqStatus;
  legalEntity: { id: string; code: string };
  title: string;
  specifications: string | null;
  closesAt: string;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  currency: string;
  sealed: boolean;
  pricesHidden: boolean;
  revision: number;
  issuedAt: string | null;
  openedAt: string | null;
  cancelReason: string | null;
  lines: RfqLine[];
  invitations: {
    id: string;
    version: number;
    supplier: { id: string; code: string; name: string };
    status: InvitationStatus;
    declineReason: string | null;
  }[];
  quotes: Quote[];
  history: {
    kind: string;
    revision: number | null;
    reason: string | null;
    details: Record<string, unknown> | null;
    at: string;
    by: string | null;
  }[];
  can: {
    edit: boolean;
    invite: boolean;
    issue: boolean;
    amend: boolean;
    quote: boolean;
    open: boolean;
    cancel: boolean;
    award: boolean;
  };
  awards: {
    id: string;
    status: AwardStatus;
    totalBase: string;
    baseCurrency: string;
    submittedBy: string | null;
    createdAt: string;
  }[];
}

export interface RfqOptions {
  legalEntities: { id: string; code: string; currency: string }[];
  suppliers: { id: string; code: string; name: string }[];
  uoms: { id: string; code: string; name: string }[];
  products: { id: string; sku: string; name: string; uomId: string }[];
}

export const RFQ_STATUS: Record<RfqStatus, string> = {
  DRAFT: 'Rascunho',
  OPEN: 'Aberto a propostas',
  CLOSED: 'Propostas abertas',
  AWARDED: 'Adjudicado',
  CANCELLED: 'Anulado',
};
export const INVITATION_STATUS: Record<InvitationStatus, string> = {
  INVITED: 'Convidado',
  RESPONDED: 'Respondeu',
  DECLINED: 'Declinou',
};
export const QUOTE_STATUS: Record<QuoteStatus, string> = {
  ACTIVE: 'Em vigor',
  SUPERSEDED: 'Substituída',
  WITHDRAWN: 'Retirada',
};
export const RFQ_EVENT: Record<string, string> = {
  CREATED: 'Criado',
  UPDATED: 'Alterado',
  INVITED: 'Fornecedores convidados',
  UNINVITED: 'Convite retirado',
  ISSUED: 'Emitido',
  AMENDED: 'Revisto',
  DECLINED: 'Convite declinado',
  QUOTE_RECEIVED: 'Proposta registada',
  QUOTE_WITHDRAWN: 'Proposta retirada',
  OPENED: 'Propostas abertas',
  CANCELLED: 'Anulado',
  AWARD_DRAFTED: 'Adjudicação preparada',
  AWARD_SUBMITTED: 'Adjudicação submetida',
  AWARD_REJECTED: 'Adjudicação recusada',
  AWARD_CANCELLED: 'Adjudicação anulada',
  AWARDED: 'Adjudicado',
};

export function rfqTone(s: RfqStatus): string {
  if (s === 'OPEN') return 'bg-warning-soft text-warning-text';
  if (s === 'CLOSED' || s === 'AWARDED') return 'bg-success-soft text-success-text';
  return 'bg-surface-2 text-muted';
}
export function invitationTone(s: InvitationStatus): string {
  if (s === 'RESPONDED') return 'bg-success-soft text-success-text';
  if (s === 'DECLINED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** `datetime-local` (hora local, sem fuso) → ISO; `null` se vazio ou inválido. */
export function localToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** ISO → valor de `datetime-local` na hora local. */
export function isoToLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface QuoteLineForm {
  rfqLineId: string;
  alternativeNo: number;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  deliveryDays: string;
}

/** Decimal da API sem zeros à direita ("10.500000" → "10.5"; "10" fica "10"). */
export const plain = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/** Uma linha de proposta por linha do pedido (oferta principal, com a quantidade pedida). */
export const quoteForm = (lines: RfqLine[]): QuoteLineForm[] =>
  lines.map((l) => ({
    rfqLineId: l.id,
    alternativeNo: 0,
    description: '',
    quantity: plain(l.quantity),
    unitPrice: '',
    taxRate: '',
    deliveryDays: '',
  }));

/** Alternativa seguinte para a mesma linha (número livre mais baixo de 1 a 9); `null` se já há nove. */
export function nextAlternative(rows: QuoteLineForm[], rfqLineId: string): number | null {
  const used = new Set(rows.filter((r) => r.rfqLineId === rfqLineId).map((r) => r.alternativeNo));
  for (let n = 1; n <= 9; n++) if (!used.has(n)) return n;
  return null;
}

/** Total da proposta (só as ofertas principais), com o arredondamento do servidor; `null` se algo for inválido. */
export function quoteTotal(rows: QuoteLineForm[]): string | null {
  let sum = 0n;
  for (const r of rows) {
    if (r.alternativeNo !== 0) continue;
    const t = lineTotal(r.quantity, r.unitPrice || 'x', r.taxRate);
    if (t === null) return null;
    sum += scaled(t, 2)!;
  }
  return `${sum / 100n}.${(sum % 100n).toString().padStart(2, '0')}`;
}

export function quotePayload(rows: QuoteLineForm[]) {
  const n = (v: string) => v.trim().replace(',', '.');
  return rows.map((r) => ({
    rfqLineId: r.rfqLineId,
    alternativeNo: r.alternativeNo,
    description: r.description.trim() || null,
    quantity: n(r.quantity),
    unitPrice: n(r.unitPrice),
    taxRate: n(r.taxRate) || '0',
    deliveryDays: r.deliveryDays.trim() === '' ? null : Number(r.deliveryDays),
  }));
}

// ---------- Comparação e adjudicação (9.4) ----------

export type AwardStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export interface Weights {
  price: number;
  delivery: number;
  quality: number;
  payment: number;
}
export const WEIGHT_LABELS: [keyof Weights, string][] = [
  ['price', 'Preço'],
  ['delivery', 'Prazo de entrega'],
  ['quality', 'Qualidade'],
  ['payment', 'Prazo de pagamento'],
];
export interface OfferScore {
  price: number;
  delivery: number;
  quality: number;
  payment: number;
  total: number;
  best: boolean;
}
export interface ComparisonOffer {
  quoteLineId: string;
  quoteId: string;
  supplier: { id: string; code: string };
  alternativeNo: number;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  currency: string;
  unitPriceBase: string | null;
  totalBase: string | null;
  deliveryDays: number | null;
  expired: boolean;
  score: OfferScore | null;
}
export interface Comparison {
  rfq: { id: string; number: string; title: string; status: RfqStatus };
  baseCurrency: string;
  rateDate: string;
  rates: { currency: string; rate: string | null }[];
  weights: Weights;
  quality: Record<string, number>;
  suppliers: {
    supplier: { id: string; code: string; name: string };
    quoteId: string;
    quoteVersion: number;
    outdated: boolean;
    currency: string;
    rate: string | null;
    validUntil: string | null;
    expired: boolean;
    deliveryDays: number | null;
    paymentTermsDays: number | null;
    quality: number | null;
    linesQuoted: number;
    totalAmount: string;
    totalBase: string | null;
    bestLines: number;
  }[];
  lines: {
    id: string;
    lineNo: number;
    description: string;
    uom: string | null;
    quantity: string;
    offers: ComparisonOffer[];
  }[];
}
export interface Award {
  id: string;
  version: number;
  status: AwardStatus;
  rfq: { id: string; number: string; title: string; status: RfqStatus };
  weights: Weights;
  quality: Record<string, number>;
  baseCurrency: string;
  rateDate: string;
  justification: string;
  totalNetBase: string;
  totalBase: string;
  createdBy: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  cancelReason: string | null;
  lines: {
    id: string;
    rfqLineId: string;
    lineNo: number;
    description: string;
    uom: string | null;
    quoteId: string;
    quoteLineId: string;
    supplier: { id: string; code: string; name: string };
    alternativeNo: number;
    offerDescription: string | null;
    quantity: string;
    unitPrice: string;
    currency: string;
    rate: string;
    unitPriceBase: string;
    netBase: string;
    totalBase: string;
    score: number;
    best: boolean;
    reason: string | null;
  }[];
  bySupplier: {
    supplier: { id: string; code: string; name: string };
    lines: number;
    netBase: string;
    totalBase: string;
  }[];
  can: {
    edit: boolean;
    submit: boolean;
    decide: boolean;
    decideBlockedBy: string | null;
    cancel: boolean;
  };
}

export const AWARD_STATUS: Record<AwardStatus, string> = {
  DRAFT: 'Em preparação',
  PENDING_APPROVAL: 'Em aprovação',
  APPROVED: 'Aprovada',
  REJECTED: 'Recusada',
  CANCELLED: 'Anulada',
};
export function awardTone(s: AwardStatus): string {
  if (s === 'APPROVED') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

export const weightSum = (w: Weights) => w.price + w.delivery + w.quality + w.payment;

/** Escolha por oferta: quantidade a adjudicar (vazia = não) e motivo. */
export type Picks = Record<string, { quantity: string; reason: string }>;

/** O menor de dois decimais em texto (até 6 casas). */
function minDecimal(a: string, b: string): string {
  const x = scaled(a, 6);
  const y = scaled(b, 6);
  if (x === null || y === null) return a;
  return x <= y ? a : b;
}

/** Sugestão: a melhor oferta de cada linha, com a quantidade pedida (ou a oferecida, se menor). */
export function suggestBest(c: Comparison): Picks {
  const out: Picks = {};
  for (const l of c.lines) {
    const best = l.offers.find((o) => o.score?.best && !o.expired);
    if (best)
      out[best.quoteLineId] = {
        quantity: plain(minDecimal(l.quantity, best.quantity)),
        reason: '',
      };
  }
  return out;
}

/** Linhas para a API: só as ofertas com quantidade indicada. */
export function picksPayload(picks: Picks) {
  return Object.entries(picks)
    .filter(([, p]) => p.quantity.trim() !== '')
    .map(([quoteLineId, p]) => ({
      quoteLineId,
      quantity: p.quantity.trim().replace(',', '.'),
      reason: p.reason.trim() || null,
    }));
}
