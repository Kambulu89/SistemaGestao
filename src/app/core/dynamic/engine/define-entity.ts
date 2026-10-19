import type {
  AuditConfig,
  EntityDefinition,
  EntityPolicy,
  EntityScope,
  DefinitionState,
  ListDefinition,
} from '../models/entity-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';
import type { FormDefinition } from '../models/form-definition.model';
import type { SemanticColor, StatusDefinition } from '../models/status.model';
import type { EntityValidationRule } from '../models/validation-rule.model';
import type { WorkflowDefinition } from '../models/workflow.model';
import { defaultEntityPermissions } from './entity-permissions';
import { fieldCapabilities } from './field-types';

type Defaulted =
  | 'required'
  | 'visible'
  | 'editable'
  | 'order'
  | 'validations'
  | 'searchable'
  | 'filterable'
  | 'sortable';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Campo com os valores por omissão opcionais; `defineEntity` completa o resto. */
export type FieldInput = DistributiveOmit<FieldDefinition, Defaulted> &
  Partial<Pick<FieldDefinition, Defaulted>>;

export interface StatusInput {
  readonly code: string;
  readonly name: string;
  readonly color?: SemanticColor;
  readonly icon?: string;
  readonly description?: string;
  readonly initial?: boolean;
  readonly final?: boolean;
}

export interface WorkflowInput {
  readonly key?: string;
  readonly name: string;
  readonly initialStatus: string;
  readonly transitions: WorkflowDefinition['transitions'];
}

export interface EntityInput {
  readonly key: string;
  readonly scope?: EntityScope;
  readonly tenantId?: string | null;
  readonly moduleId?: string | null;
  readonly version?: number;
  readonly state?: DefinitionState;
  readonly names: EntityDefinition['names'];
  readonly description?: string;
  readonly icon: string;
  readonly fields: readonly FieldInput[];
  readonly forms?: readonly FormDefinition[];
  readonly list?: Partial<ListDefinition>;
  readonly rules?: readonly EntityValidationRule[];
  readonly statuses?: readonly StatusInput[];
  readonly workflow?: WorkflowInput | null;
  readonly policies?: readonly EntityPolicy[];
  readonly audit?: AuditConfig;
  readonly publishedAt?: string;
  /** Entidade nativa que aceita campos personalizados dos tenants. */
  readonly extensible?: boolean;
  readonly meta?: EntityDefinition['meta'];
}

/** Completa um campo com os valores por omissão do tipo (visível, editável, ordenável se o tipo o permite…). */
export function defineField(input: FieldInput, index = 0): FieldDefinition {
  return {
    required: false,
    visible: true,
    editable: true,
    validations: [],
    searchable: false,
    filterable: false,
    sortable: fieldCapabilities(input.type).sortable,
    ...input,
    order: input.order ?? (index + 1) * 10,
  } as FieldDefinition;
}

/** Listagem gerada a partir dos campos: primeiras colunas, pesquisáveis e filtráveis. */
export function generateDefaultList(
  fields: readonly FieldDefinition[],
  hasStatuses: boolean,
): ListDefinition {
  const active = fields.filter((f) => !f.archived && f.visible).sort((a, b) => a.order - b.order);
  return {
    columns: [
      ...active.slice(0, 5).map((f) => ({ field: f.key })),
      ...(hasStatuses ? [{ field: 'status' }] : []),
    ],
    searchFields: active.filter((f) => f.searchable).map((f) => f.key),
    filters: [
      ...active.filter((f) => f.filterable).map((f) => f.key),
      ...(hasStatuses ? ['status'] : []),
    ],
    defaultSort: { field: 'updatedAt', direction: 'desc' },
    pageSize: 10,
  };
}

/**
 * Cria uma definição completa a partir de uma descrição compacta. Aplica os valores por omissão
 * (campos visíveis e editáveis, ordem por posição, permissões `entities.<chave>.<op>`, auditoria
 * total, listagem e formulários gerados).
 */
export function defineEntity(input: EntityInput): EntityDefinition {
  const scope = input.scope ?? 'tenant';
  const tenantId = input.tenantId ?? null;
  const version = input.version ?? 1;

  const fields = input.fields.map((f, index) => defineField(f, index));

  const statuses: StatusDefinition[] = (input.statuses ?? []).map((s, index) => ({
    id: `${input.key}:status:${s.code}`,
    color: 'neutral',
    ...s,
    order: (index + 1) * 10,
  }));

  const workflow: WorkflowDefinition | null = input.workflow
    ? {
        id: `${input.key}:workflow:v${version}`,
        key: input.workflow.key ?? `${input.key}-workflow`,
        name: input.workflow.name,
        entityKey: input.key,
        version,
        initialStatus: input.workflow.initialStatus,
        transitions: input.workflow.transitions,
      }
    : null;

  return {
    id: `${input.key}@${tenantId ?? 'global'}:v${version}`,
    key: input.key,
    scope,
    tenantId,
    moduleId: input.moduleId ?? null,
    version,
    state: input.state ?? 'published',
    names: input.names,
    description: input.description,
    icon: input.icon,
    fields,
    forms: input.forms ?? [],
    list: { ...generateDefaultList(fields, statuses.length > 0), ...input.list },
    rules: input.rules ?? [],
    statuses,
    workflow,
    permissions: {
      operations: defaultEntityPermissions(input.key),
      policies: input.policies ?? [],
    },
    audit: input.audit ?? { enabled: true, trackedFields: 'all' },
    publishedAt: input.publishedAt,
    extensible: input.extensible,
    meta: input.meta,
  };
}
