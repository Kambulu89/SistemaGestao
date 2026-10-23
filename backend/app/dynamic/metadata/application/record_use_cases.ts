import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
import {
  collectReferences,
  partition,
  searchText,
  uniqueKeys,
  validateRecordData,
  type RecordValues,
} from '#dynamic/metadata/domain/record'
import { resolveListQuery } from '#dynamic/metadata/domain/list_query'
import { isSearchable } from '#dynamic/metadata/domain/presentation'
import { validationError } from '#dynamic/metadata/application/entity_use_cases'
import type {
  AccessControl,
  AccessDecision,
  DynamicRecord,
  EntityDefinition,
  EntityStore,
  RecordStore,
  ReferenceLookup,
  SchemaVersion,
  VersionStore,
} from '#dynamic/metadata/application/ports'

export interface RecordView {
  id: string
  entityCode: string
  schemaVersion: { id: string; revision: number }
  data: RecordValues
  ownerMembershipId: string | null
  organizationUnitId: string | null
  archived: boolean
  version: number
  createdAt: Date
  updatedAt: Date
  createdByMembershipId: string | null
  updatedByMembershipId: string | null
}

interface Loaded {
  entity: EntityDefinition
  /** Versão publicada em vigor (a que valida as escritas). */
  current: SchemaVersion
}

const forbidden = () =>
  new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')

/**
 * Registos de entidades dinâmicas (C10). Cada registo aponta para a versão exacta com que foi validado;
 * as escritas validam sempre contra a versão publicada em vigor. As permissões são `dynamic.*`, com o
 * código da entidade como atributo (`resource.entity`) para as políticas ABAC; os campos sensíveis
 * exigem `dynamic.sensitive` e os registos de modo OWNER só são vistos pelo responsável (ou `dynamic.all`).
 */
export class RecordUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly entities: EntityStore,
    private readonly versions: VersionStore,
    private readonly records: RecordStore,
    private readonly lookup: ReferenceLookup,
    private readonly access: AccessControl
  ) {}

  async create(
    context: TenantContext,
    entityCode: string,
    input: { data: unknown; organizationUnitId: string | null }
  ): Promise<RecordView> {
    const first = await this.uow.run((scope) => this.loadForWrite(scope, entityCode), context)
    const { entity } = first
    const decision = await this.decide(context, 'dynamic.create', entity, {
      unitId: input.organizationUnitId,
    })
    this.modeRules(context, entity, input.organizationUnitId)

    const { values, issues } = validateRecordData(first.current.fields, input.data, null)
    const provided = Object.keys((input.data ?? {}) as object)
    await this.assertFieldAccess(context, entity, first.current.fields, provided, decision)
    if (issues.length > 0) throw validationError(issues)

    const row = await this.uow.run(async (scope) => {
      const loaded = await this.loadForWrite(scope, entityCode)
      if (loaded.current.id !== first.current.id) this.staleSchema()
      await this.checkReferences(scope, loaded.current.fields, values, provided)
      if (entity.ownershipMode === 'UNIT') await this.checkUnit(scope, input.organizationUnitId)

      const { data, sensitive } = partition(loaded.current.fields, values)
      const inserted = await this.records.insert(scope, entity.id, {
        schemaVersionId: loaded.current.id,
        data,
        sensitiveData: sensitive,
        searchText: searchText(loaded.current.fields, values),
        ownerMembershipId: entity.ownershipMode === 'OWNER' ? context.membershipId : null,
        organizationUnitId: entity.ownershipMode === 'UNIT' ? input.organizationUnitId : null,
      })
      await this.claimUniqueKeys(scope, entity, inserted.id, loaded.current.fields, values)
      return inserted
    }, context)
    return this.present(context, entity, [first.current], row)
  }

  async get(context: TenantContext, entityCode: string, id: string): Promise<RecordView> {
    const { entity, row, version } = await this.uow.run(async (scope) => {
      const found = await this.mustFindEntity(scope, entityCode)
      const stored = await this.records.find(scope, found.id, id)
      if (!stored) throw ApiError.notFound()
      return {
        entity: found,
        row: stored,
        version: await this.versions.findById(scope, stored.schemaVersionId),
      }
    }, context)
    const decision = await this.authorizeRecord(context, 'dynamic.read', entity, row)
    return this.present(context, entity, version ? [version] : [], row, decision)
  }

  async list(
    context: TenantContext,
    entityCode: string,
    query: {
      q?: string
      archived: boolean
      limit: number
      offset: number
      sort?: string
      filters: Readonly<Record<string, string>>
    }
  ): Promise<{ items: RecordView[]; total: number }> {
    const entity = await this.uow.run((scope) => this.mustFindEntity(scope, entityCode), context)
    const decision = await this.decide(context, 'dynamic.read', entity, {})

    const restrict: { ownerMembershipId?: string; unitIds?: readonly string[] } = {}
    if (entity.ownershipMode === 'OWNER' && !(await this.canSeeAll(context, entity))) {
      if (!context.membershipId) return { items: [], total: 0 }
      restrict.ownerMembershipId = context.membershipId
    }
    if (entity.ownershipMode === 'UNIT' && context.unitScope.kind === 'UNITS') {
      restrict.unitIds = context.unitScope.unitIds
    }
    const q = query.q?.trim().toLowerCase()
    const { rows, total, versions } = await this.uow.run(async (scope) => {
      const current =
        entity.publishedVersion === null
          ? null
          : await this.versions.findByRevision(scope, entity.id, entity.publishedVersion)
      // Um campo escondido por regra de campo não pode ordenar, filtrar nem ser pesquisado (revelaria o valor).
      const hidden = new Set(decision.hiddenFields)
      const visibleFields = (current?.fields ?? []).filter((f) => !hidden.has(f.code))
      const resolved = resolveListQuery(visibleFields, query.sort, query.filters)
      const issues = [...resolved.issues]
      if (q && (current?.fields ?? []).some((f) => hidden.has(f.code) && isSearchable(f))) {
        issues.push({
          path: 'q',
          code: 'SEARCH_UNAVAILABLE',
          message: 'A pesquisa por texto não está disponível para o seu perfil nesta entidade.',
        })
      }
      if (issues.length > 0) throw validationError(issues)

      const page = await this.records.list(scope, entity.id, {
        archived: query.archived,
        limit: query.limit,
        offset: query.offset,
        q: q || undefined,
        sort: resolved.sort,
        filters: resolved.filters,
        ...restrict,
      })
      const cache = new Map<string, SchemaVersion | null>()
      for (const item of page.rows) {
        if (!cache.has(item.schemaVersionId)) {
          cache.set(item.schemaVersionId, await this.versions.findById(scope, item.schemaVersionId))
        }
      }
      return {
        rows: page.rows,
        total: page.total,
        versions: [...cache.values()].filter((v) => v !== null),
      }
    }, context)
    const showSensitive =
      versions.some((v) => v.fields.some((f) => f.sensitive)) &&
      (await this.canSeeSensitive(context, entity))
    return {
      items: rows.map((row) =>
        this.toView(entity, versions, row, decision.hiddenFields, showSensitive)
      ),
      total,
    }
  }

  async update(
    context: TenantContext,
    entityCode: string,
    id: string,
    input: { data: unknown; expectedVersion: number }
  ): Promise<RecordView> {
    const first = await this.uow.run(async (scope) => {
      const loaded = await this.loadForWrite(scope, entityCode)
      const row = await this.records.find(scope, loaded.entity.id, id)
      if (!row) throw ApiError.notFound()
      return { ...loaded, row }
    }, context)
    const { entity } = first
    if (first.row.archivedAt) {
      throw ApiError.conflict('RECORD_ARCHIVED', 'O registo está arquivado.')
    }
    const decision = await this.authorizeRecord(context, 'dynamic.update', entity, first.row)

    const previous = { ...first.row.data, ...first.row.sensitiveData }
    const { values, issues } = validateRecordData(first.current.fields, input.data, previous)
    const provided = Object.keys((input.data ?? {}) as object)
    await this.assertFieldAccess(context, entity, first.current.fields, provided, decision)
    if (issues.length > 0) throw validationError(issues)

    const row = await this.uow.run(async (scope) => {
      const loaded = await this.loadForWrite(scope, entityCode)
      if (loaded.current.id !== first.current.id) this.staleSchema()
      await this.checkReferences(scope, loaded.current.fields, values, provided)
      const { data, sensitive } = partition(loaded.current.fields, values)
      const written = await this.records.update(scope, id, input.expectedVersion, {
        schemaVersionId: loaded.current.id,
        data,
        sensitiveData: sensitive,
        searchText: searchText(loaded.current.fields, values),
      })
      await this.claimUniqueKeys(scope, entity, written.id, loaded.current.fields, values)
      return written
    }, context)
    return this.present(context, entity, [first.current], row)
  }

  async archive(
    context: TenantContext,
    entityCode: string,
    id: string,
    expectedVersion: number
  ): Promise<RecordView> {
    const { entity, row } = await this.uow.run(async (scope) => {
      const found = await this.mustFindEntity(scope, entityCode)
      const stored = await this.records.find(scope, found.id, id)
      if (!stored) throw ApiError.notFound()
      return { entity: found, row: stored }
    }, context)
    await this.authorizeRecord(context, 'dynamic.archive', entity, row)
    const { archived, version } = await this.uow.run(async (scope) => {
      const closed = await this.records.archive(scope, id, expectedVersion)
      // O valor deixa de estar reservado: um registo arquivado não bloqueia valores únicos.
      await this.records.replaceUniqueKeys(scope, entity.id, id, [])
      return {
        archived: closed,
        version: await this.versions.findById(scope, closed.schemaVersionId),
      }
    }, context)
    return this.present(context, entity, version ? [version] : [], archived)
  }

  // --- internos ------------------------------------------------------------------------------

  private async mustFindEntity(scope: TenantScope, code: string): Promise<EntityDefinition> {
    const entity = await this.entities.findByCode(scope, code)
    if (!entity) throw ApiError.notFound()
    return entity
  }

  /** Entidade publicada e a sua versão em vigor; arquivada ou por publicar não aceita escritas. */
  private async loadForWrite(scope: TenantScope, code: string): Promise<Loaded> {
    const entity = await this.mustFindEntity(scope, code)
    if (entity.status === 'ARCHIVED') {
      throw ApiError.conflict('ENTITY_ARCHIVED', 'A entidade está arquivada.')
    }
    if (entity.publishedVersion === null) {
      throw ApiError.conflict('ENTITY_NOT_PUBLISHED', 'A entidade ainda não foi publicada.')
    }
    const version = await this.versions.findByRevision(scope, entity.id, entity.publishedVersion)
    if (!version) throw new Error('Versão publicada em falta.')
    return { entity, current: version }
  }

  private staleSchema(): never {
    throw ApiError.conflict(
      'SCHEMA_CHANGED',
      'A definição da entidade foi publicada entretanto: repita o pedido.'
    )
  }

  private resource(
    entity: EntityDefinition,
    extra: { unitId?: string | null; ownerMembershipId?: string | null }
  ) {
    return {
      entity: entity.code,
      ownershipMode: entity.ownershipMode,
      ...(extra.unitId ? { unitId: extra.unitId } : {}),
      ...(extra.ownerMembershipId ? { ownerMembershipId: extra.ownerMembershipId } : {}),
    }
  }

  private async decide(
    context: TenantContext,
    permission: string,
    entity: EntityDefinition,
    extra: { unitId?: string | null; ownerMembershipId?: string | null }
  ): Promise<AccessDecision> {
    const decision = await this.access.decide(context, permission, this.resource(entity, extra))
    if (!decision.allowed) throw forbidden()
    return decision
  }

  private async canSeeAll(context: TenantContext, entity: EntityDefinition): Promise<boolean> {
    const decision = await this.access.decide(context, 'dynamic.all', this.resource(entity, {}))
    return decision.allowed
  }

  /** Autorização sobre um registo concreto: permissão com os seus atributos e regra do modo OWNER. */
  private async authorizeRecord(
    context: TenantContext,
    permission: string,
    entity: EntityDefinition,
    row: DynamicRecord
  ): Promise<AccessDecision> {
    if (
      entity.ownershipMode === 'OWNER' &&
      row.ownerMembershipId !== context.membershipId &&
      !(await this.canSeeAll(context, entity))
    ) {
      throw ApiError.notFound()
    }
    return this.decide(context, permission, entity, {
      unitId: row.organizationUnitId,
      ownerMembershipId: row.ownerMembershipId,
    })
  }

  private modeRules(context: TenantContext, entity: EntityDefinition, unitId: string | null) {
    const issues: Issue[] = []
    if (entity.ownershipMode === 'UNIT' && !unitId) {
      issues.push({
        path: 'organizationUnitId',
        code: 'REQUIRED',
        message: 'Indique a unidade do registo.',
      })
    }
    if (entity.ownershipMode !== 'UNIT' && unitId) {
      issues.push({
        path: 'organizationUnitId',
        code: 'NOT_ALLOWED',
        message: 'Esta entidade não usa unidades.',
      })
    }
    if (entity.ownershipMode === 'OWNER' && !context.membershipId) {
      issues.push({
        path: 'ownerMembershipId',
        code: 'REQUIRED',
        message: 'O registo precisa de um responsável.',
      })
    }
    if (issues.length > 0) throw validationError(issues)
  }

  /** Campos sensíveis, escondidos ou só de leitura (regras ABAC) nunca são escritos sem direito. */
  private async assertFieldAccess(
    context: TenantContext,
    entity: EntityDefinition,
    fields: readonly FieldSpec[],
    provided: string[],
    decision: AccessDecision
  ) {
    const blocked = new Set([...decision.hiddenFields, ...decision.readOnlyFields])
    const touched = fields.filter((f) => provided.includes(f.code))
    if (touched.some((f) => blocked.has(f.code))) throw forbidden()
    if (touched.some((f) => f.sensitive) && !(await this.canSeeSensitive(context, entity))) {
      throw forbidden()
    }
  }

  private async canSeeSensitive(
    context: TenantContext,
    entity: EntityDefinition
  ): Promise<boolean> {
    const decision = await this.access.decide(
      context,
      'dynamic.sensitive',
      this.resource(entity, {})
    )
    return decision.allowed
  }

  /** Só se verifica a existência das referências que o pedido escreveu (as antigas não bloqueiam). */
  private async checkReferences(
    scope: TenantScope,
    fields: readonly FieldSpec[],
    values: RecordValues,
    provided: string[]
  ) {
    const uses = collectReferences(fields, values).filter((u) => provided.includes(u.path.slice(5)))
    const issues: Issue[] = []
    for (const use of uses) {
      const found =
        use.kind === 'ENTITY'
          ? await this.lookup.existingRecords(scope, use.entityId as string, [use.id])
          : await this.lookup.activeMemberships(scope, [use.id])
      if (!found.has(use.id)) {
        issues.push({
          path: use.path,
          code: 'REFERENCE_NOT_FOUND',
          message: 'A referência não existe neste tenant.',
        })
      }
    }
    if (issues.length > 0) throw validationError(issues)
  }

  private async checkUnit(scope: TenantScope, unitId: string | null) {
    if (!unitId || !(await this.lookup.activeUnit(scope, unitId))) {
      throw validationError([
        {
          path: 'organizationUnitId',
          code: 'NOT_FOUND',
          message: 'Unidade inexistente ou inactiva neste tenant.',
        },
      ])
    }
  }

  private async claimUniqueKeys(
    scope: TenantScope,
    entity: EntityDefinition,
    recordId: string,
    fields: readonly FieldSpec[],
    values: RecordValues
  ) {
    const taken = await this.records.replaceUniqueKeys(
      scope,
      entity.id,
      recordId,
      uniqueKeys(fields, values)
    )
    if (taken.length > 0) {
      throw ApiError.conflict(
        'UNIQUE_VALUE_TAKEN',
        'Já existe um registo com este valor.',
        taken.map((code) => ({
          path: `data.${code}`,
          code: 'UNIQUE',
          message: 'Valor já utilizado.',
        }))
      )
    }
  }

  /**
   * Esconde o que o actor não pode ver: valores sensíveis sem `dynamic.sensitive`, campos ocultos pelas
   * regras ABAC e tudo se nem puder ler o registo (ex.: só tem `dynamic.create`).
   */
  private async present(
    context: TenantContext,
    entity: EntityDefinition,
    versions: readonly SchemaVersion[],
    row: DynamicRecord,
    known?: AccessDecision
  ): Promise<RecordView> {
    const decision =
      known ??
      (await this.access.decide(
        context,
        'dynamic.read',
        this.resource(entity, {
          unitId: row.organizationUnitId,
          ownerMembershipId: row.ownerMembershipId,
        })
      ))
    const showSensitive =
      decision.allowed &&
      versions.some((v) => v.fields.some((f) => f.sensitive)) &&
      (await this.canSeeSensitive(context, entity))
    const view = this.toView(entity, versions, row, decision.hiddenFields, showSensitive)
    return decision.allowed ? view : { ...view, data: {} }
  }

  private toView(
    entity: EntityDefinition,
    versions: readonly SchemaVersion[],
    row: DynamicRecord,
    hiddenFields: readonly string[],
    showSensitive: boolean
  ): RecordView {
    const version = versions.find((v) => v.id === row.schemaVersionId)
    const hidden = new Set(hiddenFields)
    const data: RecordValues = {}
    const source = showSensitive ? { ...row.data, ...row.sensitiveData } : row.data
    for (const [key, value] of Object.entries(source)) {
      if (!hidden.has(key)) data[key] = value
    }
    return {
      id: row.id,
      entityCode: entity.code,
      schemaVersion: { id: row.schemaVersionId, revision: version?.revision ?? 0 },
      data,
      ownerMembershipId: row.ownerMembershipId,
      organizationUnitId: row.organizationUnitId,
      archived: row.archivedAt !== null,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdByMembershipId: row.createdByMembershipId,
      updatedByMembershipId: row.updatedByMembershipId,
    }
  }
}
