/** Stock (8.3): saldos por balde, movimentos e lançamentos (só de acréscimo; os saldos derivam dos movimentos). */

export type Bucket =
  'UNRESTRICTED' | 'BLOCKED' | 'QUARANTINE' | 'RESERVED' | 'IN_TRANSIT' | 'EXPECTED';
export type StatusBucket = 'UNRESTRICTED' | 'BLOCKED' | 'QUARANTINE';

interface Ref {
  id: string;
  code?: string;
  sku?: string;
  name?: string;
  pathCode?: string;
}

export interface StockBalance {
  id: string;
  version: number;
  warehouse: Ref & { code: string; name: string };
  location: (Ref & { pathCode: string }) | null;
  product: Ref & { sku: string; name: string };
  variant: (Ref & { sku: string }) | null;
  /** Lote (8.8): só nos produtos com lotes. */
  lot: { id: string; code: string; expiryDate: string | null; status?: string } | null;
  uom: string;
  uomDecimals: number;
  physical: string;
  available: string;
  unrestricted: string;
  blocked: string;
  quarantine: string;
  reserved: string;
  inTransit: string;
  expected: string;
  lastMovementAt: string | null;
}

export interface StockLine {
  id: string;
  lineNo: number;
  warehouse: { id: string; code: string };
  location: { id: string; pathCode: string } | null;
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  /** Lote (8.8): só nos produtos com lotes. */
  lot: { id: string; code: string; expiryDate: string | null; status?: string } | null;
  uom: string;
  bucket: Bucket;
  quantity: string;
}

export interface StockMovement extends StockLine {
  postingId: string;
  type: string;
  source: { type: string; ref: string | null };
  reason: string | null;
  reversalOf: string | null;
  occurredAt: string;
  user: string | null;
}

export interface StockPosting {
  id: string;
  type: string;
  idempotencyKey: string;
  source: { type: string; id: string | null; ref: string | null };
  reason: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  occurredAt: string;
  createdBy: string | null;
  lines: StockLine[];
}

export interface Reconciliation {
  checked: number;
  differences: {
    warehouseId: string;
    locationId: string | null;
    productId: string;
    variantId: string | null;
  }[];
}

export const BUCKET: Record<Bucket, string> = {
  UNRESTRICTED: 'Livre',
  BLOCKED: 'Bloqueado',
  QUARANTINE: 'Quarentena',
  RESERVED: 'Reservado',
  IN_TRANSIT: 'Em trânsito',
  EXPECTED: 'Previsto',
};
export const STATUS_BUCKETS: StatusBucket[] = ['UNRESTRICTED', 'BLOCKED', 'QUARANTINE'];

export const POSTING_TYPE: Record<string, string> = {
  RECEIPT: 'Entrada',
  ISSUE: 'Saída',
  STATUS_CHANGE: 'Mudança de estado',
  RESERVATION: 'Reserva',
  RELEASE: 'Libertação',
  TRANSFER_OUT: 'Transferência (saída)',
  TRANSFER_IN: 'Transferência (entrada)',
  ADJUSTMENT: 'Ajuste',
  EXPECTED: 'Previsão',
  REVERSAL: 'Estorno',
};

/** Origens conhecidas (os módulos que pedem lançamentos acrescentam as suas). */
const SOURCE: Record<string, string> = {
  STOCK_STATUS: 'Inventário · mudança de estado',
  STOCK_LOT: 'Inventário · lote',
  STOCK_COUNT: 'Contagem',
};
export const sourceLabel = (s: { type: string; ref: string | null }) =>
  s.ref ?? SOURCE[s.type] ?? s.type;

/** Quantidade da API (6 casas) para leitura: sem zeros à direita, separador de milhares. */
export function qty(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const frac = f.replace(/0+$/, '');
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${int}${frac ? `,${frac}` : ''}`;
}

/** Quantidade com sinal explícito (movimentos). */
export const signedQty = (v: string) => (v.startsWith('-') ? qty(v) : `+${qty(v)}`);

export const productLabel = (r: { product: { sku: string }; variant: { sku: string } | null }) =>
  r.variant ? r.variant.sku : r.product.sku;

export const isZero = (v: string) => /^-?0+(\.0+)?$/.test(v);

/** Chave de idempotência nova por pedido (repetir o mesmo envio reutiliza-a). */
export function newKey(prefix: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}

/** Quantidade válida para uma mudança de estado: positiva, até às casas da unidade e não acima do disponível no estado. */
export function statusQuantityError(raw: string, max: string, decimals = 6): string | null {
  const t = raw.trim().replace(',', '.');
  if (
    !new RegExp(decimals ? `^\\d{1,12}(\\.\\d{1,${decimals}})?$` : '^\\d{1,12}$').test(t) ||
    Number(t) <= 0
  )
    return decimals
      ? `Quantidade positiva, até ${decimals} casas decimais.`
      : 'Quantidade inteira positiva.';
  if (Number(t) > Number(max)) return `Há só ${qty(max)} neste estado.`;
  return null;
}
