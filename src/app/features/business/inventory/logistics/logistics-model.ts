import type { Tone } from '../../../../shared/ui/badge/badge';
import { documentError } from '../../sales/orders/orders-model';
import type {
  CountStatus,
  ReturnCondition,
  ReturnDirection,
  ReturnStatus,
  TransferStatus,
} from './logistics.api';

export { documentError, formatDecimal, trimQuantity } from '../../sales/orders/orders-model';

export const TRANSFER_STATUS: Readonly<Record<TransferStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  DISPATCHED: { label: 'Em trânsito', tone: 'brand' },
  PARTIAL_RECEIVED: { label: 'Parcialmente recebida', tone: 'warning' },
  RECEIVED: { label: 'Recebida', tone: 'success' },
  CANCELLED: { label: 'Cancelada', tone: 'danger' },
};

export const COUNT_STATUS: Readonly<Record<CountStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  OPEN: { label: 'A contar', tone: 'brand' },
  REVIEW: { label: 'Em revisão', tone: 'warning' },
  POSTED: { label: 'Lançada', tone: 'success' },
  CANCELLED: { label: 'Cancelada', tone: 'danger' },
};

export const RETURN_STATUS: Readonly<Record<ReturnStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  APPROVED: { label: 'Aprovada', tone: 'brand' },
  POSTED: { label: 'Lançada', tone: 'success' },
};

export const DIRECTION: Readonly<Record<ReturnDirection, string>> = {
  CUSTOMER: 'De cliente',
  SUPPLIER: 'A fornecedor',
};

export const CONDITION: Readonly<Record<ReturnCondition, string>> = {
  SELLABLE: 'Vendável',
  DAMAGED: 'Danificado',
  QUARANTINE: 'Quarentena',
};

const LOGISTICS_ERRORS: Readonly<Record<string, string>> = {
  SAME_WAREHOUSE: 'Origem e destino têm de ser diferentes.',
  DIFFERENT_ORGANIZATION: 'Os armazéns têm de ser da mesma organização.',
  WAREHOUSE_NOT_USABLE: 'O armazém está inactivo ou é técnico.',
  TRANSFER_EMPTY: 'Uma transferência sem linhas não se expede.',
  TRANSFER_NOT_DRAFT: 'Só uma transferência em rascunho se altera ou apaga.',
  TRANSFER_NOT_CANCELLABLE:
    'Depois de expedida a transferência já não se cancela: receba o que está em trânsito.',
  TRANSFER_NOT_RECEIVABLE:
    'Só se recebe uma transferência expedida que ainda tenha stock em trânsito.',
  EXCEEDS_IN_TRANSIT: 'A quantidade excede o que está em trânsito.',
  INSUFFICIENT_STOCK: 'Stock disponível insuficiente.',
  LOCATION_FROZEN: 'O local está congelado por uma contagem em curso.',
  COUNT_STATE: 'A contagem não está num estado que permita esta operação.',
  COUNT_POSTED: 'Uma contagem lançada não se cancela.',
  COUNT_LINE_EXISTS: 'Esse artigo já está na contagem.',
  UNCOUNTED_LINE: 'Há linhas por contar.',
  EXCEEDS_RETURNABLE: 'A quantidade excede o que ainda se pode devolver.',
  RETURN_NOT_APPROVABLE: 'A devolução excede o que ainda se pode devolver.',
  RETURN_NOT_APPROVED: 'Só se lança uma devolução aprovada.',
  RETURN_NOT_DRAFT: 'Só uma devolução em rascunho se altera ou apaga.',
  RETURN_EMPTY: 'Uma devolução sem linhas não se aprova.',
  UNKNOWN_SOURCE: 'O documento de origem não existe, não moveu stock ou foi revertido.',
  UNKNOWN_SOURCE_LINE: 'A linha não pertence ao documento de origem.',
  WAREHOUSE_TECHNICAL: 'Um armazém técnico não pode ser o de vendas.',
};

/** Texto de um erro da API: primeiro os códigos da logística; depois os campos que falharam. */
export function logisticsError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && LOGISTICS_ERRORS[code]) return LOGISTICS_ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => LOGISTICS_ERRORS[f.code] ?? f.message).join(' ');
  }
  return documentError(error, fallback);
}

/** Quantidade positiva em texto, até 6 casas. */
export const isPositiveQty = (value: string): boolean =>
  /^\d{1,13}(\.\d{1,6})?$/.test(value.trim()) && /[1-9]/.test(value);

/** Quantidade não negativa em texto, até 6 casas. */
export const isQty = (value: string): boolean => /^\d{1,13}(\.\d{1,6})?$/.test(value.trim());
