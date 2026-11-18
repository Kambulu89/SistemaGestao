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
  };
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
