/** Recepções de compra (9.7): tipos da API, rótulos, cores e corpo das linhas. */
import { plain } from './rfq-model';

export type ReceiptStatus = 'DRAFT' | 'CONFIRMED' | 'REVERSED' | 'CANCELLED';
export type DeliveryState = 'OVERDUE' | 'TODAY' | 'UPCOMING' | 'UNSCHEDULED' | 'DONE';

export interface ReceiptRow {
  id: string;
  number: string | null;
  status: ReceiptStatus;
  order: { id: string; number: string };
  supplier: { id: string; code: string; name: string };
  warehouse: { id: string; code: string } | null;
  receiptDate: string;
  deliveryNote: string | null;
}

export interface Tracking {
  lots: boolean;
  expiry: boolean;
  serials: boolean;
}

export interface ReceiptLine {
  id: string;
  orderLineId: string;
  lineNo: number;
  product: { id: string; sku: string } | null;
  description: string;
  uom: string | null;
  baseUom: string | null;
  stocked: boolean;
  ordered: string;
  quantity: string;
  baseQuantity: string | null;
  rejectedQuantity: string;
  rejectReason: string | null;
  location: { id: string; path: string } | null;
  lotCode: string | null;
  expiryDate: string | null;
  serials: string[];
  unitCost: string | null;
  notes: string | null;
  tracking: Tracking;
}

export interface Receipt {
  id: string;
  version: number;
  number: string | null;
  status: ReceiptStatus;
  legalEntity: { id: string; code: string };
  order: { id: string; number: string };
  supplier: { id: string; code: string; name: string };
  warehouse: { id: string; code: string; name: string } | null;
  receiptDate: string;
  deliveryNote: string | null;
  notes: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  integrationEventId: string | null;
  postingId: string | null;
  reversalPostingId: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
  cancelReason: string | null;
  lines: ReceiptLine[];
  history: { kind: string; reason: string | null; at: string; by: string | null }[];
  can: { edit: boolean; confirm: boolean; cancel: boolean; reverse: boolean };
}

export interface ReceivableOrder {
  id: string;
  number: string;
  receivable: boolean;
  supplier: { id: string; code: string; name: string };
  warehouseId: string | null;
  expectedDate: string | null;
  locations: { id: string; path: string }[];
  lines: {
    id: string;
    lineNo: number;
    product: { id: string; sku: string } | null;
    description: string;
    uom: string | null;
    stocked: boolean;
    ordered: string;
    received: string;
    open: string;
    expectedDate: string | null;
    tracking: Tracking;
  }[];
}

export interface ExpectedDelivery {
  order: { id: string; number: string };
  supplier: { code: string; name: string };
  lineId: string;
  lineNo: number;
  description: string;
  uom: string | null;
  ordered: string;
  open: string;
  expectedDate: string | null;
  state: DeliveryState;
}

export const RECEIPT_STATUS: Record<ReceiptStatus, string> = {
  DRAFT: 'Rascunho',
  CONFIRMED: 'Confirmada',
  REVERSED: 'Estornada',
  CANCELLED: 'Anulada',
};
export const DELIVERY_STATE: Record<DeliveryState, string> = {
  OVERDUE: 'Atrasada',
  TODAY: 'Hoje',
  UPCOMING: 'Prevista',
  UNSCHEDULED: 'Sem data',
  DONE: 'Recebida',
};
export const RECEIPT_EVENT: Record<string, string> = {
  CREATED: 'Registada',
  UPDATED: 'Alterada',
  CONFIRMED: 'Confirmada',
  CANCELLED: 'Anulada',
  REVERSED: 'Estornada',
};

export function receiptTone(s: ReceiptStatus): string {
  if (s === 'CONFIRMED') return 'bg-success-soft text-success-text';
  if (s === 'REVERSED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}
export function deliveryTone(s: DeliveryState): string {
  if (s === 'OVERDUE') return 'bg-danger-soft text-danger-text';
  if (s === 'TODAY') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

export interface ReceiptLineForm {
  orderLineId: string;
  lineNo: number;
  description: string;
  uom: string | null;
  open: string;
  stocked: boolean;
  tracking: Tracking;
  quantity: string;
  rejectedQuantity: string;
  rejectReason: string;
  locationId: string;
  lotCode: string;
  expiryDate: string;
  serials: string;
}

/** Linhas do formulário a partir da ordem: só as que têm algo em falta, com a quantidade em falta por omissão. */
export function receiptForm(o: ReceivableOrder): ReceiptLineForm[] {
  return o.lines
    .filter((l) => !/^0(\.0+)?$/.test(l.open))
    .map((l) => ({
      orderLineId: l.id,
      lineNo: l.lineNo,
      description: `${l.product ? l.product.sku + ' — ' : ''}${l.description}`,
      uom: l.uom,
      open: l.open,
      stocked: l.stocked,
      tracking: l.tracking,
      quantity: plain(l.open),
      rejectedQuantity: '',
      rejectReason: '',
      locationId: '',
      lotCode: '',
      expiryDate: '',
      serials: '',
    }));
}

/** Corpo para a API: linhas com algo recebido ou recusado; séries separadas por vírgulas ou linhas. */
export function receiptPayload(lines: ReceiptLineForm[]) {
  const n = (v: string) => v.trim().replace(',', '.');
  const zero = (v: string) => n(v) === '' || /^0+(\.0+)?$/.test(n(v));
  return lines
    .filter((l) => !zero(l.quantity) || !zero(l.rejectedQuantity))
    .map((l) => ({
      orderLineId: l.orderLineId,
      quantity: zero(l.quantity) ? '0' : n(l.quantity),
      rejectedQuantity: zero(l.rejectedQuantity) ? '0' : n(l.rejectedQuantity),
      rejectReason: l.rejectReason.trim() || null,
      locationId: l.locationId || null,
      lotCode: l.lotCode.trim() || null,
      expiryDate: l.expiryDate || null,
      serials: l.serials
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter((s) => s),
    }));
}
