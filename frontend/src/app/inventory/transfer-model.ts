/** Transferências (8.5): estados, acções por estado e direitos, e valores por defeito das rondas. */

export type TransferStatus =
  | 'DRAFT'
  | 'REQUESTED'
  | 'APPROVED'
  | 'PICKED'
  | 'IN_TRANSIT'
  | 'PARTIAL'
  | 'RECEIVED'
  | 'REJECTED'
  | 'CANCELLED';

interface Wh {
  warehouse: { id: string; code: string; name?: string };
  legalEntity?: { id: string; code: string };
}
interface Step {
  by: string | null;
  at: string;
}

export interface TransferLine {
  id: string;
  lineNo: number;
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  uom: string;
  quantity: string;
  sourceLocation: { id: string; pathCode: string } | null;
  sourceBucket: string;
  destLocation: { id: string; pathCode: string } | null;
  lotCode: string | null;
  serials: string[];
  trackSerials: boolean;
  pickedQuantity: string | null;
  shippedQuantity: string;
  receivedQuantity: string;
  lostQuantity: string;
  inTransitQuantity: string;
}

export interface Transfer {
  id: string;
  version?: number;
  number: string | null;
  status: TransferStatus;
  intercompany: boolean;
  intercompanyRef?: string | null;
  source: Wh;
  dest: Wh;
  requestedDate: string;
  expectedDate?: string | null;
  notes?: string | null;
  carrier?: string | null;
  trackingRef?: string | null;
  createdBy?: string | null;
  submitted?: Step | null;
  approved?: Step | null;
  accepted?: Step | null;
  picked?: Step | null;
  dispatched?: Step | null;
  closeReason?: string | null;
  rejectReason?: string | null;
  cancelReason?: string | null;
  lineCount?: number;
  can?: {
    manageSource: boolean;
    approveSource: boolean;
    manageDest: boolean;
    approveDest: boolean;
    isRequester: boolean;
  };
  lines?: TransferLine[];
  events?: {
    id: string;
    kind: string;
    reason: string | null;
    createdAt: string;
    createdBy: string | null;
    lineCount: number;
  }[];
}

export const TRANSFER_STATUS: Record<TransferStatus, string> = {
  DRAFT: 'Rascunho',
  REQUESTED: 'Pedida',
  APPROVED: 'Aprovada',
  PICKED: 'Separada',
  IN_TRANSIT: 'Em trânsito',
  PARTIAL: 'Recebida parcial',
  RECEIVED: 'Recebida',
  REJECTED: 'Rejeitada',
  CANCELLED: 'Anulada',
};
export const EVENT_KIND: Record<string, string> = {
  RESERVE: 'Reserva na origem',
  RELEASE: 'Reserva libertada',
  DISPATCH: 'Expedição',
  RECEIVE: 'Recepção',
  LOSS: 'Perda em trânsito',
};

export function transferTone(s: TransferStatus): string {
  if (s === 'RECEIVED') return 'bg-success-soft text-success-text';
  if (s === 'REJECTED' || s === 'CANCELLED') return 'bg-danger-soft text-danger-text';
  if (s === 'DRAFT') return 'bg-surface-2 text-muted';
  return 'bg-info-soft text-info-text';
}

/** Acções visíveis (a API decide). Quem pediu não aprova nem aceita. */
export function transferActions(
  t: Pick<Transfer, 'status' | 'can' | 'intercompany' | 'approved' | 'accepted'>,
) {
  const c = t.can ?? {
    manageSource: false,
    approveSource: false,
    manageDest: false,
    approveDest: false,
    isRequester: false,
  };
  const s = t.status;
  return {
    edit: c.manageSource && s === 'DRAFT',
    submit: c.manageSource && s === 'DRAFT',
    approve: c.approveSource && !c.isRequester && s === 'REQUESTED' && !t.approved,
    accept: t.intercompany && c.approveDest && !c.isRequester && s === 'REQUESTED' && !t.accepted,
    reject: (c.approveSource || (t.intercompany && c.approveDest)) && s === 'REQUESTED',
    pick: c.manageSource && (s === 'APPROVED' || s === 'PICKED'),
    dispatch: c.manageSource && (s === 'APPROVED' || s === 'PICKED'),
    receive: c.manageDest && (s === 'IN_TRANSIT' || s === 'PARTIAL'),
    close: c.approveDest && (s === 'IN_TRANSIT' || s === 'PARTIAL'),
    cancel: c.manageSource && ['DRAFT', 'REQUESTED', 'APPROVED', 'PICKED'].includes(s),
  };
}

const trim = (v: string) => v.replace(/\.?0+$/, '') || '0';

/** Separação por defeito: tudo o que foi pedido. */
export const pickDefaults = (lines: TransferLine[]) =>
  Object.fromEntries(lines.map((l) => [l.id, trim(l.pickedQuantity ?? l.quantity)]));

/** Recepção por defeito: o que está em trânsito em cada linha. */
export const receiveDefaults = (lines: TransferLine[]) =>
  Object.fromEntries(
    lines
      .filter((l) => l.inTransitQuantity !== '0.000000')
      .map((l) => [l.id, trim(l.inTransitQuantity)]),
  );
