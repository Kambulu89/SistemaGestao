export interface Person {
  membershipId: string;
  fullName: string | null;
  email: string;
}

export interface Step {
  sequence: number;
  name: string;
  approverType: 'ROLE' | 'MEMBER';
  approverRoleId: string | null;
  approverMembershipId: string | null;
  requiredApprovals: number;
}

export interface Workflow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  subjectType: string;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  publishedAt: string | null;
  version: number;
  steps: Step[];
}

export interface ApprovalRequest {
  id: string;
  workflow: { id: string; code: string; name: string };
  subjectType: string;
  subjectId: string | null;
  title: string;
  description: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  currentStep: number | null;
  requestedBy: Person;
  createdAt: string;
  completedAt: string | null;
  version: number;
}

export interface Decision {
  stepSequence: number;
  decision: 'APPROVE' | 'REJECT';
  comment: string | null;
  decidedBy: Person;
  onBehalfOf: Person | null;
  decidedAt: string;
}

export interface RequestDetail extends ApprovalRequest {
  steps: Step[];
  decisions: Decision[];
  myOptions: { onBehalfOf: string | null }[];
}

export interface Delegation {
  id: string;
  delegator: Person;
  delegate: Person;
  workflowId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: string | null;
}

export const personName = (p: Person | null | undefined) => p?.fullName || p?.email || '—';

/** Acontecimentos do pedido por ordem cronológica (para a ApprovalTimeline). */
export function requestTimeline(r: RequestDetail) {
  const stepName = (n: number) => r.steps.find((s) => s.sequence === n)?.name ?? `Etapa ${n}`;
  const events: {
    at: string;
    title: string;
    detail?: string | null;
    tone: 'neutral' | 'success' | 'danger' | 'warning';
  }[] = [
    { at: r.createdAt, title: `Pedido criado por ${personName(r.requestedBy)}`, tone: 'neutral' },
  ];
  for (const d of [...r.decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)))
    events.push({
      at: d.decidedAt,
      title: `${d.decision === 'APPROVE' ? 'Aprovado' : 'Rejeitado'} por ${personName(d.decidedBy)}${
        d.onBehalfOf ? ` (em nome de ${personName(d.onBehalfOf)})` : ''
      } — ${stepName(d.stepSequence)}`,
      detail: d.comment,
      tone: d.decision === 'APPROVE' ? 'success' : 'danger',
    });
  if (r.completedAt && r.status !== 'PENDING')
    events.push({
      at: r.completedAt,
      title:
        r.status === 'APPROVED'
          ? 'Pedido aprovado'
          : r.status === 'REJECTED'
            ? 'Pedido rejeitado'
            : 'Pedido cancelado',
      tone: r.status === 'APPROVED' ? 'success' : r.status === 'REJECTED' ? 'danger' : 'warning',
    });
  else if (r.status === 'PENDING' && r.currentStep)
    events.push({
      at: new Date().toISOString(),
      title: `A aguardar decisão — ${stepName(r.currentStep)}`,
      tone: 'warning',
    });
  return events;
}
