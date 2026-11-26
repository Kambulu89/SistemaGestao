/** Cobranças (10.10): contas a receber calculadas dos documentos; promessas e contactos. */

export type Aging = Record<'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS', string>;

export interface CollectionRow {
  customer: { id: string; code: string; name: string; status: string };
  legalEntity: { id: string; code: string };
  currency: string;
  open: string;
  overdue: string;
  aging: Aging;
  oldestDueDate: string;
  maxDaysOverdue: number;
  invoices: number;
  creditLimit: string | null;
  lastActivity: { at: string; kind: string; outcome: string } | null;
  nextActionDate: string | null;
  openPromises: number;
  brokenPromises: number;
}

export interface Promise_ {
  id: string;
  version: number;
  legalEntityId: string;
  currency: string;
  amount: string;
  promisedDate: string;
  invoiceIds: string[];
  contactName: string | null;
  notes: string | null;
  paidSince: string;
  status: 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';
  cancelReason: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface Statement {
  customer: {
    id: string;
    code: string;
    name: string;
    status: string;
    currency: string;
    paymentTermsDays: number;
  };
  contacts: { name: string; role: string | null; email: string | null; phone: string | null }[];
  credit: {
    currency: string;
    limit: string | null;
    receivables: string;
    openOrders: string;
    exposure: string;
    available: string | null;
    exceeded: boolean;
    missingRates: string[];
  };
  receivables: {
    asOf: string;
    summary: {
      legalEntityId: string;
      currency: string;
      open: string;
      overdue: string;
      aging: Aging;
      advances: string;
      credits: string;
      net: string;
    }[];
    invoices: {
      id: string;
      number: string;
      legalEntity: { id: string; code: string };
      currency: string;
      invoiceDate: string;
      dueDate: string;
      daysOverdue: number;
      bucket: keyof Aging;
      payable: string;
      adjusted: string;
      paid: string;
      open: string;
    }[];
    advances: {
      receiptId: string;
      number: string;
      legalEntityId: string;
      currency: string;
      remaining: string;
    }[];
    credits: {
      noteId: string;
      number: string;
      legalEntityId: string;
      currency: string;
      available: string;
    }[];
  };
  promises: Promise_[];
  activities: {
    id: string;
    legalEntityId: string;
    kind: string;
    contactName: string | null;
    outcome: string;
    notes: string;
    nextActionDate: string | null;
    promiseId: string | null;
    at: string;
    by: string | null;
  }[];
  legalEntities: { id: string; code: string; canManage: boolean }[];
}

export const BUCKET: Record<string, string> = {
  CURRENT: 'Por vencer',
  D1_30: '1–30 dias',
  D31_60: '31–60 dias',
  D61_90: '61–90 dias',
  D90_PLUS: 'Mais de 90 dias',
};
export const PROMISE_STATUS: Record<string, string> = {
  OPEN: 'Em aberto',
  KEPT: 'Cumprida',
  BROKEN: 'Falhada',
  CANCELLED: 'Anulada',
};
export const ACTIVITY_KIND: Record<string, string> = {
  CALL: 'Chamada',
  EMAIL: 'Email',
  VISIT: 'Visita',
  LETTER: 'Carta',
  NOTE: 'Nota',
};
export const ACTIVITY_OUTCOME: Record<string, string> = {
  REACHED: 'Contactado',
  NO_ANSWER: 'Sem resposta',
  PROMISED: 'Prometeu pagar',
  DISPUTED: 'Contesta a dívida',
  PAID_CLAIMED: 'Diz que já pagou',
  OTHER: 'Outro',
};

export function promiseTone(s: string): string {
  if (s === 'KEPT') return 'bg-success-soft text-success-text';
  if (s === 'BROKEN') return 'bg-danger-soft text-danger-text';
  if (s === 'OPEN') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}
export function bucketTone(b: string): string {
  if (b === 'CURRENT') return 'bg-surface-2 text-muted';
  if (b === 'D1_30') return 'bg-warning-soft text-warning-text';
  return 'bg-danger-soft text-danger-text';
}
