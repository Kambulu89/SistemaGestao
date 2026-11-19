/** Integrações (8.10): eventos contabilísticos do inventário e pedidos de Compras/Vendas. */

export interface AccountingEvent {
  id: string;
  legalEntity: { id: string; code: string };
  event: string;
  direction: 'IN' | 'OUT';
  sourceRef: string;
  source: { type: string; id: string | null };
  occurredOn: string;
  total: string;
  currency: string | null;
  amounts: Record<string, string>;
  status: 'PENDING' | 'POSTED' | 'DRAFTED' | 'FAILED';
  error: string | null;
  attempts: number;
  entry: { id: string; number: string | null } | null;
  createdAt: string;
}

export interface IntegrationEvent {
  id: string;
  kind: string;
  sourceModule: string;
  warehouse: { id: string; code: string };
  orderRef: string;
  documentRef: string | null;
  counterpartyRef: string | null;
  postingId: string | null;
  summary: { lines?: { productId: string; quantity: string }[] };
  createdAt: string;
}

export const ACCOUNTING_STATUS: Record<AccountingEvent['status'], string> = {
  PENDING: 'Pendente',
  POSTED: 'Lançado',
  DRAFTED: 'Rascunho no razão',
  FAILED: 'Falhado',
};

export const INTEGRATION_KIND: Record<string, string> = {
  PURCHASE_RECEIPT: 'Recepção de compra',
  SALE_RESERVATION: 'Reserva de venda',
  SALE_RELEASE: 'Libertação de reserva',
  SALE_DELIVERY: 'Entrega de venda',
  SALE_RETURN: 'Devolução de cliente',
};

export const SOURCE_MODULE: Record<string, string> = {
  PURCHASES: 'Compras',
  SALES: 'Vendas',
  API: 'API',
};

export function accountingTone(s: AccountingEvent['status']): string {
  if (s === 'POSTED') return 'bg-success-soft text-success-text';
  if (s === 'FAILED') return 'bg-danger-soft text-danger-text';
  return 'bg-warning-soft text-warning-text';
}

/** Classes com valor no evento (as linhas `cls_*` diferentes de zero), em texto legível. */
export function eventClasses(amounts: Record<string, string>): string[] {
  return Object.entries(amounts)
    .filter(([k, v]) => k.startsWith('cls_') && !/^0+(\.0+)?$/.test(v))
    .map(([k]) => k.slice(4).toUpperCase());
}
