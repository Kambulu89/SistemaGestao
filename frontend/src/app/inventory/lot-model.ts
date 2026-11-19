/** Lotes e séries (8.8): estados, validade, acções e textos. FEFO é a ordem física de saída, não a valorização. */

export type LotStatus = 'ACTIVE' | 'BLOCKED' | 'RECALLED';

export interface LotRow {
  id: string;
  version: number;
  code: string;
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  uom: string;
  expiryDate: string | null;
  manufacturedDate: string | null;
  expired: boolean;
  status: LotStatus;
  blockReason: string | null;
  recallReason: string | null;
  recalledAt: string | null;
  createdAt: string;
  stock?: string;
}

export interface LotDetail extends LotRow {
  can: { manage: boolean };
  balances: {
    warehouse: { id: string; code: string };
    location: { id: string; pathCode: string } | null;
    unrestricted: string;
    blocked: string;
    quarantine: string;
    inTransit: string;
  }[];
  movements: {
    postingId: string;
    type: string;
    source: { type: string; id: string | null; ref: string | null };
    warehouse: { id: string; code: string };
    location: { id: string; pathCode: string } | null;
    bucket: string;
    quantity: string;
    occurredAt: string;
    reason: string | null;
    user: string | null;
  }[];
  destinations: {
    source: { type: string; id: string | null; ref: string | null };
    postingType: string;
    warehouse: string;
    quantity: string;
    lastAt: string;
  }[];
  serials: {
    id: string;
    serial: string;
    status: string;
    warehouse: string | null;
    location: string | null;
    bucket: string | null;
  }[];
  events: {
    kind: string;
    reason: string;
    postingId: string | null;
    at: string;
    by: string | null;
  }[];
}

export interface SerialRow {
  id: string;
  serial: string;
  product: { id: string; sku: string; name: string };
  lot: { id: string; code: string } | null;
  status: 'IN_STOCK' | 'OUT';
  warehouse: string | null;
  location: string | null;
  bucket: string | null;
  history?: {
    postingId: string;
    type: string;
    source: { type: string; id: string | null; ref: string | null };
    direction: 'IN' | 'OUT';
    warehouse: string;
    location: string | null;
    lot: string | null;
    bucket: string;
    at: string;
  }[];
}

export const LOT_STATUS: Record<LotStatus, string> = {
  ACTIVE: 'Activo',
  BLOCKED: 'Bloqueado',
  RECALLED: 'Recolhido',
};
export const LOT_EVENT: Record<string, string> = {
  BLOCKED: 'Bloqueio',
  UNBLOCKED: 'Desbloqueio',
  RECALLED: 'Recolha',
};

export function lotTone(l: Pick<LotRow, 'status' | 'expired'>): string {
  if (l.status === 'RECALLED') return 'bg-danger-soft text-danger-text';
  if (l.status === 'BLOCKED' || l.expired) return 'bg-warning-soft text-warning-text';
  return 'bg-success-soft text-success-text';
}

/** Estado legível (um lote activo mas expirado diz-se "Expirado"). */
export const lotStatusLabel = (l: Pick<LotRow, 'status' | 'expired'>) =>
  l.status === 'ACTIVE' && l.expired ? 'Expirado' : LOT_STATUS[l.status];

/** Código do lote com a validade. */
export const lotLabel = (l: { code: string; expiryDate: string | null }) =>
  l.expiryDate ? `${l.code} (val. ${l.expiryDate.split('-').reverse().join('/')})` : l.code;

/** Dias até à validade (negativo se já passou); `null` sem validade. */
export function daysToExpiry(expiry: string | null, today = new Date().toISOString().slice(0, 10)) {
  if (!expiry) return null;
  return Math.round((Date.parse(expiry) - Date.parse(today)) / 86_400_000);
}

/** Acções visíveis (a API decide o âmbito). */
export function lotActions(l: Pick<LotDetail, 'status' | 'can'>) {
  const m = l.can?.manage ?? false;
  return {
    block: m && l.status === 'ACTIVE',
    unblock: m && l.status === 'BLOCKED',
    recall: m && l.status !== 'RECALLED',
  };
}

/** Ligação para a origem de um movimento (quando há ecrã para ela). */
export function sourceLink(s: { type: string; id: string | null }): string[] | null {
  if (!s.id) return null;
  const map: Record<string, string> = {
    STOCK_DOCUMENT: '/inventario/documentos',
    STOCK_TRANSFER: '/inventario/transferencias',
    INTERCOMPANY_TRANSFER: '/inventario/transferencias',
    INTERNAL_REQUISITION: '/inventario/requisicoes',
    STOCK_COUNT: '/inventario/contagens',
    STOCK_LOT: '/inventario/lotes',
  };
  return map[s.type] ? [map[s.type], s.id] : null;
}
