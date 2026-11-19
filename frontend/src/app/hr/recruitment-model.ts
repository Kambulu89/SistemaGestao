/** Recrutamento e onboarding (7.2): tipos da API, textos e regras de apresentação (a API decide sempre). */

export type RequisitionStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'OPEN' | 'FILLED' | 'CLOSED' | 'CANCELLED';
export type Stage =
  'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED' | 'WITHDRAWN';
export type OfferStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'ACCEPTED' | 'DECLINED' | 'HIRED' | 'CANCELLED';
export type OnboardingCategory = 'DOCUMENTS' | 'ACCOUNT' | 'ACCESS' | 'EQUIPMENT' | 'OTHER';

export interface Requisition {
  id: string;
  version: number;
  code: string;
  title: string;
  legalEntityId: string;
  branchId: string | null;
  departmentId: string | null;
  positionId: string;
  requirements: string | null;
  justification: string | null;
  quantity: number;
  deadline: string | null;
  currency: string;
  salaryMin: string;
  salaryMax: string;
  status: RequisitionStatus;
  approvalRequestId: string | null;
  rejectionReason: string | null;
  legalEntity: { code: string; name: string };
  branchName: string | null;
  departmentName: string | null;
  position: { code: string; name: string };
  applicationsCount: number;
  hiredCount: number;
  stageCounts?: Partial<Record<Stage, number>>;
  approvalMode?: 'WORKFLOW' | 'DIRECT';
  access?: { manage: boolean; approve: boolean };
  [key: string]: unknown;
}

export interface Candidate {
  id: string;
  version: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  notes: string | null;
  applicationsCount?: number;
  applications?: {
    id: string;
    stage: Stage;
    createdAt: string;
    requisition: { id: string; code: string; title: string };
  }[];
  access?: { manage: boolean };
  [key: string]: unknown;
}

export interface Interview {
  id: string;
  version: number;
  applicationId: string;
  scheduledAt: string;
  durationMinutes: number;
  mode: 'ONSITE' | 'VIDEO' | 'PHONE';
  location: string | null;
  interviewer: { membershipId: string; name: string };
  status: 'SCHEDULED' | 'DONE' | 'CANCELLED';
  evaluated: boolean;
  candidateName?: string;
  requisition?: { code: string; title: string };
}

export interface Evaluation {
  id: string;
  interviewId: string | null;
  evaluator: { membershipId: string; name: string };
  score: number;
  recommendation: 'HIRE' | 'HOLD' | 'REJECT';
  comments: string | null;
  createdAt: string;
}

export interface Offer {
  id: string;
  version: number;
  applicationId: string;
  currency: string;
  salary: string;
  startDate: string;
  expiresOn: string | null;
  conditions: string | null;
  status: OfferStatus;
  approvalRequestId: string | null;
  rejectionReason: string | null;
  employeeId: string | null;
  canApprove?: boolean;
}

export interface Application {
  id: string;
  version: number;
  stage: Stage;
  stageReason: string | null;
  employeeId: string | null;
  candidate: { id: string; fullName: string; email: string | null; phone: string | null };
  requisition: {
    id: string;
    code: string;
    title: string;
    status: RequisitionStatus;
    currency: string;
    salaryMin: string;
    salaryMax: string;
  };
  averageScore: string | null;
  evaluationsCount: number;
  createdAt: string;
  interviews?: Interview[];
  evaluations?: Evaluation[];
  offers?: Offer[];
  offerApprovalMode?: 'WORKFLOW' | 'DIRECT';
  access?: { manage: boolean; approve: boolean };
  [key: string]: unknown;
}

export interface OnboardingTask {
  id: string;
  version: number;
  employeeId: string;
  category: OnboardingCategory;
  title: string;
  dueDate: string | null;
  assignee: { membershipId: string; name: string } | null;
  status: 'PENDING' | 'DONE' | 'NOT_APPLICABLE';
  notes: string | null;
  completedAt: string | null;
}

export const REQUISITION_STATUS: Record<RequisitionStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Aguarda aprovação',
  OPEN: 'Aberta',
  FILLED: 'Preenchida',
  CLOSED: 'Fechada',
  CANCELLED: 'Cancelada',
};
export const STAGE: Record<Stage, string> = {
  APPLIED: 'Recebida',
  SCREENING: 'Triagem',
  INTERVIEW: 'Entrevista',
  OFFER: 'Proposta',
  HIRED: 'Contratado',
  REJECTED: 'Recusada',
  WITHDRAWN: 'Desistiu',
};
export const OFFER_STATUS: Record<OfferStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Aguarda aprovação',
  APPROVED: 'Aprovada',
  ACCEPTED: 'Aceite',
  DECLINED: 'Recusada pelo candidato',
  HIRED: 'Contratado',
  CANCELLED: 'Cancelada',
};
export const INTERVIEW_MODE: Record<Interview['mode'], string> = {
  ONSITE: 'Presencial',
  VIDEO: 'Vídeo',
  PHONE: 'Telefone',
};
export const INTERVIEW_STATUS: Record<Interview['status'], string> = {
  SCHEDULED: 'Marcada',
  DONE: 'Realizada',
  CANCELLED: 'Cancelada',
};
export const RECOMMENDATION: Record<Evaluation['recommendation'], string> = {
  HIRE: 'Contratar',
  HOLD: 'Aguardar',
  REJECT: 'Recusar',
};
export const ONBOARDING_CATEGORY: Record<OnboardingCategory, string> = {
  DOCUMENTS: 'Documentos',
  ACCOUNT: 'Conta',
  ACCESS: 'Acessos',
  EQUIPMENT: 'Equipamentos',
  OTHER: 'Outro',
};
export const ONBOARDING_STATUS: Record<OnboardingTask['status'], string> = {
  PENDING: 'Pendente',
  DONE: 'Feita',
  NOT_APPLICABLE: 'Não aplicável',
};

const TONE_OK = 'bg-success-soft text-success-text';
const TONE_WAIT = 'bg-warning-soft text-warning-text';
const TONE_INFO = 'bg-info-soft text-info-text';
const TONE_MUTED = 'bg-surface-2 text-muted';
const TONE_BAD = 'bg-danger-soft text-danger-text';

/** Cor do estado (só tokens semânticos). */
export function tone(code: string): string {
  if (['OPEN', 'APPROVED', 'ACCEPTED', 'HIRED', 'DONE', 'FILLED'].includes(code)) return TONE_OK;
  if (['PENDING_APPROVAL', 'PENDING', 'SCHEDULED', 'OFFER'].includes(code)) return TONE_WAIT;
  if (['SCREENING', 'INTERVIEW', 'APPLIED'].includes(code)) return TONE_INFO;
  if (['REJECTED', 'DECLINED'].includes(code)) return TONE_BAD;
  return TONE_MUTED;
}

/** Mudanças de etapa à mão (espelho das da API; a API volta a verificar). */
export const STAGE_ACTIONS: Record<Stage, Stage[]> = {
  APPLIED: ['SCREENING', 'INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  SCREENING: ['INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['SCREENING', 'REJECTED', 'WITHDRAWN'],
  OFFER: ['REJECTED', 'WITHDRAWN'],
  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
};
export const STAGE_ACTION_LABEL: Record<Stage, string> = {
  APPLIED: 'Recebida',
  SCREENING: 'Passar a triagem',
  INTERVIEW: 'Passar a entrevista',
  OFFER: 'Proposta',
  HIRED: 'Contratado',
  REJECTED: 'Recusar candidatura',
  WITHDRAWN: 'Registar desistência',
};

/** Proposta em curso (no máximo uma por candidatura). */
export function activeOffer(offers: Offer[] | undefined): Offer | null {
  return (
    offers?.find((o) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACCEPTED'].includes(o.status)) ??
    null
  );
}

/** Pode preparar-se uma proposta nova nesta candidatura? */
export function canOffer(a: Pick<Application, 'stage' | 'offers' | 'requisition'>) {
  return (
    ['SCREENING', 'INTERVIEW', 'OFFER'].includes(a.stage) &&
    a.requisition.status === 'OPEN' &&
    !activeOffer(a.offers)
  );
}

/** Acções possíveis sobre uma proposta para quem gere / aprova (a API decide; isto só mostra os botões certos). */
export function offerActions(
  o: Offer,
  access: { manage: boolean; approve: boolean },
  mode: 'WORKFLOW' | 'DIRECT',
) {
  const out: (
    'edit' | 'submit' | 'approve' | 'reject' | 'accept' | 'decline' | 'cancel' | 'hire'
  )[] = [];
  if (access.manage && o.status === 'DRAFT') out.push('edit', 'submit');
  if (o.status === 'PENDING_APPROVAL' && mode === 'DIRECT' && o.canApprove)
    out.push('approve', 'reject');
  if (access.manage && o.status === 'APPROVED') out.push('accept', 'decline');
  if (access.manage && o.status === 'ACCEPTED') out.push('hire');
  if (access.manage && ['DRAFT', 'APPROVED', 'ACCEPTED'].includes(o.status)) out.push('cancel');
  return out;
}

/** O salário cabe na remuneração autorizada? (comparação em cêntimos inteiros, nunca `number` com decimais). */
export function withinRange(salary: string | null, min: string, max: string) {
  const c = (v: string | null) => {
    if (v === null || !/^\d{1,16}(\.\d{1,2})?$/.test(v.trim())) return null;
    const [i, f = ''] = v.trim().split('.');
    return BigInt(i) * 100n + BigInt(f.padEnd(2, '0'));
  };
  const s = c(salary);
  const lo = c(min);
  const hi = c(max);
  return s !== null && lo !== null && hi !== null && s >= lo && s <= hi;
}

/** Sugestão inicial da checklist de onboarding (editável antes de contratar; nada é criado sem confirmação). */
export function suggestedChecklist(): { category: OnboardingCategory; title: string }[] {
  return [
    {
      category: 'DOCUMENTS',
      title: 'Recolher documentos de identificação, NIF e segurança social',
    },
    { category: 'ACCOUNT', title: 'Criar conta de email e de utilizador' },
    { category: 'ACCESS', title: 'Atribuir acessos aos sistemas necessários ao cargo' },
    { category: 'EQUIPMENT', title: 'Entregar equipamento de trabalho' },
  ];
}

/** Progresso da checklist: feitas ou não aplicáveis sobre o total. */
export function onboardingProgress(tasks: Pick<OnboardingTask, 'status'>[]) {
  const done = tasks.filter((t) => t.status !== 'PENDING').length;
  return {
    done,
    total: tasks.length,
    percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
  };
}

/** Só os campos da vaga alterados (edição) ou preenchidos (criação); vazios passam a `null`. */
export function requisitionPayload(
  form: Record<string, unknown>,
  original: Record<string, unknown> | null,
) {
  const keys = [
    'code',
    'title',
    'legalEntityId',
    'branchId',
    'departmentId',
    'positionId',
    'requirements',
    'justification',
    'quantity',
    'deadline',
    'currency',
    'salaryMin',
    'salaryMax',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    let v = form[k];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (k === 'quantity' && v !== null) v = Number(v);
    if (original) {
      if ((original[k] ?? null) !== v) out[k] = v;
    } else if (v !== null) out[k] = v;
  }
  return out;
}
