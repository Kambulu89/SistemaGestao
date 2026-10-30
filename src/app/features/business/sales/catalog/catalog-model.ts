import type { Attributes, TrackingMode } from './catalog.api';

/** Os mesmos formatos que o servidor exige: dinheiro com até 4 casas, quantidades com até 6, taxa de 0 a 1. */
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
const QUANTITY = /^\d{1,13}(\.\d{1,6})?$/;
const RATE = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/;

export const isMoney = (value: string): boolean => MONEY.test(value.trim());
export const isQuantity = (value: string): boolean => QUANTITY.test(value.trim());
export const isRate = (value: string): boolean => RATE.test(value.trim());

/** `true` se o texto for um decimal estritamente positivo (sem converter para `number`). */
export const isPositiveQuantity = (value: string): boolean =>
  isQuantity(value) && /[1-9]/.test(value);

/** «tamanho=M, cor=azul» → `{ tamanho: 'M', cor: 'azul' }`; `null` se algum par estiver mal formado. */
export function parseAttributes(text: string): Attributes | null {
  const result: Record<string, string> = {};
  for (const part of text.split(',')) {
    if (part.trim() === '') continue;
    const at = part.indexOf('=');
    const key = at < 0 ? '' : part.slice(0, at).trim();
    const value = at < 0 ? '' : part.slice(at + 1).trim();
    if (!key || !value) return null;
    result[key] = value;
  }
  return result;
}

export function formatAttributes(attributes: Attributes): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

export const TRACKING_LABEL: Readonly<Record<TrackingMode, string>> = {
  NONE: 'Sem rastreio',
  LOT: 'Por lote',
  SERIAL: 'Por número de série',
};

/** Um serviço nunca controla stock; lotes e séries exigem controlar stock. Devolve o problema, se houver. */
export function stockIssue(
  type: 'GOODS' | 'SERVICE',
  trackStock: boolean,
  tracking: TrackingMode,
): string | null {
  if (type === 'SERVICE' && (trackStock || tracking !== 'NONE')) {
    return 'Um serviço não controla nem rastreia stock.';
  }
  if (tracking !== 'NONE' && !trackStock) return 'Lotes e séries exigem controlar stock.';
  return null;
}

/** Dinheiro para apresentação: separa milhares sem passar por `number` (preserva todas as casas). */
export function formatDecimal(value: string): string {
  const [int = '0', frac] = value.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac === undefined ? grouped : `${grouped},${frac}`;
}

export const ERROR_TEXT: Readonly<Record<string, string>> = {
  SKU_TAKEN: 'Já existe uma variante com este SKU.',
  BARCODE_TAKEN: 'Já existe uma variante com este código de barras.',
  PRODUCT_CODE_TAKEN: 'Já existe um produto com este código.',
  PRICE_NOT_FOUND: 'Nenhuma tabela de preços aplicável a esta variante, organização, moeda e data.',
  PRICE_AMBIGUOUS:
    'Duas tabelas com a mesma prioridade dão preços diferentes: ajuste as prioridades.',
  VARIANT_INACTIVE: 'A variante está inactiva.',
  PRICE_TIER_EXISTS: 'Já existe um preço desta variante para esta quantidade mínima.',
  PRICE_LIST_NAME_TAKEN: 'Já existe uma tabela com este nome para a organização.',
  STOCK_MIGRATION_REQUIRED:
    'O produto tem movimentos de stock: a unidade e o controlo de stock exigem uma migração explícita.',
  DEFAULT_VARIANT_ACTIVE:
    'A variante por omissão não se desactiva enquanto o produto estiver activo.',
};

/** Texto de um erro da API: a mensagem própria do catálogo quando há código conhecido. */
export function catalogError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  const message = (error as { message?: string } | null)?.message;
  return message && message.length > 0 ? message : fallback;
}
