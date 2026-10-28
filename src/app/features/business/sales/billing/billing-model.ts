import type { Tone } from '../../../../shared/ui/badge/badge';
import { documentError } from '../orders/orders-model';
import type {
  ContractStatus,
  ContractType,
  CreditNoteStatus,
  InvoiceStatus,
  RenewalMode,
} from './billing.api';

export { documentError, formatDecimal, trimQuantity } from '../orders/orders-model';

export const INVOICE_STATUS: Readonly<Record<InvoiceStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  ISSUED: { label: 'Emitida', tone: 'success' },
  CREDITED: { label: 'Creditada', tone: 'warning' },
};

export const CREDIT_NOTE_STATUS: Readonly<Record<CreditNoteStatus, { label: string; tone: Tone }>> =
  {
    DRAFT: { label: 'Rascunho', tone: 'neutral' },
    ISSUED: { label: 'Emitida', tone: 'success' },
  };

export const CONTRACT_STATUS: Readonly<Record<ContractStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  ACTIVE: { label: 'Em vigor', tone: 'success' },
  EXPIRED: { label: 'Expirado', tone: 'warning' },
  TERMINATED: { label: 'Terminado', tone: 'danger' },
};

export const CONTRACT_TYPE: Readonly<Record<ContractType, string>> = {
  SALES: 'Venda',
  PURCHASE: 'Compra',
  SERVICE: 'Serviço',
};

export const RENEWAL: Readonly<Record<RenewalMode, string>> = {
  NONE: 'Sem renovação',
  MANUAL: 'Renovação manual',
  AUTO: 'Renovação automática',
};

const BILLING_ERRORS: Readonly<Record<string, string>> = {
  INVOICE_NOT_DRAFT:
    'Só uma factura em rascunho se altera ou apaga: uma emitida corrige-se com uma nota de crédito.',
  INVOICE_EMPTY: 'Uma factura sem linhas não se emite.',
  DUE_BEFORE_ISSUE: 'O vencimento não pode ser anterior à data de emissão.',
  ORDER_NOT_BILLABLE: 'Só se factura uma encomenda confirmada (ou parcial/totalmente expedida).',
  NOTHING_TO_INVOICE: 'Esta encomenda não tem nada por facturar.',
  EXCEEDS_BILLABLE: 'A quantidade ultrapassa o que ainda se pode facturar.',
  INVOICE_NOT_ISSUABLE: 'A factura já não pode ser emitida: a quantidade foi facturada entretanto.',
  INVOICE_LINE_DUPLICATE: 'Esta linha da encomenda já está na factura.',
  ORDER_LINE_REQUIRED: 'Uma factura de encomenda só tem linhas da encomenda.',
  EXEMPTION_REQUIRED: 'Uma linha sem imposto exige o motivo da isenção.',
  INVOICE_NOT_ISSUED: 'Só se credita uma factura emitida.',
  INVOICE_FULLY_CREDITED: 'A factura já está toda creditada.',
  EXCEEDS_CREDITABLE: 'O crédito ultrapassa o que ainda falta creditar.',
  CREDIT_NOTE_NOT_DRAFT: 'Só uma nota de crédito em rascunho se altera ou apaga.',
  CREDIT_NOTE_EMPTY: 'Uma nota de crédito sem linhas não se emite.',
  CREDIT_NOTE_NOT_ISSUABLE: 'A nota já não pode ser emitida: o valor foi creditado entretanto.',
  CREDIT_LINE_DUPLICATE: 'Esta linha da factura já está na nota.',
  CONTRACT_NOT_ACTIVE: 'Só se factura ao abrigo de um contrato em vigor.',
  CONTRACT_MISMATCH: 'O contrato tem de ser de venda ou serviço do mesmo cliente.',
  CONTRACT_TERMINATED: 'Um contrato terminado não se altera nem reactiva.',
  CONTRACT_FIELD_LOCKED:
    'Num contrato activo não se mudam a contraparte, o tipo, o início nem a moeda.',
  END_BEFORE_START: 'O fim não pode ser anterior ao início.',
  END_REQUIRED: 'Um contrato renovável precisa de data de fim.',
  UNKNOWN_CUSTOMER: 'O cliente não existe.',
  UNKNOWN_PARTY: 'A contraparte não existe.',
};

/** Texto de um erro da API: primeiro os códigos da facturação; depois os das encomendas e os campos que falharam. */
export function billingError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && BILLING_ERRORS[code]) return BILLING_ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => BILLING_ERRORS[f.code] ?? f.message).join(' ');
  }
  return documentError(error, fallback);
}

/** Data AAAA-MM-DD válida (calendário real). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Dinheiro não negativo com até 4 casas, em texto. */
export const isMoney = (value: string): boolean => /^\d{1,15}(\.\d{1,4})?$/.test(value.trim());

/** Taxa de imposto em percentagem, com até 4 casas. */
export const isTaxRate = (value: string): boolean => /^\d{1,3}(\.\d{1,4})?$/.test(value.trim());

/** `true` se a taxa em texto é zero (a linha exige motivo de isenção). */
export const isZeroRate = (value: string): boolean => isTaxRate(value) && !/[1-9]/.test(value);
