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
