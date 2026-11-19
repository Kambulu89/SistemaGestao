/** Alertas e relatórios do inventário (8.11): tipos da API, rótulos e linhas de exportação. */

export interface Alerts {
  days: number;
  stockout: number;
  reorder: number;
  incoming: number;
  expired: number;
  expiring: number;
}

interface ProductRef {
  id: string;
  sku: string;
  name: string;
}

export type ReplenishmentStatus = 'STOCKOUT' | 'REORDER' | 'INCOMING' | 'OK';
export interface ReplenishmentRow {
  product: ProductRef;
  uom: string;
  min: string | null;
  max: string | null;
  onHand: string;
  available: string;
  reserved: string;
  incoming: string;
  suggested: string;
  status: ReplenishmentStatus;
}

export interface ExpiryRow {
  warehouse: { id: string; code: string };
  product: ProductRef;
  variant: { id: string; sku: string | null } | null;
  uom: string;
  lot: { id: string; code: string; status: string };
  expiryDate: string;
  daysLeft: number;
  status: 'EXPIRED' | 'EXPIRING';
  quantity: string;
}

interface Ranged {
  from: string;
  to: string;
  total: number;
}
export interface TurnoverReport extends Ranged {
  days: number;
  rows: {
    product: ProductRef;
    uom: string;
    opening: string;
    closing: string;
    average: string;
    consumption: string;
    dailyConsumption: string;
    turnover: string | null;
    available: string;
    coverageDays: number | null;
  }[];
}
export interface MovementsReport extends Ranged {
  values: boolean;
  rows: {
    product: ProductRef;
    uom: string;
    class: string;
    quantityIn: string;
    quantityOut: string;
    value: string | null;
  }[];
  totals: { class: string; direction: 'IN' | 'OUT'; value: string | null }[];
}
export interface LossesReport extends Ranged {
  values: boolean;
  rows: {
    product: ProductRef;
    uom: string;
    class: string;
    quantity: string;
    value: string | null;
  }[];
  totals: { losses: string; gains: string; net: string } | null;
}
interface CostCenterRef {
  id: string;
  code: string;
  name: string;
}
export interface ConsumptionReport extends Ranged {
  values: boolean;
  rows: {
    costCenter: CostCenterRef;
    product: ProductRef;
    uom: string;
    quantity: string;
    value: string | null;
  }[];
  totals: { costCenter: CostCenterRef; value: string | null }[];
}
export interface ValuedReport {
  legalEntity: { id: string; code: string };
  currency: string | null;
  date: string;
  total: number;
  rows: {
    product: ProductRef;
    variant: { id: string; sku: string | null } | null;
    uom: string;
    method: string;
    class: string;
    quantity: string;
    unitCost: string;
    value: string;
  }[];
  totals: { value: string; classes: { class: string; value: string }[] };
}

export const REPLENISHMENT_STATUS: Record<ReplenishmentStatus, string> = {
  STOCKOUT: 'Ruptura',
  REORDER: 'Repor',
  INCOMING: 'A caminho',
  OK: 'Suficiente',
};
export function replenishmentTone(s: ReplenishmentStatus): string {
  if (s === 'STOCKOUT') return 'bg-danger-soft text-danger-text';
  if (s === 'REORDER') return 'bg-warning-soft text-warning-text';
  if (s === 'INCOMING') return 'bg-info-soft text-info-text';
  return 'bg-success-soft text-success-text';
}

export const MOVEMENT_CLASS: Record<string, string> = {
  PURCHASE: 'Compras',
  CUSTOMER_RETURN: 'Devoluções de clientes',
  PRODUCTION: 'Produção',
  OPENING: 'Stock inicial',
  OTHER_RECEIPT: 'Outras entradas',
  SALE: 'Vendas',
  CONSUMPTION: 'Consumo interno',
  SAMPLE: 'Amostras',
  SUPPLIER_RETURN: 'Devoluções a fornecedores',
  OTHER_ISSUE: 'Outras saídas',
  LOSS: 'Quebras e perdas',
  TRANSFER_LOSS: 'Perdas em trânsito',
  ADJUSTMENT_LOSS: 'Faltas de contagem',
  ADJUSTMENT_GAIN: 'Sobras de contagem',
  TRANSFER_IN: 'Transferências recebidas',
  TRANSFER_OUT: 'Transferências expedidas',
  OTHER: 'Outros',
};
export const classLabel = (c: string) => MOVEMENT_CLASS[c] ?? c;

/** Validade em texto: "expirou há 3 dias", "expira hoje", "faltam 10 dias". */
export function expiryText(daysLeft: number): string {
  if (daysLeft < 0) return `expirou há ${-daysLeft} dia${daysLeft === -1 ? '' : 's'}`;
  if (daysLeft === 0) return 'expira hoje';
  return `falta${daysLeft === 1 ? '' : 'm'} ${daysLeft} dia${daysLeft === 1 ? '' : 's'}`;
}

/** Cobertura: dias que o disponível dura ao ritmo do período. */
export function coverageText(days: number | null): string {
  if (days === null) return 'sem consumo';
  return `${days} dia${days === 1 ? '' : 's'}`;
}

/** Rotação (voltas no período) com vírgula decimal. */
export const turnoverText = (t: string | null) => (t === null ? '—' : t.replace('.', ','));

/** Período por omissão: do primeiro dia do mês até hoje. */
export function defaultRange(today = new Date()): { from: string; to: string } {
  const to = today.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** Número para CSV: o texto da API (ponto decimal), vazio quando não há valor. */
const n = (v: string | null) => v ?? '';

export function replenishmentCsv(rows: ReplenishmentRow[]) {
  return {
    headers: [
      'SKU',
      'Produto',
      'Unidade',
      'Estado',
      'Mínimo',
      'Máximo',
      'Físico',
      'Reservado',
      'Disponível',
      'A caminho',
      'Sugestão',
    ],
    rows: rows.map((r) => [
      r.product.sku,
      r.product.name,
      r.uom,
      REPLENISHMENT_STATUS[r.status],
      n(r.min),
      n(r.max),
      r.onHand,
      r.reserved,
      r.available,
      r.incoming,
      r.suggested,
    ]),
  };
}

export function movementsCsv(r: MovementsReport) {
  return {
    headers: ['SKU', 'Produto', 'Unidade', 'Classe', 'Entradas', 'Saídas', 'Valor'],
    rows: r.rows.map((x) => [
      x.product.sku,
      x.product.name,
      x.uom,
      classLabel(x.class),
      x.quantityIn,
      x.quantityOut,
      n(x.value),
    ]),
  };
}
