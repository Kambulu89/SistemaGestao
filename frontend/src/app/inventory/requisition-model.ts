/** Requisições internas e reservas (8.6): estados, acções por estado e direitos, e valores por defeito. */

export type RequisitionStatus =
  | 'DRAFT'
  | 'REQUESTED'
  | 'APPROVED'
  | 'PICKED'
  | 'PARTIAL'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED';

export interface RequisitionLine {
  id: string;
  lineNo: number;
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  uom: string;
  quantity: string;
  sourceLocation: { id: string; pathCode: string } | null;
  pickedQuantity: string | null;
  issuedQuantity: string;
  releasedQuantity: string;
  openQuantity: string;
}

export interface Requisition {
  id: string;
  version?: number;
  number: string | null;
  status: RequisitionStatus;
  warehouse: { id: string; code: string; name?: string };
  legalEntity?: { id: string; code: string };
  department: { id: string; code: string; name?: string };
  costCenter?: { id: string; code: string; name: string } | null;
  requestedBy: { membershipId?: string; name: string };
  purpose: string;
  neededBy: string | null;
  notes?: string | null;
  approved?: { by: string; at: string } | null;
  picked?: { by: string; at: string } | null;
  closeReason?: string | null;
  rejectReason?: string | null;
  cancelReason?: string | null;
  lineCount?: number;
  can?: { request: boolean; approve: boolean; fulfil: boolean; mine: boolean };
  lines?: RequisitionLine[];
  events?: {
    id: string;
    kind: string;
    reason: string | null;
    createdAt: string;
    createdBy: string | null;
    lineCount: number;
  }[];
}

export interface Reservation {
  source: { type: string; id: string | null; ref: string | null };
  warehouse: { id: string; code: string };
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  uom: string;
  quantity: string;
  lastAt: string;
}

export const REQUISITION_STATUS: Record<RequisitionStatus, string> = {
  DRAFT: 'Rascunho',
  REQUESTED: 'Pedida',
  APPROVED: 'Aprovada',
  PICKED: 'Separada',
  PARTIAL: 'Entregue parcial',
  COMPLETED: 'Concluída',
  REJECTED: 'Rejeitada',
  CANCELLED: 'Anulada',
};
export const REQUISITION_EVENT: Record<string, string> = {
  RESERVE: 'Reserva',
  ISSUE: 'Entrega (consumo)',
  RELEASE: 'Libertação',
};
export const RESERVATION_SOURCE: Record<string, string> = {
  INTERNAL_REQUISITION: 'Requisição interna',
  STOCK_TRANSFER: 'Transferência',
  INTERCOMPANY_TRANSFER: 'Transferência intragrupo',
};

export function requisitionTone(s: RequisitionStatus): string {
  if (s === 'COMPLETED') return 'bg-success-soft text-success-text';
  if (s === 'REJECTED' || s === 'CANCELLED') return 'bg-danger-soft text-danger-text';
  if (s === 'DRAFT') return 'bg-surface-2 text-muted';
  return 'bg-info-soft text-info-text';
}

/** Ligação para a origem de uma reserva (quando há ecrã para ela). */
export function reservationLink(r: Reservation): string[] | null {
  if (!r.source.id) return null;
  if (r.source.type === 'INTERNAL_REQUISITION') return ['/inventario/requisicoes', r.source.id];
  if (r.source.type === 'STOCK_TRANSFER' || r.source.type === 'INTERCOMPANY_TRANSFER')
    return ['/inventario/transferencias', r.source.id];
  return null;
}

/** Acções visíveis (a API decide). Quem pede não aprova. */
export function requisitionActions(r: Pick<Requisition, 'status' | 'can' | 'lines'>) {
  const c = r.can ?? { request: false, approve: false, fulfil: false, mine: false };
  const s = r.status;
  const issued = (r.lines ?? []).some((l) => l.issuedQuantity !== '0.000000');
  const open = ['APPROVED', 'PICKED', 'PARTIAL'].includes(s);
  return {
    edit: c.request && s === 'DRAFT',
    submit: c.request && s === 'DRAFT',
    approve: c.approve && !c.mine && s === 'REQUESTED',
    reject: c.approve && s === 'REQUESTED',
    pick: c.fulfil && open,
    issue: c.fulfil && open,
    release: c.fulfil && open,
    cancel:
      (c.request || c.approve || c.fulfil) &&
      ['DRAFT', 'REQUESTED', 'APPROVED', 'PICKED'].includes(s) &&
      !issued,
  };
}

const trim = (v: string) => v.replace(/\.?0+$/, '') || '0';

/** Separação por defeito: o pedido menos o libertado. */
export const pickDefaults = (lines: RequisitionLine[]) =>
  Object.fromEntries(
    lines.map((l) => [
      l.id,
      trim(l.pickedQuantity ?? (Number(l.quantity) - Number(l.releasedQuantity)).toFixed(6)),
    ]),
  );

/** Entrega por defeito: o separado por entregar (ou o que está em aberto). */
export function issueDefaults(lines: RequisitionLine[]) {
  const out: Record<string, string> = {};
  for (const l of lines) {
    if (l.openQuantity === '0.000000') continue;
    const cap =
      l.pickedQuantity === null
        ? Number(l.openQuantity)
        : Math.min(Number(l.openQuantity), Number(l.pickedQuantity) - Number(l.issuedQuantity));
    out[l.id] = trim(Math.max(0, cap).toFixed(6));
  }
  return out;
}
