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
}

export interface AuditLogDto {
  readonly id: string;
  readonly action: string;
  readonly actorMembershipId: string | null;
  readonly occurredAt: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}
