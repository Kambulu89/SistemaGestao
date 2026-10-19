import type { Permission } from '../../permissions/permission.model';
import type { EntityDefinition } from '../models/entity-definition.model';
import type { EntityRecord, RecordData } from '../models/entity-record.model';
import type { StatusDefinition } from '../models/status.model';
import type { TransitionDefinition } from '../models/workflow.model';
import { evaluateCondition } from './condition';
import { evaluateOperation } from './entity-permissions';

export interface WorkflowAccess {
  can(permission: Permission): boolean;
}

export type TransitionBlock = 'permission' | 'policy' | 'approval' | 'condition';

export interface TransitionAvailability {
  readonly transition: TransitionDefinition;
  /** `null` = pode ser executada agora. */
  readonly blockedBy: TransitionBlock | null;
}

type RecordLike = Pick<EntityRecord, 'status' | 'data'>;

export function statusOf(
  entity: EntityDefinition,
  code: string | null,
): StatusDefinition | undefined {
  return code === null ? undefined : entity.statuses.find((s) => s.code === code);
}

/** Estado dado a um registo novo: o do workflow, o marcado como inicial, ou o primeiro. */
export function initialStatus(entity: EntityDefinition): string | null {
  if (entity.workflow) return entity.workflow.initialStatus;
  const sorted = [...entity.statuses].sort((a, b) => a.order - b.order);
  return (sorted.find((s) => s.initial) ?? sorted[0])?.code ?? null;
}

/**
 * Transições possíveis a partir de um estado. Com workflow, as definidas nele; sem workflow,
 * qualquer mudança para outro estado é permitida (transições implícitas).
 */
export function transitionsFrom(
  entity: EntityDefinition,
  status: string | null,
): TransitionDefinition[] {
  if (entity.workflow) {
    return entity.workflow.transitions.filter((t) => status !== null && t.from.includes(status));
  }
  return entity.statuses
    .filter((s) => s.code !== status)
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      key: `to-${s.code}`,
      name: `Passar a ${s.name}`,
      from: status ? [status] : [],
      to: s.code,
    }));
}

/** Transições a partir do estado actual do registo, com o motivo de bloqueio quando existe. */
export function availableTransitions(
  entity: EntityDefinition,
  record: RecordLike,
  access: WorkflowAccess,
): TransitionAvailability[] {
  const context = { values: record.data, status: record.status };

  return transitionsFrom(entity, record.status).map((transition) => {
    const operation = evaluateOperation(entity, 'transition', (p) => access.can(p), record);
    let blockedBy: TransitionBlock | null = null;

    if (
      operation.denied === 'permission' ||
      (transition.permission && !access.can(transition.permission))
    ) {
      blockedBy = 'permission';
    } else if (operation.denied === 'policy') {
      blockedBy = 'policy';
    } else if (transition.approval && !access.can(transition.approval.permission)) {
      blockedBy = 'approval';
    } else if (transition.condition && !evaluateCondition(transition.condition, context)) {
      blockedBy = 'condition';
    }
    return { transition, blockedBy };
  });
}

export type TransitionResult =
  | {
      readonly ok: true;
      readonly status: string;
      readonly data: RecordData;
      readonly events: readonly string[];
      readonly transition: TransitionDefinition;
    }
  | { readonly ok: false; readonly reason: 'unknown' | TransitionBlock; readonly message: string };

const BLOCK_MESSAGES: Record<TransitionBlock, string> = {
  permission: 'Não tem permissão para executar esta transição.',
  policy: 'Uma política da entidade não permite esta transição.',
  approval: 'Esta transição exige aprovação.',
  condition: 'As condições da transição não se verificam.',
};

/**
 * Executa uma transição sobre o registo (função pura: devolve o novo estado e dados, sem
 * persistir). O backend usa a mesma lógica e é a autoridade final.
 */
export function applyTransition(
  entity: EntityDefinition,
  record: RecordLike,
  transitionKey: string,
  access: WorkflowAccess,
): TransitionResult {
  const found = availableTransitions(entity, record, access).find(
    (a) => a.transition.key === transitionKey,
  );
  if (!found) {
    return {
      ok: false,
      reason: 'unknown',
      message: 'A transição não existe a partir do estado actual.',
    };
  }
  if (found.blockedBy) {
    return { ok: false, reason: found.blockedBy, message: BLOCK_MESSAGES[found.blockedBy] };
  }

  const { transition } = found;
  const data: Record<string, RecordData[string]> = { ...record.data };
  for (const action of transition.actions ?? []) {
    if (action.type === 'setField') data[action.field] = action.value;
  }
  return { ok: true, status: transition.to, data, events: transition.events ?? [], transition };
}
