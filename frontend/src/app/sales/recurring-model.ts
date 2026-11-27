/** Facturação recorrente (10.11): contratos, versões de preço e períodos gerados (só rascunhos). */

export interface RecurringRow {
  id: string;
  reference: string;
  description: string;
  customer: { code: string; name: string };
  legalEntity: string;
  currency: string;
  frequency: string;
  startDate: string;
  endDate: string | null;
  nextInvoiceDate: string | null;
  periodsGenerated: number;
  status: string;
}

export interface RecurringLine {
  productId: string;
  sku: string;
  name: string;
  description: string | null;
  quantity: string;
  unitPrice: string | null;
  taxCodeIds: string[];
  exemptionCode: string | null;
}

export interface RecurringVersion {
  id: string;
  version: number;
  versionNo: number;
  validFrom: string;
  status: string;
  notes: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  lines: RecurringLine[];
  can: { edit: boolean; approve: boolean; discard: boolean };
}

export interface Recurring {
  id: string;
  version: number;
  reference: string;
  description: string;
  legalEntity: { id: string; code: string };
  customer: { id: string; code: string; name: string; status: string };
  currency: string;
  frequency: string;
  billingTiming: string;
  startDate: string;
  endDate: string | null;
  paymentTermsDays: number;
  periodsGenerated: number;
  status: string;
  statusReason: string | null;
  versions: RecurringVersion[];
  runs: {
    id: string;
    periodIndex: number;
    periodStart: string;
    periodEnd: string;
    invoiceDate: string;
    versionNo: number | null;
    status: string;
    reason: string | null;
    invoice: { id: string; number: string | null; status: string; payable: string } | null;
    at: string;
  }[];
  schedule: {
    index: number;
    periodStart: string;
    periodEnd: string;
    invoiceDate: string;
    versionNo: number | null;
    due: boolean;
  }[];
  can: Record<
    'edit' | 'addVersion' | 'activate' | 'suspend' | 'resume' | 'end' | 'generate',
    boolean
  >;
}

export interface RecurringOptions {
  legalEntities: { id: string; code: string; name: string; countryCode: string }[];
  taxCodes: { id: string; code: string; name: string; kind: string; countryCode: string }[];
  exemptions: { code: string; description: string; countryCode: string }[];
}

export const FREQUENCY: Record<string, string> = {
  MONTHLY: 'Mensal',
  QUARTERLY: 'Trimestral',
  SEMIANNUAL: 'Semestral',
  ANNUAL: 'Anual',
};
export const TIMING: Record<string, string> = {
  ADVANCE: 'No início do período',
  ARREARS: 'No fim do período',
};
export const RECURRING_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho',
  ACTIVE: 'Activo',
  SUSPENDED: 'Suspenso',
  ENDED: 'Terminado',
};
export const VERSION_STATUS: Record<string, string> = {
  DRAFT: 'Por aprovar',
  APPROVED: 'Aprovada',
  DISCARDED: 'Descartada',
};

export function recurringTone(s: string): string {
  if (s === 'ACTIVE' || s === 'APPROVED' || s === 'GENERATED')
    return 'bg-success-soft text-success-text';
  if (s === 'DRAFT' || s === 'SUSPENDED') return 'bg-warning-soft text-warning-text';
  if (s === 'FAILED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}
