import { ApiError, type ApiErrorDetail } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  checkCompatibility,
  type CompatibilityReport,
} from '#dynamic/metadata/domain/compatibility'
import { normalizeFields, type FieldInput } from '#dynamic/metadata/domain/field_spec'
import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
import { normalizeEntityPresentation } from '#dynamic/metadata/domain/presentation'
import type {
  EntityDefinition,
  EntityStore,
  OwnershipMode,
  RecordStore,
  SchemaVersion,
  VersionStore,
  VersionSummary,
} from '#dynamic/metadata/application/ports'

const ENTITY_CODE = /^[a-z][a-z0-9_]{1,49}$/
const MODES: readonly OwnershipMode[] = ['TENANT', 'UNIT', 'OWNER']

export const validationError = (details: ApiErrorDetail[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

/** Campo tal como chega da API: a entidade de destino é indicada pelo código. */
export type FieldDraftInput = Omit<FieldInput, 'referenceEntityId'> & {
  referenceEntityCode?: unknown
}

export interface EntityDetail {
  entity: EntityDefinition
  draft: SchemaVersion | null
  published: SchemaVersion | null
  versions: VersionSummary[]
}

export interface PublishPreview extends Omit<CompatibilityReport, 'effective'> {
  /** Registos activos que ficam numa versão anterior (continuam legíveis tal como estão). */
  affectedRecords: number
  publishable: boolean
}

/** Casos de uso de definição de entidades (C10): rascunho, pré-visualização e publicação imutável. */
export class EntityDefinitionUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly entities: EntityStore,
    private readonly versions: VersionStore,
    private readonly records: RecordStore
  ) {}

  list(context: TenantContext): Promise<EntityDefinition[]> {
    return this.uow.run((scope) => this.entities.list(scope), context)
  }

  get(context: TenantContext, id: string): Promise<EntityDetail> {
    return this.uow.run(
      async (scope) => this.detail(scope, await this.mustFind(scope, id)),
      context
    )
  }

  async create(
    context: TenantContext,
    input: {
      code: string
      name: string
      description: string | null
      ownershipMode: OwnershipMode
      presentation?: unknown
      fields: unknown
    }
  ): Promise<EntityDetail> {
    const code = input.code.trim()
    const name = input.name.trim()
    const issues: Issue[] = []
    if (!ENTITY_CODE.test(code)) {
      issues.push(issue('code', 'INVALID_CODE', 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).'))
    }
    if (!name || name.length > 160) {
      issues.push(issue('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).'))
    }
    if (!MODES.includes(input.ownershipMode)) {
      issues.push(issue('ownershipMode', 'INVALID_MODE', 'Modo de propriedade inválido.'))
    }
    const presentation = normalizeEntityPresentation(input.presentation, issues)
    if (issues.length > 0) throw validationError(issues)

    return this.uow.run(async (scope) => {
      const entity = await this.entities.insert(scope, {
        code,
        name,
        description: input.description?.trim() || null,
        ownershipMode: input.ownershipMode,
        presentation,
      })
      if (!entity) {
        throw ApiError.conflict('ENTITY_CODE_TAKEN', 'Já existe uma entidade com este código.')
      }
      const fields = await this.resolveFields(scope, entity, input.fields ?? [])
      await this.versions.insertDraft(scope, entity.id, fields)
      return this.detail(scope, entity)
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      name?: string
      description?: string | null
      ownershipMode?: OwnershipMode
      presentation?: unknown
    }
  ): Promise<EntityDetail> {
    const issues: Issue[] = []
    const name = input.name?.trim()
    if (name !== undefined && (!name || name.length > 160)) {
      issues.push(issue('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).'))
    }
    if (input.ownershipMode !== undefined && !MODES.includes(input.ownershipMode)) {
      issues.push(issue('ownershipMode', 'INVALID_MODE', 'Modo de propriedade inválido.'))
    }
    const presentation =
      input.presentation === undefined
        ? undefined
        : normalizeEntityPresentation(input.presentation, issues)
    if (issues.length > 0) throw validationError(issues)

    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      if (
        input.ownershipMode !== undefined &&
        input.ownershipMode !== current.ownershipMode &&
        current.publishedVersion !== null
      ) {
        throw ApiError.conflict(
          'OWNERSHIP_LOCKED',
          'O modo de propriedade não muda depois de a entidade ser publicada.'
        )
      }
      const updated = await this.entities.update(scope, id, input.expectedVersion, {
        name,
        description:
          input.description === undefined ? undefined : input.description?.trim() || null,
        ownershipMode: input.ownershipMode,
        presentation,
      })
      return this.detail(scope, updated)
    }, context)
  }

  /** Substitui os campos do rascunho (a publicação é que valida a compatibilidade com a versão em vigor). */
  saveDraft(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; fields: unknown }
  ): Promise<EntityDetail> {
    return this.uow.run(async (scope) => {
      const entity = await this.mustFind(scope, id)
      this.assertNotArchived(entity)
      const draft = await this.versions.findDraft(scope, id)
      if (!draft)
        throw ApiError.conflict('NO_DRAFT', 'Não há rascunho: crie uma nova revisão primeiro.')
      const fields = await this.resolveFields(scope, entity, input.fields)
      const touched = await this.entities.update(scope, id, input.expectedVersion, {})
      await this.versions.replaceFields(scope, draft.id, fields)
      return this.detail(scope, touched)
    }, context)
  }

  /** Abre uma nova revisão em rascunho, a partir da versão publicada. */
  createDraft(context: TenantContext, id: string): Promise<EntityDetail> {
    return this.uow.run(async (scope) => {
      const entity = await this.mustFind(scope, id)
      this.assertNotArchived(entity)
      await this.entities.lock(scope, id)
      const published = await this.publishedOf(scope, entity)
      // Campos e opções arquivados não voltam ao rascunho: a publicação volta a arquivar o que faltar.
      const fields = (published?.fields ?? [])
        .filter((f) => !f.archived)
        .map((f) => ({ ...f, options: f.options.filter((o) => !o.archived) }))
      const draft = await this.versions.insertDraft(scope, id, fields)
      if (!draft) throw ApiError.conflict('DRAFT_EXISTS', 'Já existe um rascunho desta entidade.')
      return this.detail(scope, entity)
    }, context)
  }

  /** Remove uma entidade que nunca foi publicada (e o seu único rascunho): não tem registos. */
  delete(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const entity = await this.mustFind(scope, id)
      if (entity.publishedVersion !== null || entity.status !== 'DRAFT') {
        throw ApiError.conflict(
          'ENTITY_PUBLISHED',
          'Só se remove uma entidade que nunca foi publicada; uma publicada arquiva-se.'
        )
      }
      await this.entities.lock(scope, id)
      const draft = await this.versions.findDraft(scope, id)
      if (draft) await this.versions.deleteDraft(scope, draft.id)
      await this.entities.delete(scope, id)
    }, context)
  }

  discardDraft(context: TenantContext, id: string): Promise<EntityDetail> {
    return this.uow.run(async (scope) => {
      const entity = await this.mustFind(scope, id)
      const draft = await this.versions.findDraft(scope, id)
      if (!draft) throw ApiError.notFound('Não há rascunho.')
      if (entity.publishedVersion === null) {
        throw ApiError.conflict('FIRST_DRAFT', 'O primeiro rascunho só desaparece com a entidade.')
      }
      await this.versions.deleteDraft(scope, draft.id)
      return this.detail(scope, entity)
    }, context)
  }

  previewPublish(context: TenantContext, id: string): Promise<PublishPreview> {
    return this.uow.run(async (scope) => {
      const entity = await this.mustFind(scope, id)
      const { report, affected } = await this.evaluate(scope, entity)
      return {
        issues: report.issues,
        added: report.added,
        removed: report.removed,
        changed: report.changed,
        affectedRecords: affected,
        publishable: report.issues.length === 0,
      }
    }, context)
  }

  /**
   * Publica o rascunho. Uma alteração incompatível sem migração é recusada (409); nada se apaga:
   * campos e opções retirados ficam arquivados. A versão passa a imutável.
   */
  publish(context: TenantContext, id: string, expectedVersion: number): Promise<EntityDetail> {
    return this.uow.run(async (scope) => {
      const entity = await this.mustFind(scope, id)
      this.assertNotArchived(entity)
      await this.entities.lock(scope, id)
      const { draft, previous, report } = await this.evaluate(scope, entity)
      if (!draft) throw ApiError.conflict('NO_DRAFT', 'Não há rascunho para publicar.')
      if (report.issues.length > 0) {
        throw ApiError.conflict(
          'INCOMPATIBLE_SCHEMA',
          'A versão tem alterações incompatíveis com os registos existentes.',
          report.issues
        )
      }
      await this.versions.publish(scope, draft.id, report.effective)
      const stoppedBeingUnique = (previous?.fields ?? [])
        .filter((before) => before.validation.unique === true)
        .filter((before) => {
          const now = report.effective.find((f) => f.code === before.code)
          return !now || now.archived || now.validation.unique !== true
        })
        .map((f) => f.code)
      if (stoppedBeingUnique.length > 0) {
        await this.records.releaseUniqueFields(scope, id, stoppedBeingUnique)
      }
      const updated = await this.entities.update(scope, id, expectedVersion, {
        status: 'PUBLISHED',
        publishedVersion: draft.revision,
      })
      return this.detail(scope, updated)
    }, context)
  }

  /** Impede registos novos; os existentes continuam legíveis. Nada é apagado. */
  archive(context: TenantContext, id: string, expectedVersion: number): Promise<EntityDetail> {
    return this.uow.run(async (scope) => {
      const entity = await this.mustFind(scope, id)
      if (entity.status !== 'PUBLISHED') {
        throw ApiError.conflict('NOT_PUBLISHED', 'Só uma entidade publicada pode ser arquivada.')
      }
      const updated = await this.entities.update(scope, id, expectedVersion, { status: 'ARCHIVED' })
      return this.detail(scope, updated)
    }, context)
  }

  // --- internos ------------------------------------------------------------------------------

  private async mustFind(scope: TenantScope, id: string): Promise<EntityDefinition> {
    const entity = await this.entities.find(scope, id)
    if (!entity) throw ApiError.notFound()
    return entity
  }

  private assertNotArchived(entity: EntityDefinition) {
    if (entity.status === 'ARCHIVED') {
      throw ApiError.conflict('ENTITY_ARCHIVED', 'A entidade está arquivada.')
    }
  }

  private publishedOf(scope: TenantScope, entity: EntityDefinition) {
    return entity.publishedVersion === null
      ? Promise.resolve(null)
      : this.versions.findByRevision(scope, entity.id, entity.publishedVersion)
  }

  private async detail(scope: TenantScope, entity: EntityDefinition): Promise<EntityDetail> {
    // Em série: uma transacção tem uma só ligação.
    const draft = await this.versions.findDraft(scope, entity.id)
    const published = await this.publishedOf(scope, entity)
    const versions = await this.versions.list(scope, entity.id)
    return {
      entity,
      draft: draft && (await this.withReferenceCodes(scope, entity, draft)),
      published: published && (await this.withReferenceCodes(scope, entity, published)),
      versions,
    }
  }

  /** A saída indica o código da entidade de destino de cada referência (o id só serve dentro do servidor). */
  private async withReferenceCodes(
    scope: TenantScope,
    entity: EntityDefinition,
    version: SchemaVersion
  ): Promise<SchemaVersion> {
    const codes = new Map<string, string | null>([[entity.id, entity.code]])
    const fields: FieldSpec[] = []
    for (const field of version.fields) {
      if (field.referenceEntityId && !codes.has(field.referenceEntityId)) {
        const target = await this.entities.find(scope, field.referenceEntityId)
        codes.set(field.referenceEntityId, target?.code ?? null)
      }
      fields.push(
        field.referenceEntityId
          ? { ...field, referenceEntityCode: codes.get(field.referenceEntityId) ?? null }
          : field
      )
    }
    return { ...version, fields }
  }

  /** Compara o rascunho com a versão em vigor; as entidades referenciadas têm de estar publicadas. */
  private async evaluate(scope: TenantScope, entity: EntityDefinition) {
    const draft = await this.versions.findDraft(scope, entity.id)
    const previous = await this.publishedOf(scope, entity)
    const empty: CompatibilityReport = {
      issues: [],
      added: [],
      removed: [],
      changed: [],
      effective: [],
    }
    if (!draft) {
      return { draft: null, previous, report: empty, affected: 0 }
    }
    const report = previous
      ? checkCompatibility(previous.fields, draft.fields)
      : { ...empty, added: draft.fields.map((f) => f.code), effective: draft.fields }

    for (const field of draft.fields) {
      if (!field.referenceEntityId || field.referenceEntityId === entity.id) continue
      const target = await this.entities.find(scope, field.referenceEntityId)
      if (!target || target.publishedVersion === null || target.status === 'ARCHIVED') {
        report.issues.push(
          issue(
            `fields.${field.code}`,
            'REFERENCE_NOT_PUBLISHED',
            'A entidade de destino tem de estar publicada.'
          )
        )
      }
    }
    const affected = previous ? await this.records.countActive(scope, entity.id) : 0
    return { draft, previous, report, affected }
  }

  /** Valida os campos recebidos e resolve o código da entidade de destino para o seu id. */
  private async resolveFields(
    scope: TenantScope,
    entity: EntityDefinition,
    raw: unknown
  ): Promise<FieldSpec[]> {
    const issues: Issue[] = []
    const input = Array.isArray(raw) ? raw : raw === undefined ? [] : raw
    const resolved: unknown = Array.isArray(input)
      ? await Promise.all(
          input.map(async (item, i) => {
            if (typeof item !== 'object' || item === null) return item
            // O id de destino nunca vem do cliente: resolve-se aqui, a partir do código, neste tenant.
            const { referenceEntityCode, ...rest } = item as FieldDraftInput &
              Record<string, unknown>
            delete rest.referenceEntityId
            if (referenceEntityCode === undefined || referenceEntityCode === null) return rest
            if (typeof referenceEntityCode !== 'string') {
              issues.push(
                issue(`fields[${i}].referenceEntityCode`, 'INVALID_REFERENCE', 'Código inválido.')
              )
              return rest
            }
            const target =
              referenceEntityCode === entity.code
                ? entity
                : await this.entities.findByCode(scope, referenceEntityCode)
            if (!target || target.status === 'ARCHIVED') {
              issues.push(
                issue(
                  `fields[${i}].referenceEntityCode`,
                  'NOT_FOUND',
                  'Entidade de destino inexistente neste tenant.'
                )
              )
              return rest
            }
            return { ...rest, referenceEntityId: target.id }
          })
        )
      : input
    const unresolved = new Set(issues.map((i) => i.path))
    const specs = normalizeFields(resolved, issues)
    // Uma entidade de destino já recusada não gera também «destino em falta».
    const details = issues.filter((i) => i.code !== 'REFERENCE_REQUIRED' || !unresolved.has(i.path))
    if (details.length > 0) throw validationError(details)
    return specs
  }
}
