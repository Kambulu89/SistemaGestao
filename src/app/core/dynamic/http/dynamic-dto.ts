/** Formas da API de metadados e entidades dinâmicas (C10; ver `backend/openapi/openapi.yaml`). */

export type EntityStatusDto = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface EntityDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: EntityStatusDto;
  readonly publishedVersion: number | null;
  readonly ownershipMode: 'TENANT' | 'UNIT' | 'OWNER';
  readonly presentation: { readonly pluralName?: string; readonly icon?: string };
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FieldOptionDto {
  readonly code: string;
  readonly label: string;
  readonly archived?: boolean;
}

export interface FieldPresentationDto {
  readonly description?: string;
  readonly placeholder?: string;
  readonly searchable?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
}

export interface FieldDto {
  readonly code: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: unknown;
  readonly validation: Readonly<Record<string, unknown>>;
  readonly options: readonly FieldOptionDto[];
  readonly position: number;
  readonly referenceEntityCode?: string | null;
  readonly sensitive: boolean;
  readonly readOnly: boolean;
  readonly archived: boolean;
  readonly presentation: FieldPresentationDto;
}

/** Campo tal como se envia ao servidor (criar ou guardar o rascunho). */
export interface FieldInputDto {
  readonly code: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly validation: Record<string, unknown>;
  readonly options?: readonly { code: string; label: string }[];
  readonly referenceEntityCode?: string;
  readonly sensitive: boolean;
  readonly readOnly: boolean;
  readonly presentation: FieldPresentationDto;
}

export interface VersionDto {
  readonly id: string;
  readonly revision: number;
  readonly publishedAt: string | null;
  readonly fields: readonly FieldDto[];
}

export interface EntityDetailDto {
  readonly entity: EntityDto;
  readonly draft: VersionDto | null;
  readonly published: VersionDto | null;
}

export interface RecordDto {
  readonly id: string;
  readonly entityCode: string;
  readonly schemaVersion: { readonly id: string; readonly revision: number };
  readonly data: Readonly<Record<string, unknown>>;
  readonly archived: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByMembershipId: string | null;
  readonly updatedByMembershipId: string | null;
  /** Estado na máquina de estados da entidade (`null` se não tem máquina ou o registo é anterior a ela). */
  readonly state?: {
    readonly code: string;
    readonly label: string;
    readonly category: 'INITIAL' | 'ACTIVE' | 'FINAL' | 'CANCELLED';
    readonly editable: boolean;
    readonly color: string | null;
    readonly version: number;
  } | null;
}

export interface ActionsDto {
  readonly state: { readonly code: string; readonly label: string; readonly version: number };
  readonly actions: readonly {
    readonly code: string;
    readonly label: string;
    readonly to: string;
    readonly toLabel: string;
    readonly reasonRequired: boolean;
  }[];
}

export interface AuditLogDto {
  readonly id: string;
  readonly action: string;
  readonly actorMembershipId: string | null;
  readonly occurredAt: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

// --- formulários (C11) ---------------------------------------------------------------------------

export type ConditionDto =
  | {
      readonly op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
      readonly field: string;
      readonly value: string | number | boolean | null;
    }
  | {
      readonly op: 'in' | 'nin';
      readonly field: string;
      readonly values: readonly (string | number | boolean | null)[];
    }
  | { readonly op: 'empty' | 'notEmpty'; readonly field: string }
  | { readonly op: 'and' | 'or'; readonly conditions: readonly ConditionDto[] }
  | { readonly op: 'not'; readonly condition: ConditionDto };

export interface FormBindingDto {
  readonly kind: 'field';
  readonly field: string;
  readonly span?: number;
  readonly label?: string;
  readonly placeholder?: string;
  readonly help?: string;
  readonly visible?: boolean;
  readonly editable?: boolean;
  readonly required?: boolean;
  readonly visibleWhen?: ConditionDto;
  readonly editableWhen?: ConditionDto;
  readonly requiredWhen?: ConditionDto;
}

export interface FormSectionDto {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly columns: number;
  readonly visibleWhen?: ConditionDto;
  readonly items: readonly FormBindingDto[];
}

export interface FormDto {
  readonly id: string;
  readonly entityCode: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly revision: number;
  /** Versão de concorrência (`expectedVersion`). */
  readonly version: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  readonly modes: readonly ('create' | 'edit' | 'read')[];
  readonly isDefault: boolean;
  readonly sections: readonly FormSectionDto[];
  readonly publishedAt: string | null;
  /** Problemas que o servidor verifica agora contra a entidade (vazio = utilizável). */
  readonly issues: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}
