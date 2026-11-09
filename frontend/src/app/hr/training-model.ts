/** Formação e processos disciplinares (7.10): tipos da API e apresentação (a API decide sempre). */

export interface Competency {
  id: string;
  version: number;
  code: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface Course {
  id: string;
  version: number;
  code: string;
  name: string;
  description: string | null;
  mode: 'INTERNAL' | 'EXTERNAL' | 'ONLINE';
  provider: string | null;
  durationHours: string;
  assessed: boolean;
  issuesCertificate: boolean;
  certificateValidityMonths: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  competencies: { competencyId: string; code: string; name: string; level: number }[];
}

export type EnrollmentStatus =
  'ENROLLED' | 'ATTENDED' | 'PASSED' | 'FAILED' | 'NO_SHOW' | 'CANCELLED';

export interface Session {
  id: string;
  version: number;
  code: string;
  course: {
    id: string;
    code: string;
    name: string;
    assessed: boolean;
    issuesCertificate: boolean;
    durationHours: string;
  };
  startsOn: string;
  endsOn: string;
  location: string | null;
  trainer: string | null;
  capacity: number | null;
  currency: string | null;
  costTotal: string | null;
  participants: number;
  costPerHead: string | null;
  status: 'PLANNED' | 'COMPLETED' | 'CANCELLED';
  enrollments?: {
    id: string;
    version: number;
    employee: { id: string; code: string; fullName: string };
    status: EnrollmentStatus;
    hoursAttended: string | null;
    score: string | null;
    notes: string | null;
    certificateId: string | null;
    canManage: boolean;
  }[];
  competencies?: { competencyId: string; code: string; name: string; level: number }[];
  access?: { manage: boolean };
  [key: string]: unknown;
}

export interface EmployeeTraining {
  enrollments: {
    id: string;
    sessionId: string;
    sessionCode: string;
    course: string;
    startsOn: string;
    endsOn: string;
    sessionStatus: string;
    status: EnrollmentStatus;
  }[];
  competencies: {
    competencyId: string;
    code: string;
    name: string;
    level: number;
    acquiredOn: string;
    source: string;
  }[];
  certificates: {
    id: string;
    name: string;
    issuer: string;
    number: string | null;
    issuedOn: string;
    expiresOn: string | null;
    expired: boolean;
    fromTraining: boolean;
  }[];
  access: { manage: boolean };
}

export type CaseStatus = 'OPEN' | 'UNDER_REVIEW' | 'CLOSED';

export interface DisciplinaryCase {
  id: string;
  version: number;
  code: string;
  employee: { id: string; code: string; fullName: string };
  occurredOn: string;
  category: string;
  summary: string;
  status: CaseStatus;
  outcome: string | null;
  decidedOn: string | null;
  decidedBy: string | null;
  createdBy: string | null;
  description?: string;
  outcomeDetails?: string | null;
  events?: {
    id: string;
    kind: string;
    occurredOn: string;
    text: string;
    createdBy: string | null;
  }[];
  access?: { manage: boolean };
  [key: string]: unknown;
}

export const COURSE_MODE: Record<Course['mode'], string> = {
  INTERNAL: 'Interna',
  EXTERNAL: 'Externa',
  ONLINE: 'Online',
};
export const SESSION_STATUS: Record<Session['status'], string> = {
  PLANNED: 'Planeada',
  COMPLETED: 'Concluída',
  CANCELLED: 'Cancelada',
};
export const ENROLLMENT_STATUS: Record<EnrollmentStatus, string> = {
  ENROLLED: 'Inscrito',
  ATTENDED: 'Presente',
  PASSED: 'Aprovado',
  FAILED: 'Reprovado',
  NO_SHOW: 'Faltou',
  CANCELLED: 'Cancelado',
};
export const CASE_STATUS: Record<CaseStatus, string> = {
  OPEN: 'Aberto',
  UNDER_REVIEW: 'Em instrução',
  CLOSED: 'Encerrado',
};
export const CASE_CATEGORY: Record<string, string> = {
  ATTENDANCE: 'Assiduidade',
  CONDUCT: 'Conduta',
  PERFORMANCE: 'Desempenho',
  SAFETY: 'Segurança',
  OTHER: 'Outra',
};
export const CASE_OUTCOME: Record<string, string> = {
  NO_ACTION: 'Sem sanção',
  VERBAL_WARNING: 'Advertência verbal',
  WRITTEN_WARNING: 'Advertência escrita',
  SUSPENSION: 'Suspensão',
  DISMISSAL: 'Despedimento',
  OTHER: 'Outra',
};
export const CASE_EVENT: Record<string, string> = {
  NOTE: 'Nota',
  NOTIFICATION: 'Notificação ao trabalhador',
  HEARING: 'Audiência',
  DEFENCE: 'Defesa do trabalhador',
  DECISION: 'Decisão',
  STATUS: 'Estado',
};

export function sessionTone(s: Session['status']): string {
  if (s === 'COMPLETED') return 'bg-success-soft text-success-text';
  if (s === 'PLANNED') return 'bg-info-soft text-info-text';
  return 'bg-surface-2 text-muted';
}

export function enrollmentTone(s: EnrollmentStatus): string {
  if (s === 'PASSED' || s === 'ATTENDED') return 'bg-success-soft text-success-text';
  if (s === 'FAILED' || s === 'NO_SHOW') return 'bg-danger-soft text-danger-text';
  if (s === 'ENROLLED') return 'bg-info-soft text-info-text';
  return 'bg-surface-2 text-muted';
}

export function caseTone(s: CaseStatus): string {
  if (s === 'CLOSED') return 'bg-surface-2 text-muted';
  if (s === 'UNDER_REVIEW') return 'bg-warning-soft text-warning-text';
  return 'bg-info-soft text-info-text';
}

/** Resultados possíveis para um participante, conforme o curso tem avaliação ou não. */
export function resultOptions(assessed: boolean): EnrollmentStatus[] {
  return assessed
    ? ['PASSED', 'FAILED', 'NO_SHOW', 'CANCELLED']
    : ['ATTENDED', 'NO_SHOW', 'CANCELLED'];
}

/** Uma sanção (tudo menos "sem sanção") exige a defesa ou a audiência registada antes. */
export function needsDefence(outcome: string, events: { kind: string }[] = []): boolean {
  return (
    outcome !== 'NO_ACTION' && !events.some((e) => e.kind === 'DEFENCE' || e.kind === 'HEARING')
  );
}

/** Nível 1–5 em texto curto ("●●●○○"). */
export function levelDots(level: number): string {
  const n = Math.max(0, Math.min(5, level));
  return '●'.repeat(n) + '○'.repeat(5 - n);
}
