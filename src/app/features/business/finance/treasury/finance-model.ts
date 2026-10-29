import type { Tone } from '../../../../shared/ui/badge/badge';
import { documentError } from '../../sales/orders/orders-model';
import type {
  ObligationView,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
  SupplierInvoiceStatus,
} from './finance.api';

export { documentError, formatDecimal } from '../../sales/orders/orders-model';
export { isIsoDate, isMoney, isTaxRate } from '../../sales/billing/billing-model';

export const OBLIGATION_VIEW: Readonly<Record<ObligationView, { label: string; tone: Tone }>> = {
  OPEN: { label: 'Em aberto', tone: 'brand' },
  PARTIAL: { label: 'Parcialmente liquidado', tone: 'warning' },
  OVERDUE: { label: 'Vencido', tone: 'danger' },
  CLOSED: { label: 'Liquidado', tone: 'success' },
  CANCELLED: { label: 'Cancelado', tone: 'neutral' },
};

export const PAYMENT_STATUS: Readonly<Record<PaymentStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  PENDING: { label: 'Pendente', tone: 'brand' },
  CONFIRMED: { label: 'Confirmado', tone: 'success' },
  FAILED: { label: 'Falhado', tone: 'danger' },
  REVERSED: { label: 'Revertido', tone: 'warning' },
};

export const SUPPLIER_INVOICE_STATUS: Readonly<
  Record<SupplierInvoiceStatus, { label: string; tone: Tone }>
> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  VALIDATED: { label: 'Validada', tone: 'success' },
  DISPUTED: { label: 'Em disputa', tone: 'warning' },
  VOID: { label: 'Anulada', tone: 'danger' },
};

export const DIRECTION: Readonly<Record<PaymentDirection, string>> = {
  INBOUND: 'Recebimento',
  OUTBOUND: 'Pagamento',
};

export const METHOD: Readonly<Record<PaymentMethod, string>> = {
  CASH: 'Numerário',
  TRANSFER: 'Transferência',
  CARD: 'Cartão',
  OTHER: 'Outro',
};

export const SOURCE: Readonly<Record<string, string>> = {
  INVOICE: 'Factura',
  SUPPLIER_INVOICE: 'Factura de fornecedor',
  CREDIT_NOTE: 'Nota de crédito',
};

const FINANCE_ERRORS: Readonly<Record<string, string>> = {
  ACCOUNT_CODE_EXISTS: 'Já existe uma conta com este código.',
  ACCOUNT_INACTIVE: 'A conta de tesouraria está inactiva.',
  ACCOUNT_ORGANIZATION: 'A conta pertence a outra organização.',
  PAYMENT_STATE: 'O pagamento não está num estado que permita esta operação.',
  PAYMENT_NOT_APPLICABLE: 'O pagamento não se pode aplicar: veja os detalhes.',
  OVERPAYMENT: 'O montante excede o saldo em aberto da obrigação.',
  OBLIGATION_NOT_OPEN: 'A obrigação já não está em aberto.',
  OBLIGATION_MISMATCH: 'A obrigação pertence a outra entidade ou organização.',
  CURRENCY_MISMATCH: 'A moeda da conta não coincide com a da obrigação.',
  ALLOCATION_MISMATCH: 'A soma das alocações tem de igualar o montante.',
  IDEMPOTENCY_KEY_REUSED: 'Este pedido já foi feito com outros dados.',
  SUPPLIER_INVOICE_NUMBER_EXISTS: 'Este fornecedor já tem uma factura com este número.',
  SUPPLIER_INVOICE_STATE: 'A factura já não permite esta operação.',
  DUE_BEFORE_DATE: 'O vencimento não pode ser anterior à data da factura.',
  UNKNOWN_SUPPLIER: 'O fornecedor não existe.',
  CREDIT_LIMIT_EXCEEDED: 'A encomenda excede o limite de crédito do cliente.',
};

/** Texto de um erro da API: primeiro os códigos das finanças; depois os campos que falharam. */
export function financeError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && FINANCE_ERRORS[code]) return FINANCE_ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => FINANCE_ERRORS[f.code] ?? f.message).join(' ');
  }
  return documentError(error, fallback);
}
