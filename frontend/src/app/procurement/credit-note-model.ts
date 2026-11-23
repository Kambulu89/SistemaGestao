/** Notas de crédito de fornecedor (9.9): tipos da API, rótulos, formulário e valores como no servidor. */
import { scaled } from './requisition-model';
import { plain } from './rfq-model';

export type CreditNoteStatus = 'DRAFT' | 'VALIDATED' | 'CANCELLED';
export type CreditKind = 'QUANTITY' | 'PRICE';

export interface CreditNoteRow {
  id: string;
  number: string | null;
  status: CreditNoteStatus;
  creditNoteNumber: string;
  creditNoteDate: string;
  supplier: { id: string; code: string; name: string };
  invoice: { id: string; number: string; invoiceNumber: string };
  currency: string;
  totalAmount: string;
}

export interface CreditNote {
  id: string;
  version: number;
  number: string | null;
  status: CreditNoteStatus;
  legalEntity: { id: string; code: string };
  supplier: { id: string; code: string; name: string };
  order: { id: string; number: string };
  invoice: { id: string; number: string; invoiceNumber: string };
  return: { id: string; number: string } | null;
  creditNoteNumber: string;
  creditNoteDate: string;
  currency: string;
  reason: string;
  declaredTotal: string;
  totalNet: string;
  totalTax: string;
  totalAmount: string;
  exchangeRate: string;
  totalFunctional: string | null;
  validatedAt: string | null;
  validatedBy: string | null;
  cancelReason: string | null;
  lines: {
    id: string;
    lineNo: number;
    invoiceLineId: string;
    invoiceLineNo: number;
    description: string;
    uom: string | null;
    kind: CreditKind;
    quantity: string;
    invoicedQuantity: string;
    returnLineId: string | null;
    returnNumber: string | null;
    netAmount: string;
    taxRate: string;
    taxAmount: string;
    totalAmount: string;
  }[];
  history: { kind: string; reason: string | null; at: string; by: string | null }[];
  can: { edit: boolean; validate: boolean; cancel: boolean };
}

export interface CreditableInvoice {
  id: string;
  number: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  creditable: boolean;
  currency: string;
  order: { id: string; number: string };
  supplier: { id: string; code: string; name: string };
  totalAmount: string;
  lines: {
    id: string;
    lineNo: number;
    orderLineId: string | null;
    orderLineNo: number | null;
    description: string;
    uom: string | null;
    quantity: string;
    netAmount: string;
    taxRate: string;
    taxAmount: string;
    creditedQuantity: string;
    creditedNet: string;
    quantityLeft: string;
    netLeft: string;
    taxLeft: string;
  }[];
  pendingReturns: {
    returnId: string;
    returnNumber: string;
    returnLineId: string;
    orderLineId: string;
    pending: string;
  }[];
}

export const CREDIT_NOTE_STATUS: Record<CreditNoteStatus, string> = {
  DRAFT: 'Rascunho',
  VALIDATED: 'Validada',
  CANCELLED: 'Anulada',
};
export const CREDIT_KIND: Record<CreditKind, string> = {
  QUANTITY: 'Quantidade devolvida',
  PRICE: 'Ajuste de valor',
};
export const CREDIT_NOTE_EVENT: Record<string, string> = {
  CREATED: 'Registada',
  UPDATED: 'Alterada',
  VALIDATED: 'Validada',
  CANCELLED: 'Anulada',
};
export function creditNoteTone(s: CreditNoteStatus): string {
  if (s === 'VALIDATED') return 'bg-success-soft text-success-text';
  return 'bg-surface-2 text-muted';
}

export interface CreditLineForm {
  invoiceLineId: string;
  label: string;
  uom: string | null;
  quantityAllowed: boolean;
  quantityLeft: string;
  netLeft: string;
  quantity: string;
  amount: string;
}

/** Uma linha por linha da factura com algo por creditar; com uma devolução, a quantidade pendente já preenchida. */
export function creditForm(inv: CreditableInvoice, returnId: string | null): CreditLineForm[] {
  return inv.lines
    .filter((l) => !/^0+(\.0+)?$/.test(l.netLeft))
    .map((l) => {
      const pending = returnId
        ? inv.pendingReturns.find((p) => p.returnId === returnId && p.orderLineId === l.orderLineId)
        : undefined;
      return {
        invoiceLineId: l.id,
        label: `${l.lineNo} · ${l.description}`,
        uom: l.uom,
        quantityAllowed: !!l.orderLineId && !/^0+(\.0+)?$/.test(l.quantityLeft),
        quantityLeft: l.quantityLeft,
        netLeft: l.netLeft,
        quantity: pending ? plain(pending.pending) : '',
        amount: '',
      };
    });
}

const filled = (v: string) => v.trim() !== '' && !/^0+([.,]0+)?$/.test(v.trim());
const n = (v: string) => v.trim().replace(',', '.');

/** Corpo para a API: quantidade (ligada à devolução escolhida, se houver) e/ou ajuste de valor por linha. */
export function creditPayload(
  lines: CreditLineForm[],
  inv: CreditableInvoice,
  returnId: string | null,
) {
  const out: {
    invoiceLineId: string;
    kind: CreditKind;
    quantity?: string;
    netAmount?: string;
    returnLineId?: string | null;
  }[] = [];
  for (const l of lines) {
    if (l.quantityAllowed && filled(l.quantity)) {
      const il = inv.lines.find((x) => x.id === l.invoiceLineId);
      const pending = returnId
        ? inv.pendingReturns.find(
            (p) => p.returnId === returnId && p.orderLineId === il?.orderLineId,
          )
        : undefined;
      out.push({
        invoiceLineId: l.invoiceLineId,
        kind: 'QUANTITY',
        quantity: n(l.quantity),
        returnLineId: pending?.returnLineId ?? null,
      });
    }
    if (filled(l.amount))
      out.push({ invoiceLineId: l.invoiceLineId, kind: 'PRICE', netAmount: n(l.amount) });
  }
  return out;
}

const divRound = (a: bigint, b: bigint) => (a + b / 2n) / b;
const cents = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

/**
 * Total previsto da nota (líquido + imposto, como no servidor): quantidade ao líquido da factura (a que fecha a linha
 * leva o resto) e ajuste de valor; imposto à taxa da linha (o que fecha leva o imposto que resta). `null` se inválido.
 */
export function creditTotal(lines: CreditLineForm[], inv: CreditableInvoice): string | null {
  let sum = 0n;
  for (const l of lines) {
    const il = inv.lines.find((x) => x.id === l.invoiceLineId);
    if (!il) continue;
    const invQ = scaled(il.quantity, 6)!;
    const invNet = scaled(il.netAmount, 2)!;
    const rate = scaled(il.taxRate, 3)!;
    const qLeft = scaled(il.quantityLeft, 6)!;
    let netLeft = scaled(il.netLeft, 2)!;
    let taxLeft = scaled(il.taxLeft, 2)!;
    const parts: bigint[] = [];
    if (l.quantityAllowed && filled(l.quantity)) {
      const q = scaled(n(l.quantity), 6);
      if (q === null) return null;
      parts.push(q === qLeft ? netLeft : divRound(invNet * q, invQ));
    }
    if (filled(l.amount)) {
      const a = scaled(n(l.amount), 2);
      if (a === null) return null;
      parts.push(a);
    }
    for (const net of parts) {
      const tax = net === netLeft ? taxLeft : divRound(net * rate, 100_000n);
      sum += net + (tax < 0n ? 0n : tax);
      netLeft -= net;
      taxLeft -= tax;
    }
  }
  return cents(sum);
}
