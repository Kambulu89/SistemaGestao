import type { Permission } from '../../permissions/permission.model';
import type { Condition, ConditionScalar } from './condition.model';

export interface SetFieldAction {
  readonly type: 'setField';
  readonly field: string;
  readonly value: ConditionScalar;
}

/**
 * Acção declarativa executada após uma transição. Só existem acções conhecidas pelo motor;
 * novas acções acrescentam-se a esta união.
 */
export type TransitionAction = SetFieldAction;

export interface TransitionDefinition {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  /** Códigos dos estados de origem. */
  readonly from: readonly string[];
  /** Código do estado de destino. */
  readonly to: string;
  readonly condition?: Condition;
  /** Permissão necessária para executar a transição. */
  readonly permission?: Permission;
  /**
   * Aprovação: exige uma permissão adicional (de aprovador). Cadeias de aprovação
   * com vários níveis pertencem ao módulo de Workflow e não estão modeladas aqui.
   */
  readonly approval?: { readonly permission: Permission };
  readonly actions?: readonly TransitionAction[];
  /** Eventos de domínio emitidos (identificadores para integrações futuras). */
  readonly events?: readonly string[];
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly entityKey: string;
  readonly version: number;
  /** Código do estado atribuído a um registo novo. */
  readonly initialStatus: string;
  readonly transitions: readonly TransitionDefinition[];
}
