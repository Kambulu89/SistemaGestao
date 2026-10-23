import type { Tone } from '../../../shared/ui/badge/badge';
import type { InstanceStatus, TaskStatus, TaskViewDto } from './workflows.api';

export const INSTANCE_STATUS: Record<InstanceStatus, { label: string; tone: Tone }> = {
  RUNNING: { label: 'Em curso', tone: 'brand' },
  WAITING: { label: 'A aguardar decisão', tone: 'brand' },
  APPROVED: { label: 'Aprovado', tone: 'success' },
  REJECTED: { label: 'Rejeitado', tone: 'danger' },
  CANCELLED: { label: 'Cancelado', tone: 'neutral' },
  FAILED: { label: 'Falhou', tone: 'danger' },
};

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Por decidir', tone: 'brand' },
  CLAIMED: { label: 'Reclamada', tone: 'brand' },
  APPROVED: { label: 'Aprovada', tone: 'success' },
  REJECTED: { label: 'Rejeitada', tone: 'danger' },
  RETURNED: { label: 'Devolvida', tone: 'warning' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
};

/** Porque terminou um processo, para quem o submeteu. */
export const END_REASON: Record<string, string> = {
  APPROVED: 'Aprovado por todas as etapas.',
  REJECTED: 'Rejeitado.',
  RETURNED: 'Devolvido a quem submeteu.',
  CANCELLED_BY_SUBMITTER: 'Cancelado por quem o submeteu.',
  RESOURCE_CHANGED: 'Cancelado porque o registo foi alterado depois de submetido.',
  NO_APPROVER: 'Falhou: a etapa seguinte não tem responsável resolvível.',
  CONDITION_ERROR: 'Falhou: uma condição do workflow não pôde ser avaliada.',
};

export interface MemberLike {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

/** Nome de um membro; sem permissão para listar membros, mostra-se um identificador curto. */
export function memberName(members: readonly MemberLike[], id: string | null): string {
  if (!id) return '—';
  const found = members.find((m) => m.id === id);
  return found?.displayName ?? found?.email ?? `Membro ${id.slice(0, 8)}`;
}

/** O que o utilizador pode fazer com a tarefa, por ordem de apresentação. */
export function taskActions(
  item: TaskViewDto,
): readonly ('claim' | 'approve' | 'reject' | 'return')[] {
  const actions: ('claim' | 'approve' | 'reject' | 'return')[] = [];
  if (item.can.claim) actions.push('claim');
  if (item.can.decide) actions.push('approve', 'reject', 'return');
  return actions;
}

export const ACTION_LABEL = {
  claim: 'Reclamar',
  approve: 'Aprovar',
  reject: 'Rejeitar',
  return: 'Devolver',
} as const;

/** Montante e moeda como texto (os decimais atravessam a API como texto e mostram-se tal como vêm). */
export function amountLabel(item: Pick<TaskViewDto, 'amount' | 'currency'>): string {
  if (item.amount === null) return '—';
  return item.currency ? `${item.amount} ${item.currency}` : item.amount;
}

/** Código da entidade → `a-z0-9_` do URL (as entidades do servidor usam o código como chave). */
export function recordPath(slug: string, entityCode: string, recordId: string): string[] {
  return ['/t', slug, 'data', entityCode, recordId];
}

/** Interpreta o texto dos códigos de workflow ("a, b") como lista; vazio = todos. */
export function parseWorkflowCodes(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}
