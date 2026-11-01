import type { Tone } from '../../../../shared/ui/badge/badge';
import type { OrderStatus, QuoteStatus, ShipmentStatus } from './orders.api';

/** Quantidade positiva em texto (até 6 casas), o mesmo formato que o servidor exige. */
export const isPositiveQuantity = (value: string): boolean =>
  /^\d{1,13}(\.\d{1,6})?$/.test(value.trim()) && /[1-9]/.test(value);

/** Taxa de desconto 0..1 em texto (até 4 casas). */
export const isRate = (value: string): boolean =>
  /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/.test(value.trim());

export const QUOTE_STATUS: Readonly<Record<QuoteStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  SENT: { label: 'Enviada', tone: 'brand' },
  ACCEPTED: { label: 'Aceite', tone: 'success' },
  REJECTED: { label: 'Rejeitada', tone: 'danger' },
  EXPIRED: { label: 'Expirada', tone: 'warning' },
};

export const ORDER_STATUS: Readonly<Record<OrderStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  CONFIRMED: { label: 'Confirmada', tone: 'brand' },
  PARTIAL: { label: 'Parcialmente expedida', tone: 'warning' },
  FULFILLED: { label: 'Concluída', tone: 'success' },
  CANCELLED: { label: 'Cancelada', tone: 'danger' },
};

export const SHIPMENT_STATUS: Readonly<Record<ShipmentStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  POSTED: { label: 'Lançada', tone: 'success' },
  REVERSED: { label: 'Revertida', tone: 'warning' },
};

export const ERROR_TEXT: Readonly<Record<string, string>> = {
  QUOTE_NOT_DRAFT: 'Só uma proposta em rascunho se altera.',
  ORDER_NOT_DRAFT: 'Só uma encomenda em rascunho se altera.',
  QUOTE_EMPTY: 'Uma proposta sem linhas não se envia.',
  ORDER_EMPTY: 'Uma encomenda sem linhas não se confirma.',
  QUOTE_EXPIRED: 'A proposta expirou.',
  ORDER_CANCELLED: 'A encomenda está cancelada.',
  ORDER_NOT_CANCELLABLE: 'Uma encomenda já expedida não se cancela: reverta as expedições.',
  CUSTOMER_BLOCKED: 'O cliente está bloqueado: não aceita novas confirmações de venda.',
  CUSTOMER_INACTIVE: 'O cliente está inactivo: não aceita novas confirmações de venda.',
  SEQUENCE_NOT_CONFIGURED:
    'Não há sequência de numeração configurada para este documento (Configurações → Sequências).',
  PRICE_NOT_FOUND: 'Não há preço aplicável a esta variante, moeda e data.',
  PRICE_AMBIGUOUS: 'Duas tabelas de preços com a mesma prioridade: ajuste as prioridades.',
  DISCOUNT_EXCEEDS: 'O desconto ultrapassa o máximo permitido para este preço.',
  NO_TAX_RATE: 'Não há taxa de imposto válida para a categoria do produto.',
  ORDER_NOT_SHIPPABLE: 'Só se expede uma encomenda confirmada que ainda tenha saldo por expedir.',
  SHIPMENT_NOT_DRAFT: 'Só uma expedição em rascunho se altera ou apaga.',
  SHIPMENT_EMPTY: 'Uma expedição sem linhas não se lança.',
  SHIPMENT_REVERSED: 'A expedição já foi revertida.',
  SHIPMENT_NOT_POSTED: 'Só uma expedição lançada se reverte.',
  SHIPMENT_LINE_DUPLICATE: 'Esta linha da encomenda já está na expedição.',
  PERMISSION_DENIED: 'Não tem permissão para esta operação.',
};

/** Texto de um erro da API: a mensagem própria quando há código conhecido; senão os campos que falharam. */
export function documentError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => ERROR_TEXT[f.code] ?? f.message).join(' ');
  }
  const message = (error as { message?: string } | null)?.message;
  return message && message.length > 0 ? message : fallback;
}

/** Decimais para apresentação: separa milhares sem passar por `number`. */
export function formatDecimal(value: string): string {
  const [int = '0', frac] = value.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac === undefined ? grouped : `${grouped},${frac}`;
}

/** Quantidade sem zeros à direita das casas (1.000000 → 1; 2.500000 → 2,5). */
export function trimQuantity(value: string): string {
  const [int = '0', frac = ''] = value.split('.');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${int},${trimmed}` : int;
}

/** `a − b` em decimais de texto (até 6 casas), sem passar por `number`; nunca negativo. */
export function remainingQuantity(ordered: string, shipped: string): string {
  const scaled = (value: string): bigint => {
    const [int = '0', frac = ''] = value.split('.');
    return BigInt(int + frac.padEnd(6, '0').slice(0, 6));
  };
  const left = scaled(ordered) - scaled(shipped);
  if (left <= 0n) return '0';
  const digits = left.toString().padStart(7, '0');
  const int = digits.slice(0, -6);
  const frac = digits.slice(-6).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** `true` se `quantity` (positiva) não ultrapassa `max`, comparando como decimais exactos. */
export function withinQuantity(quantity: string, max: string): boolean {
  const scaled = (value: string): bigint => {
    const [int = '0', frac = ''] = value.trim().split('.');
    return BigInt(int + frac.padEnd(6, '0').slice(0, 6));
  };
  return isPositiveQuantity(quantity) && scaled(quantity) <= scaled(max);
}
