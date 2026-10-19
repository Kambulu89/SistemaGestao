import type { Permission } from '../../permissions/permission.model';
import type { Condition } from './condition.model';
import type { FieldDefinition } from './field-definition.model';
import type { FormDefinition } from './form-definition.model';
import type { StatusDefinition } from './status.model';
import type { EntityValidationRule } from './validation-rule.model';
import type { WorkflowDefinition } from './workflow.model';

/** `global`: fornecida pela plataforma. `tenant`: criada ou personalizada por uma organização. */
export type EntityScope = 'global' | 'tenant';

export type DefinitionState = 'draft' | 'published' | 'archived';

export type EntityOperation =
  'read' | 'create' | 'update' | 'delete' | 'export' | 'approve' | 'transition';

/**
 * Política ABAC: nega a operação sobre um registo quando a condição se verifica.
 * Complementa o RBAC (a permissão por papel), nunca o substitui.
 */
export interface EntityPolicy {
  readonly operation: EntityOperation;
  readonly effect: 'deny';
  readonly when: Condition;
  readonly message?: string;
}

export interface EntityPermissions {
  /** Permissão (chave do IAM existente) que autoriza cada operação. */
  readonly operations: Readonly<Record<EntityOperation, Permission>>;
  readonly policies: readonly EntityPolicy[];
}

export type SortDirection = 'asc' | 'desc';

/** Coluna da listagem: um campo ou uma chave de sistema (`status`, `createdAt`, `updatedAt`). */
export interface ListColumn {
  readonly field: string;
  readonly label?: string;
}

export interface ListDefinition {
  readonly columns: readonly ListColumn[];
  /** Campos pesquisados pela caixa de pesquisa. */
  readonly searchFields: readonly string[];
  /** Campos (ou `status`) oferecidos como filtro. */
  readonly filters: readonly string[];
  readonly defaultSort: { readonly field: string; readonly direction: SortDirection } | null;
  readonly pageSize: number;
}

export interface AuditConfig {
  readonly enabled: boolean;
  /** Campos auditados; `all` audita todos. */
  readonly trackedFields: 'all' | readonly string[];
}

/** Nomes das chaves de sistema usáveis em colunas e filtros. */
export const SYSTEM_COLUMNS = ['status', 'createdAt', 'updatedAt'] as const;

export interface EntityDefinition {
  /** Identificador desta versão da definição. */
  readonly id: string;
  /** Código técnico da entidade, estável entre versões (ex.: `vehicle`). */
  readonly key: string;
  readonly scope: EntityScope;
  /** Tenant proprietário (`null` nas entidades globais). */
  readonly tenantId: string | null;
  /** Módulo de origem (id do manifesto); a entidade só existe se o módulo estiver disponível. */
  readonly moduleId: string | null;
  readonly version: number;
  readonly state: DefinitionState;
  readonly names: { readonly singular: string; readonly plural: string };
  readonly description?: string;
  readonly icon: string;
  readonly fields: readonly FieldDefinition[];
  /** Vazio = formulários gerados automaticamente a partir dos campos. */
  readonly forms: readonly FormDefinition[];
  readonly list: ListDefinition;
  /** Regras entre campos; as de um só campo vivem em `FieldDefinition.validations`. */
  readonly rules: readonly EntityValidationRule[];
  readonly statuses: readonly StatusDefinition[];
  readonly workflow: WorkflowDefinition | null;
  readonly permissions: EntityPermissions;
  readonly audit: AuditConfig;
  readonly publishedAt?: string;
}
