/** Valorização (8.9): métodos, origens das entradas do livro e cálculos de apresentação. Valores em texto da API. */

export type ValuationMethod = 'AVERAGE' | 'FIFO' | 'SPECIFIC';

export interface CostPool {
  legalEntity: { id: string; code: string };
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  method: ValuationMethod;
  uom: string;
  currency: string | null;
  quantity: string;
  value: string;
  unitCost: string;
}

export interface CostLayer {
  id: string;
  variantId: string | null;
  lot: { id: string; code: string } | null;
  receivedAt: string;
  source: { type: string | null; ref: string | null };
  quantityIn: string;
  valueIn: string;
  unitCost: string;
  remainingQuantity: string;
  remainingValue: string;
}

export interface LedgerEntry {
  id: string;
  occurredAt: string;
  variantId: string | null;
  lot: string | null;
  layerId: string | null;
  source: string;
  postingType: string | null;
  origin: { type: string; id: string | null; ref: string | null } | null;
  reason: string | null;
  quantity: string;
  value: string;
  user: string | null;
}

export interface ProductValuation {
  product: { id: string; sku: string; name: string };
  method: ValuationMethod;
  uom: string;
  pools: CostPool[];
  layers: CostLayer[];
  ledger: LedgerEntry[];
}

export interface Reconciliation {
  legalEntityId: string;
  date: string;
  classes: {
    accountingClass: string;
    inventoryValue: string;
    account: { id: string; code: string; name: string } | null;
  }[];
  accounts: {
    accountId: string;
    account: { id: string; code: string; name: string };
    classes: string[];
    inventoryValue: string;
    ledgerBalance: string;
    difference: string;
  }[];
  unmappedClasses: string[];
  internal: {
    checked: number;
    differences: { productId: string; sku: string; problems: string[] }[];
  };
  productsWithoutCost: number;
}

export const METHOD: Record<ValuationMethod, string> = {
  AVERAGE: 'Custo médio',
  FIFO: 'FIFO',
  SPECIFIC: 'Específico (lote)',
};

export const ENTRY_SOURCE: Record<string, string> = {
  GIVEN: 'Custo do documento',
  PAIRED: 'Custo da origem (transferência)',
  RETURN: 'Custo do original (devolução)',
  CURRENT: 'Custo actual',
  ZERO: 'Sem custo',
  AVERAGE: 'Custo médio',
  LAYER: 'Camada',
  REVERSAL: 'Estorno',
  ADJUSTMENT: 'Ajuste de custo',
  OPENING: 'Stock anterior (sem custo)',
};

export const PROBLEM: Record<string, string> = {
  LEDGER_POOL: 'livro ≠ saldo de custo',
  POOL_LAYERS: 'saldo ≠ camadas',
  QUANTITY_STOCK: 'quantidade valorizada ≠ stock',
};

/** Dinheiro (2 casas, texto da API) para leitura: separador de milhares e vírgula decimal. */
export function money(v: string | null | undefined, currency?: string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const neg = v.startsWith('-');
  const [i, f = '00'] = (neg ? v.slice(1) : v).split('.');
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${int},${(f + '00').slice(0, 2)}${currency ? ' ' + currency : ''}`;
}

/** Diferença com sinal (zero é "sem diferença"). */
export const isZeroMoney = (v: string) => /^-?0+(\.0+)?$/.test(v);

/** Soma de textos de dinheiro (2 casas) sem vírgula flutuante. */
export function sumMoney(values: string[]): string {
  let cents = 0n;
  for (const v of values) {
    const neg = v.startsWith('-');
    const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
    const c = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
    cents += neg ? -c : c;
  }
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}
