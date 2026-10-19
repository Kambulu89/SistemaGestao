import type { Permission, PermissionDefinition } from '../../permissions/permission.model';
import type {
  EntityDefinition,
  EntityOperation,
  EntityPermissions,
} from '../models/entity-definition.model';
import type { ConditionContext } from './condition';
import { evaluateCondition } from './condition';
import type { RecordData } from '../models/entity-record.model';

export const ENTITY_OPERATIONS: readonly EntityOperation[] = [
  'read',
  'create',
  'update',
  'delete',
  'export',
  'approve',
  'transition',
];

const OPERATION_LABELS: Record<EntityOperation, string> = {
  read: 'Ver',
  create: 'Criar',
  update: 'Editar',
  delete: 'Eliminar',
  export: 'Exportar',
  approve: 'Aprovar',
  transition: 'Executar transições de',
};

/** Chaves do IAM existente: `entities.<chave>.<operação>` (ex.: `entities.vehicle.update`). */
export function defaultEntityPermissions(entityKey: string): EntityPermissions['operations'] {
  return Object.fromEntries(
    ENTITY_OPERATIONS.map((op) => [op, `entities.${entityKey}.${op}`]),
  ) as EntityPermissions['operations'];
}

/** Permissões declaradas pela entidade, para o catálogo de permissões do IAM. */
export function entityPermissionDefinitions(entity: EntityDefinition): PermissionDefinition[] {
  return ENTITY_OPERATIONS.map((op) => ({
    key: entity.permissions.operations[op],
    name: `${OPERATION_LABELS[op]} ${entity.names.plural.toLowerCase()}`,
  }));
}

export type OperationDenial = 'permission' | 'policy';

export interface OperationCheck {
  readonly allowed: boolean;
  readonly denied?: OperationDenial;
  readonly message?: string;
}

export interface RecordForPolicy {
  readonly status: string | null;
  readonly data: RecordData;
}

/**
 * RBAC + ABAC. O RBAC é a permissão do IAM existente (`can`); o ABAC são as políticas da
 * entidade avaliadas sobre o registo. Só experiência de utilização: o backend repete a decisão.
 */
export function evaluateOperation(
  entity: EntityDefinition,
  operation: EntityOperation,
  can: (permission: Permission) => boolean,
  record?: RecordForPolicy,
): OperationCheck {
  if (!can(entity.permissions.operations[operation]))
    return { allowed: false, denied: 'permission' };

  if (record) {
    const context: ConditionContext = { values: record.data, status: record.status };
    const policy = entity.permissions.policies.find(
      (p) => p.operation === operation && evaluateCondition(p.when, context),
    );
    if (policy) return { allowed: false, denied: 'policy', message: policy.message };
  }
  return { allowed: true };
}
