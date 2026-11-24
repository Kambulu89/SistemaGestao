/** Integração fiscal electrónica (10.9): só SIMULAÇÃO — nada é enviado à AGT. */

export interface IntegrationEntity {
  legalEntity: { id: string; code: string; name: string; taxId: string | null };
  provider: string;
  simulatorScenario: string;
  maxAttempts: number;
  contingency: boolean;
  contingencyReason: string | null;
  contingencySince: string | null;
  version: number;
  counts: Record<string, number>;
  canManage: boolean;
}

export interface IntegrationSettings {
  providers: { code: string; label: string; available: boolean; reason: string | null }[];
  scenarios: string[];
  payloadFormat: string;
  entities: IntegrationEntity[];
}

export interface SubmissionRow {
  id: string;
  documentType: 'SALES_INVOICE' | 'SALES_NOTE';
  documentId: string;
  documentNumber: string;
  legalEntity: string;
  provider: string;
  status: string;
  attempts: number;
  resultCode: string | null;
  resultMessage: string | null;
  inContingency: boolean;
  nextAttemptAt: string | null;
  createdAt: string;
}

export interface Submission {
  id: string;
  version: number;
  legalEntity: { id: string; code: string };
  documentType: 'SALES_INVOICE' | 'SALES_NOTE';
  documentId: string;
  documentNumber: string;
  provider: string;
  providerLabel: string;
  environment: string;
  payloadFormat: string;
  payload: unknown;
  payloadHash: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
  failures: number;
  nextAttemptAt: string | null;
  requestId: string | null;
  resultCode: string | null;
  resultMessage: string | null;
  validationIssues: { path: string; code: string; message: string }[];
  inContingency: boolean;
  sentAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  history: {
    attemptNo: number;
    action: string;
    outcome: string;
    code: string | null;
    message: string | null;
    durationMs: number | null;
    at: string;
    by: string | null;
  }[];
  can: { process: boolean; requeue: boolean };
}

export const SUBMISSION_STATUS: Record<string, string> = {
  QUEUED: 'Na fila',
  SENDING: 'Em envio',
  AWAITING: 'A aguardar resposta',
  ACCEPTED: 'Aceite (simulação)',
  REJECTED: 'Rejeitada (simulação)',
  FAILED: 'Falhou — repetir',
  INVALID: 'Inválida (validação local)',
  CONTINGENCY: 'Retida em contingência',
};
export const SCENARIO: Record<string, string> = {
  ACCEPT: 'Aceitar',
  REJECT: 'Rejeitar',
  DELAYED: 'Aceitar com atraso',
  UNAVAILABLE: 'Indisponível (falhas transitórias)',
};
export const DOC_TYPE: Record<string, string> = {
  SALES_INVOICE: 'Factura / factura-recibo',
  SALES_NOTE: 'Nota de crédito/débito',
};
export const ATTEMPT_ACTION: Record<string, string> = {
  VALIDATE: 'Validação local',
  SUBMIT: 'Envio',
  POLL: 'Consulta',
  REQUEUE: 'Reposta na fila',
  CONTINGENCY: 'Contingência',
};

export function submissionTone(s: string): string {
  if (s === 'ACCEPTED') return 'bg-success-soft text-success-text';
  if (s === 'REJECTED' || s === 'FAILED' || s === 'INVALID')
    return 'bg-danger-soft text-danger-text';
  if (s === 'CONTINGENCY' || s === 'QUEUED' || s === 'AWAITING' || s === 'SENDING')
    return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

/** Ligação da submissão ao documento de origem. */
export const documentLink = (s: { documentType: string; documentId: string }) =>
  s.documentType === 'SALES_INVOICE'
    ? ['/vendas/facturas', s.documentId]
    : ['/vendas/notas', s.documentId];

export const INTEGRATION_NOTICE =
  'Integração em SIMULAÇÃO: o simulador local responde em lugar da AGT e nada é enviado. O formato do payload é interno (não é o oficial) e uma resposta "aceite" não é uma validação da AGT. O adaptador oficial está bloqueado até haver especificação verificada e certificação.';
