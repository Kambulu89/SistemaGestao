/** Devoluções a fornecedor e não conformidades (9.9): tipos da API, rótulos, cores e formulário. */
import { scaled } from './requisition-model';
import { plain } from './rfq-model';

export type ReturnStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
export type CreditStatus = 'NOT_REQUIRED' | 'PENDING' | 'CREDITED';
export type ReturnReason =
  'QUALITY' | 'DAMAGED' | 'WRONG_ITEM' | 'EXPIRED' | 'QUANTITY' | 'DOCUMENTATION' | 'OTHER';
export type Remedy = 'REPLACEMENT' | 'CREDIT';
export type ReturnSource = 'ACCEPTED' | 'REFUSED';
export type StockBucket = 'UNRESTRICTED' | 'BLOCKED' | 'QUARANTINE';

export interface ReturnRow {
  id: string;
  number: string | null;
  status: ReturnStatus;
  creditStatus: CreditStatus;
  receipt: { id: string; number: string };
  order: { id: string; number: string };
  supplier: { id: string; code: string; name: string };
  returnDate: string;
  reasonCode: ReturnReason;
  remedy: Remedy;
}

export interface ReturnLine {
  id: string;
  lineNo: number;
  receiptLineId: string;
  receiptLineNo: number;
  orderLineId: string;
  orderLineNo: number;
  source: ReturnSource;
  product: { id: string; sku: string } | null;
  description: string;
  uom: string | null;
  baseUom: string | null;
  stocked: boolean;
  quantity: string;
  baseQuantity: string | null;
  location: { id: string; path: string } | null;
  bucket: StockBucket | null;
  lotCode: string | null;
  serials: string[];
  creditQuantity: string;
  creditedQuantity: string;
  notes: string | null;
}

export interface PurchaseReturn {
  id: string;
  version: number;
  number: string | null;
  status: ReturnStatus;
  creditStatus: CreditStatus;
  legalEntity: { id: string; code: string };
  receipt: { id: string; number: string };
  order: { id: string; number: string };
  supplier: { id: string; code: string; name: string };
  warehouse: { id: string; code: string; name: string } | null;
  returnDate: string;
  reasonCode: ReturnReason;
  description: string;
  remedy: Remedy;
  carrierRef: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  integrationEventId: string | null;
  postingId: string | null;
  cancelReason: string | null;
  evidenceCount: number;
  lines: ReturnLine[];
  creditNotes: {
    id: string;
    number: string | null;
    creditNoteNumber: string;
    status: string;
    totalAmount: string;
    currency: string;
    creditNoteDate: string;
  }[];
  invoices: { id: string; number: string; invoiceNumber: string }[];
  history: { kind: string; reason: string | null; at: string; by: string | null }[];
  can: {
    edit: boolean;
    confirm: boolean;
    confirmBlockedBy: string | null;
    cancel: boolean;
    credit: boolean;
  };
}

export interface ReturnableReceipt {
  id: string;
  number: string | null;
  returnable: boolean;
  order: { id: string; number: string; closed: boolean };
  supplier: { id: string; code: string; name: string };
  warehouseId: string | null;
  receiptDate: string;
  locations: { id: string; path: string }[];
  lines: {
    id: string;
    lineNo: number;
    orderLineNo: number;
    product: { id: string; sku: string } | null;
    description: string;
    uom: string | null;
    baseUom: string | null;
    stocked: boolean;
    accepted: string;
    refused: string;
    rejectReason: string | null;
    acceptedLeft: string;
    refusedLeft: string;
    location: { id: string; path: string } | null;
    lotCode: string | null;
    serials: string[];
    tracking: { lots: boolean; serials: boolean };
  }[];
}

export const RETURN_STATUS: Record<ReturnStatus, string> = {
  DRAFT: 'Rascunho',
  CONFIRMED: 'Confirmada',
  CANCELLED: 'Anulada',
};
export const CREDIT_STATUS: Record<CreditStatus, string> = {
  NOT_REQUIRED: 'Sem crédito a receber',
  PENDING: 'Crédito pendente',
  CREDITED: 'Creditada',
};
export const RETURN_REASON: Record<ReturnReason, string> = {
  QUALITY: 'Qualidade',
  DAMAGED: 'Danificado',
  WRONG_ITEM: 'Artigo errado',
  EXPIRED: 'Fora de validade',
  QUANTITY: 'Quantidade a mais',
  DOCUMENTATION: 'Documentação',
  OTHER: 'Outro',
};
export const REMEDY: Record<Remedy, string> = {
  REPLACEMENT: 'Substituição',
  CREDIT: 'Crédito',
};
export const RETURN_SOURCE: Record<ReturnSource, string> = {
  ACCEPTED: 'Aceite (em stock)',
  REFUSED: 'Recusada na conferência',
};
export const STOCK_BUCKET: Record<StockBucket, string> = {
  UNRESTRICTED: 'Livre',
  BLOCKED: 'Bloqueado',
  QUARANTINE: 'Quarentena',
};
export const RETURN_EVENT: Record<string, string> = {
  CREATED: 'Registada',
  UPDATED: 'Alterada',
  CONFIRMED: 'Confirmada',
  CANCELLED: 'Anulada',
};

export function returnTone(s: ReturnStatus): string {
  if (s === 'CONFIRMED') return 'bg-success-soft text-success-text';
  return 'bg-surface-2 text-muted';
}
export function creditTone(s: CreditStatus): string {
  if (s === 'PENDING') return 'bg-warning-soft text-warning-text';
  if (s === 'CREDITED') return 'bg-success-soft text-success-text';
  return 'bg-surface-2 text-muted';
}

export interface ReturnLineForm {
  receiptLineId: string;
  source: ReturnSource;
  label: string;
  uom: string | null;
  left: string;
  stocked: boolean;
  serialsTracked: boolean;
  receivedSerials: string[];
  lotCode: string | null;
  quantity: string;
  bucket: StockBucket;
  locationId: string;
  serials: string;
  notes: string;
}

const zero = (v: string) => /^0+(\.0+)?$/.test(v.trim().replace(',', '.'));

/**
 * Uma linha por origem com algo por devolver: o aceite (estava em stock) e o recusado na conferência (nunca entrou).
 * A quantidade fica vazia (escolhe-se o que se devolve).
 */
export function returnForm(r: ReturnableReceipt): ReturnLineForm[] {
  const out: ReturnLineForm[] = [];
  for (const l of r.lines) {
    const label = `${l.lineNo} · ${l.product ? l.product.sku + ' — ' : ''}${l.description}`;
    const common = {
      receiptLineId: l.id,
      label,
      uom: l.uom,
      receivedSerials: l.serials,
      lotCode: l.lotCode,
      quantity: '',
      bucket: 'UNRESTRICTED' as StockBucket,
      locationId: '',
      serials: '',
      notes: '',
    };
    if (!zero(l.acceptedLeft))
      out.push({
        ...common,
        source: 'ACCEPTED',
        left: l.acceptedLeft,
        stocked: l.stocked,
        serialsTracked: l.stocked && l.tracking.serials,
        locationId: l.location?.id ?? '',
      });
    if (!zero(l.refusedLeft))
      out.push({
        ...common,
        source: 'REFUSED',
        left: l.refusedLeft,
        stocked: false,
        serialsTracked: false,
      });
  }
  return out;
}

/** Junta ao formulário as quantidades de uma devolução em rascunho (edição). */
export function withReturn(
  form: ReturnLineForm[],
  lines: Pick<
    ReturnLine,
    'receiptLineId' | 'source' | 'quantity' | 'bucket' | 'location' | 'serials' | 'notes'
  >[],
): ReturnLineForm[] {
  return form.map((f) => {
    const x = lines.find((l) => l.receiptLineId === f.receiptLineId && l.source === f.source);
    return x
      ? {
          ...f,
          quantity: plain(x.quantity),
          bucket: x.bucket ?? 'UNRESTRICTED',
          locationId: x.location?.id ?? f.locationId,
          serials: x.serials.join(', '),
          notes: x.notes ?? '',
        }
      : f;
  });
}

/** Corpo para a API: só as linhas com quantidade; séries separadas por vírgulas ou linhas. */
export function returnPayload(lines: ReturnLineForm[]) {
  const n = (v: string) => v.trim().replace(',', '.');
  return lines
    .filter((l) => n(l.quantity) !== '' && !zero(l.quantity))
    .map((l) => ({
      receiptLineId: l.receiptLineId,
      source: l.source,
      quantity: n(l.quantity),
      ...(l.stocked
        ? {
            bucket: l.bucket,
            locationId: l.locationId || null,
            serials: l.serials
              .split(/[\n,;]+/)
              .map((s) => s.trim())
              .filter((s) => s),
          }
        : {}),
      notes: l.notes.trim() || null,
    }));
}

/** Quantidade pedida acima do disponível na linha (aviso antes de enviar). */
export function overLeft(l: ReturnLineForm): boolean {
  const q = scaled(l.quantity, 6);
  const left = scaled(l.left, 6);
  return q !== null && left !== null && q > left;
}
