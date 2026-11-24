/** Motor fiscal e séries (10.5): tipos e rótulos. Nenhum valor legal pré-carregado. */

export type FiscalStatus = 'DRAFT' | 'CONFIRMED' | 'RETIRED';

export interface TaxCodeRow {
  id: string;
  countryCode: string;
  code: string;
  name: string;
  kind: 'TAX' | 'WITHHOLDING';
  taxType: string;
  status: string;
  confirmedRates: number;
  draftRates: number;
}

export interface TaxRate {
  id: string;
  version: number;
  legalEntity: { id: string; code: string } | null;
  validFrom: string;
  validTo: string | null;
  rate: string;
  minBase: string | null;
  legalSource: string;
  notes: string | null;
  status: FiscalStatus;
  createdBy: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  retiredReason: string | null;
  can: { edit: boolean; confirm: boolean; retire: boolean };
}

export interface TaxCode extends Omit<TaxCodeRow, 'confirmedRates' | 'draftRates'> {
  version: number;
  rates: TaxRate[];
  can: { manage: boolean; confirm: boolean };
}

export interface TaxExemption {
  id: string;
  version: number;
  countryCode: string;
  code: string;
  description: string;
  legalSource: string;
  status: FiscalStatus;
  createdBy: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  retiredReason: string | null;
  can: { edit: boolean; confirm: boolean; retire: boolean };
}

export interface FiscalSeries {
  id: string;
  version: number;
  legalEntity: { id: string; code: string };
  documentKind: string;
  fiscalCode: string;
  code: string;
  fiscalYear: number;
  prefix: string;
  padding: number;
  nextNumber: number;
  next: string;
  lastIssueDate: string | null;
  issued: number;
  mode: 'SIMULATION' | 'PRODUCTION';
  status: 'DRAFT' | 'ACTIVE' | 'CLOSED';
  authorityReference: string | null;
  closedReason: string | null;
  can: { edit: boolean; activate: boolean; close: boolean };
}

export interface TaxSimulation {
  rounding: 'LINE' | 'DOCUMENT';
  mode: 'SIMULATION';
  summary: {
    codeId: string;
    code: string;
    kind: string;
    rate: string;
    exemptionCode: string | null;
    base: string;
    amount: string;
    applied: boolean;
  }[];
  totals: { net: string; tax: string; gross: string; withholding: string; payable: string };
  ratesUsed: { codeId: string; code: string; rate: string; legalSource: string }[];
}

export const TAX_KIND: Record<string, string> = { TAX: 'Imposto', WITHHOLDING: 'Retenção' };
export const TAX_TYPE: Record<string, string> = {
  VAT: 'Imposto sobre o consumo',
  STAMP: 'Imposto do selo',
  INCOME: 'Imposto sobre rendimentos',
  OTHER: 'Outro',
};
export const FISCAL_STATUS: Record<FiscalStatus, string> = {
  DRAFT: 'Por confirmar',
  CONFIRMED: 'Confirmada',
  RETIRED: 'Retirada',
};
export const SERIES_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho',
  ACTIVE: 'Activa',
  CLOSED: 'Fechada',
};
export const DOCUMENT_KIND: Record<string, string> = {
  INVOICE: 'Factura',
  INVOICE_RECEIPT: 'Factura-recibo',
  CREDIT_NOTE: 'Nota de crédito',
  DEBIT_NOTE: 'Nota de débito',
  RECEIPT: 'Recibo',
};
export const ROUNDING: Record<string, string> = {
  LINE: 'Por linha',
  DOCUMENT: 'Por documento',
};

export function fiscalTone(s: string): string {
  if (s === 'CONFIRMED' || s === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (s === 'DRAFT') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

/** Taxa para mostrar ("14.0000" → "14 %", "6.5000" → "6,5 %"). */
export function ratePct(v: string): string {
  const s = v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
  return `${s.replace('.', ',')} %`;
}

/** Aviso fixo dos ecrãs fiscais: sem certificação nem comunicação com a autoridade tributária. */
export const SIMULATION_NOTICE =
  'Modo de simulação: o sistema não está certificado e não comunica com a AGT. Os números e cálculos servem só para teste.';
