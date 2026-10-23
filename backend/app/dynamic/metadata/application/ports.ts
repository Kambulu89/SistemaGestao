import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { FieldSpec } from '#dynamic/metadata/domain/field_types'
import type { RecordValues } from '#dynamic/metadata/domain/record'

export type EntityStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
export type OwnershipMode = 'TENANT' | 'UNIT' | 'OWNER'

export interface EntityDefinition {
  id: string
  code: string
  name: string
  description: string | null
  kind: 'DYNAMIC'
  status: EntityStatus
  /** Revisão publicada em vigor (os registos novos usam sempre esta). */
  publishedVersion: number | null
  ownershipMode: OwnershipMode
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface VersionSummary {
  id: string
  revision: number
  publishedAt: Date | null
}

export interface SchemaVersion extends VersionSummary {
  entityDefinitionId: string
  fields: FieldSpec[]
}

export interface DynamicRecord {
  id: string
  entityDefinitionId: string
  schemaVersionId: string
  ownerMembershipId: string | null
  organizationUnitId: string | null
  data: RecordValues
  sensitiveData: RecordValues
  archivedAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface EntityStore {
  /** Serializa as alterações a uma entidade (lock até ao fim da transacção). */
  lock(scope: TenantScope, entityId: string): Promise<void>
  list(scope: TenantScope): Promise<EntityDefinition[]>
  find(scope: TenantScope, id: string): Promise<EntityDefinition | null>
  findByCode(scope: TenantScope, code: string): Promise<EntityDefinition | null>
  /** `null` se o código já existir neste tenant. */
  insert(
    scope: TenantScope,
    values: { code: string; name: string; description: string | null; ownershipMode: OwnershipMode }
  ): Promise<EntityDefinition | null>
  /** Controlo de versão: 404 se não existe, 409 `VERSION_CONFLICT` se mudou. */
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: {
      name?: string
      description?: string | null
      ownershipMode?: OwnershipMode
      status?: EntityStatus
      publishedVersion?: number
    }
  ): Promise<EntityDefinition>
}

export interface VersionStore {
  list(scope: TenantScope, entityId: string): Promise<VersionSummary[]>
  findDraft(scope: TenantScope, entityId: string): Promise<SchemaVersion | null>
  findByRevision(
    scope: TenantScope,
    entityId: string,
    revision: number
  ): Promise<SchemaVersion | null>
  findById(scope: TenantScope, id: string): Promise<SchemaVersion | null>
  /** Cria o rascunho da próxima revisão; `null` se já existir um rascunho. */
  insertDraft(
    scope: TenantScope,
    entityId: string,
    fields: FieldSpec[]
  ): Promise<SchemaVersion | null>
  replaceFields(scope: TenantScope, versionId: string, fields: FieldSpec[]): Promise<void>
  deleteDraft(scope: TenantScope, versionId: string): Promise<void>
  /** Grava os campos efectivos e marca a versão como publicada (a partir daí é imutável). */
  publish(scope: TenantScope, versionId: string, fields: FieldSpec[]): Promise<void>
}

export interface RecordFilter {
  q?: string
  archived: boolean
  ownerMembershipId?: string
  unitIds?: readonly string[]
  limit: number
  offset: number
}

export interface RecordWrite {
  schemaVersionId: string
  data: RecordValues
  sensitiveData: RecordValues
  searchText: string
}

export interface RecordStore {
  insert(
    scope: TenantScope,
    entityId: string,
    values: RecordWrite & { ownerMembershipId: string | null; organizationUnitId: string | null }
  ): Promise<DynamicRecord>
  find(scope: TenantScope, entityId: string, id: string): Promise<DynamicRecord | null>
  list(scope: TenantScope, entityId: string, filter: RecordFilter): Promise<DynamicRecord[]>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: RecordWrite
  ): Promise<DynamicRecord>
  archive(scope: TenantScope, id: string, expectedVersion: number): Promise<DynamicRecord>
  /** Registos não arquivados da entidade: os que a próxima publicação deixa numa versão anterior. */
  countActive(scope: TenantScope, entityId: string): Promise<number>
  /**
   * Substitui as chaves únicas do registo. Devolve os campos cujo valor já pertence a outro registo
   * (a unicidade é garantida pelo índice da base, também sob concorrência).
   */
  replaceUniqueKeys(
    scope: TenantScope,
    entityId: string,
    recordId: string,
    keys: { fieldCode: string; key: string }[]
  ): Promise<string[]>
  releaseUniqueFields(scope: TenantScope, entityId: string, fieldCodes: string[]): Promise<void>
}

/** Verificações de existência no tenant (a RLS impede ver o que é de outro tenant). */
export interface ReferenceLookup {
  existingRecords(scope: TenantScope, entityId: string, ids: string[]): Promise<Set<string>>
  activeMemberships(scope: TenantScope, ids: string[]): Promise<Set<string>>
  activeUnit(scope: TenantScope, id: string): Promise<boolean>
}

export interface AccessDecision {
  allowed: boolean
  hiddenFields: readonly string[]
  readOnlyFields: readonly string[]
}

/** Autorização RBAC + ABAC feita pelo módulo de permissões; os atributos do recurso alimentam as políticas. */
export interface AccessControl {
  decide(
    context: TenantContext,
    permission: string,
    resource: Record<string, unknown>
  ): Promise<AccessDecision>
}
