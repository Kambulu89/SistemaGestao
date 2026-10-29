import type { Tone } from '../../../../shared/ui/badge/badge';
import { documentError } from '../../sales/orders/orders-model';
import type {
  PurchaseStatus,
  ReceiptStatus,
  RequisitionStatus,
  SupplierStatus,
} from './purchasing.api';

export {
  documentError,
  formatDecimal,
  isPositiveQuantity,
  trimQuantity,
} from '../../sales/orders/orders-model';
export { isIsoDate, isMoney, isTaxRate } from '../../sales/billing/billing-model';

export const SUPPLIER_STATUS: Readonly<Record<SupplierStatus, { label: string; tone: Tone }>> = {
  ACTIVE: { label: 'Activo', tone: 'success' },
  BLOCKED: { label: 'Bloqueado', tone: 'danger' },
  INACTIVE: { label: 'Inactivo', tone: 'neutral' },
};

export const REQUISITION_STATUS: Readonly<
  Record<RequisitionStatus, { label: string; tone: Tone }>
> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  SUBMITTED: { label: 'Submetida', tone: 'brand' },
  APPROVED: { label: 'Aprovada', tone: 'success' },
  REJECTED: { label: 'Rejeitada', tone: 'danger' },
  CONVERTED: { label: 'Convertida', tone: 'success' },
};

export const PURCHASE_STATUS: Readonly<Record<PurchaseStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  ORDERED: { label: 'Encomendada', tone: 'brand' },
  PARTIAL: { label: 'Parcialmente recebida', tone: 'warning' },
  RECEIVED: { label: 'Recebida', tone: 'success' },
  CANCELLED: { label: 'Cancelada', tone: 'danger' },
};

export const RECEIPT_STATUS: Readonly<Record<ReceiptStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  POSTED: { label: 'Lançada', tone: 'success' },
  REVERSED: { label: 'Revertida', tone: 'warning' },
};

const PURCHASING_ERRORS: Readonly<Record<string, string>> = {
  SUPPLIER_CODE_EXISTS: 'Já existe um fornecedor com este código.',
  SUPPLIER_EXISTS: 'Esta pessoa ou organização já é fornecedora desta organização.',
  SUPPLIER_BLOCKED: 'O fornecedor está bloqueado: não recebe novas encomendas.',
  SUPPLIER_INACTIVE: 'O fornecedor está inactivo: não recebe novas encomendas.',
  REASON_REQUIRED: 'Indique o motivo (até 300 caracteres).',
  REQUISITION_NOT_DRAFT: 'Só uma requisição em rascunho se altera ou apaga.',
  REQUISITION_EMPTY: 'Uma requisição sem linhas não se submete.',
  REQUISITION_NOT_SUBMITTED: 'Só se decide uma requisição submetida e ainda sem decisão.',
  REQUISITION_NOT_APPROVED: 'Só se converte uma requisição aprovada.',
  REQUISITION_LINE_DUPLICATE: 'Esta variante já está na requisição.',
  SEGREGATION_OF_DUTIES: 'Quem pediu a requisição não a pode aprovar nem rejeitar.',
  COST_REQUIRED: 'Indique o custo de todas as linhas da requisição.',
  PURCHASE_ORDER_NOT_DRAFT: 'Só uma encomenda em rascunho se altera ou apaga.',
  PURCHASE_ORDER_FROM_REQUISITION: 'Uma encomenda criada de uma requisição não se apaga.',
  PURCHASE_ORDER_EMPTY: 'Uma encomenda sem linhas não se confirma.',
  PURCHASE_ORDER_CANCELLED: 'A encomenda está cancelada.',
  PURCHASE_ORDER_NOT_CONFIRMED: 'Um rascunho apaga-se; só se cancela uma encomenda confirmada.',
  PURCHASE_ORDER_HAS_RECEIPTS:
    'Uma encomenda já recebida (total ou parcialmente) não se cancela: reverta as recepções.',
  PURCHASE_ORDER_NOT_RECEIVABLE: 'Só se recebe uma encomenda confirmada que ainda tenha saldo.',
  GOODS_RECEIPT_NOT_DRAFT: 'Só uma recepção em rascunho se altera ou apaga.',
  GOODS_RECEIPT_EMPTY: 'Uma recepção sem linhas não se lança.',
  GOODS_RECEIPT_REVERSED: 'A recepção já foi revertida.',
  GOODS_RECEIPT_NOT_POSTED: 'Só uma recepção lançada se reverte.',
  GOODS_RECEIPT_LINE_DUPLICATE: 'Esta linha da encomenda já está na recepção.',
  EXCEEDS_BALANCE: 'A quantidade ultrapassa o que ainda falta receber.',
  WAREHOUSE_REQUIRED: 'Indique o armazém: há produtos com controlo de stock.',
  NO_LOCATION: 'O armazém não tem nenhum local activo.',
  LOT_REQUIRED: 'Este produto exige o código do lote.',
  UNKNOWN_WAREHOUSE: 'O armazém não existe nesta organização.',
  UNKNOWN_VARIANT: 'A variante não existe ou está inactiva.',
  UNKNOWN_SUPPLIER: 'O fornecedor não existe.',
  INSUFFICIENT_STOCK: 'O stock recebido já foi consumido: não se pode reverter.',
};

/** Texto de um erro da API: primeiro os códigos das compras; depois os das encomendas e os campos que falharam. */
export function purchasingError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && PURCHASING_ERRORS[code]) return PURCHASING_ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => PURCHASING_ERRORS[f.code] ?? f.message).join(' ');
  }
  return documentError(error, fallback);
}
