import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  CATEGORY_PATTERN,
  CODE_PATTERN,
  UUID_PATTERN,
  TEMPLATE_CHANNELS,
  normalizeSchema,
  renderTemplate,
  validateTemplateBody,
  validateValues,
  type Issue,
  type TemplateChannel,
  type VariableSchema,
} from '#modules/documents/domain/documents'
import { renderPdf } from '#modules/documents/domain/pdf'
import { AccessPolicy } from '#modules/documents/application/access'
import { documentValidation, failure } from '#modules/documents/application/errors'
import { documentView, type DocumentView } from '#modules/documents/application/document_use_cases'
import { documentResourceOf } from '#modules/documents/application/registry'
import type {
  AttachmentStore,
  Clock,
  DocumentStore,
  Limits,
  ObjectStorage,
  TemplateRecord,
  TemplateStore,
  TemplateVersionRecord,
} from '#modules/documents/application/ports'

const membershipOf = (context: TenantContext): string => {
  if (!context.membershipId) throw ApiError.notFound()
  return context.membershipId
}

export interface TemplateVersionView {
  id: string
  revision: number
  body: string
  variableSchema: VariableSchema
  status: TemplateVersionRecord['status']
  locale: string
  publishedAt: string | null
  version: number
  createdAt: string
}

const versionView = (v: TemplateVersionRecord): TemplateVersionView => ({
  id: v.id,
  revision: v.revision,
  body: v.body,
  variableSchema: v.variableSchema,
  status: v.status,
  locale: v.locale,
  publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
  version: v.version,
  createdAt: v.createdAt.toISOString(),
})

export interface TemplateView {
  id: string
  code: string
  name: string
  channel: TemplateChannel
  resourceType: string | null
  publishedRevision: number | null
  latestRevision: number | null
  version: number
  createdAt: string
}

const templateView = (t: TemplateRecord): TemplateView => ({
  id: t.id,
  code: t.code,
  name: t.name,
  channel: t.channel,
  resourceType: t.resourceType,
  publishedRevision: t.publishedRevision,
  latestRevision: t.latestRevision,
  version: t.version,
  createdAt: t.createdAt.toISOString(),
})

function content(input: { body?: unknown; variableSchema?: unknown; locale?: unknown }) {
  const issues: Issue[] = []
  const body = typeof input.body === 'string' ? input.body : ''
  const locale =
    typeof input.locale === 'string' && input.locale.trim() ? input.locale.trim() : 'pt-AO'
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale)) {
    issues.push({
      path: 'locale',
      code: 'INVALID',
      message: 'Língua inválida (por exemplo, pt-AO).',
    })
  }
  const schema = normalizeSchema(input.variableSchema ?? { variables: [] })
  issues.push(...schema.issues)
  if (schema.value) issues.push(...validateTemplateBody(body, schema.value))
  if (issues.length || !schema.value) throw documentValidation(issues)
  return { body, variableSchema: schema.value, locale }
}

/**
 * Modelos: o corpo só admite variáveis declaradas (`{{nome}}`), os valores saem escapados e nada se executa. Uma versão
 * publicada nunca muda; gerar um documento guarda a versão do modelo e os valores, por isso o que foi emitido não muda
 * quando o modelo muda.
 */
export class TemplateUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly templates: TemplateStore,
    private readonly documents: DocumentStore,
    private readonly attachments: AttachmentStore,
    private readonly storage: ObjectStorage,
    private readonly access: AccessPolicy,
    private readonly limits: Limits,
    private readonly clock: Clock
  ) {}

  async create(
    context: TenantContext,
    input: { code?: unknown; name?: unknown; channel?: unknown; resourceType?: unknown }
  ): Promise<TemplateView> {
    const issues: Issue[] = []
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!CODE_PATTERN.test(code)) {
      issues.push({ path: 'code', code: 'INVALID', message: 'Código inválido (a-z, 0-9 e _).' })
    }
    if (!name || name.length > 150) {
      issues.push({
        path: 'name',
        code: 'REQUIRED',
        message: 'Indique o nome (até 150 caracteres).',
      })
    }
    if (!(TEMPLATE_CHANNELS as readonly unknown[]).includes(input.channel)) {
      issues.push({ path: 'channel', code: 'INVALID', message: 'Canal inválido.' })
    }
    const resourceType =
      typeof input.resourceType === 'string' && input.resourceType.trim()
        ? input.resourceType.trim()
        : null
    if (resourceType && !documentResourceOf(resourceType)) {
      issues.push({
        path: 'resourceType',
        code: 'RESOURCE_TYPE_UNKNOWN',
        message: 'Tipo de recurso desconhecido.',
      })
    }
    if (issues.length) throw documentValidation(issues)
    return this.uow.run(async (scope) => {
      const created = await this.templates.insert(scope, {
        code,
        name,
        channel: input.channel as TemplateChannel,
        resourceType,
      })
      if (!created)
        throw ApiError.conflict('TEMPLATE_CODE_TAKEN', 'Já existe um modelo com este código.')
      return templateView(created)
    }, context)
  }

  list(context: TenantContext): Promise<TemplateView[]> {
    return this.uow.run(async (scope) => {
      const found = await this.templates.list(scope)
      return found.map(templateView)
    }, context)
  }

  async get(
    context: TenantContext,
    id: string
  ): Promise<{ template: TemplateView; versions: TemplateVersionView[] }> {
    return this.uow.run(async (scope) => {
      const template = await this.templates.find(scope, id)
      if (!template) throw ApiError.notFound()
      const versions = await this.templates.versions(scope, id)
      return { template: templateView(template), versions: versions.map(versionView) }
    }, context)
  }

  async addVersion(
    context: TenantContext,
    id: string,
    input: { body?: unknown; variableSchema?: unknown; locale?: unknown }
  ): Promise<TemplateVersionView> {
    const value = content(input)
    return this.uow.run(async (scope) => {
      if (!(await this.templates.find(scope, id))) throw ApiError.notFound()
      return versionView(await this.templates.addVersion(scope, id, value))
    }, context)
  }

  async updateDraft(
    context: TenantContext,
    id: string,
    versionId: string,
    version: number,
    input: { body?: unknown; variableSchema?: unknown; locale?: unknown }
  ): Promise<TemplateVersionView> {
    const value = content(input)
    return this.uow.run(async (scope) => {
      const current = await this.templates.lockVersion(scope, id, versionId)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT') {
        throw ApiError.conflict('TEMPLATE_VERSION_IMMUTABLE', 'Só um rascunho se altera.')
      }
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const updated = await this.templates.updateDraft(scope, versionId, version, value)
      if (!updated) throw ApiError.versionConflict(current.version)
      return versionView(updated)
    }, context)
  }

  async deleteDraft(context: TenantContext, id: string, versionId: string): Promise<void> {
    await this.uow.run(async (scope) => {
      const current = await this.templates.lockVersion(scope, id, versionId)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT') {
        throw ApiError.conflict('TEMPLATE_VERSION_IMMUTABLE', 'Só um rascunho se apaga.')
      }
      await this.templates.deleteDraft(scope, versionId)
    }, context)
  }

  /** Publica: a anterior da mesma língua passa a retirada; a nova fica imutável. */
  async publish(
    context: TenantContext,
    id: string,
    versionId: string
  ): Promise<TemplateVersionView> {
    const now = this.clock.now()
    return this.uow.run(async (scope) => {
      const current = await this.templates.lockVersion(scope, id, versionId)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT') {
        throw ApiError.conflict('TEMPLATE_NOT_DRAFT', 'Só um rascunho se publica.')
      }
      const issues = validateTemplateBody(current.body, current.variableSchema)
      if (issues.length) throw documentValidation(issues)
      return versionView(await this.templates.publish(scope, versionId, current.locale, now))
    }, context)
  }

  /** Pré-visualização com dados de teste: não grava nada, serve qualquer versão. */
  async preview(
    context: TenantContext,
    id: string,
    versionId: string,
    values: Record<string, unknown>
  ): Promise<{ text: string; html: string }> {
    return this.uow.run(async (scope) => {
      const version = await this.templates.findVersion(scope, id, versionId)
      if (!version) throw ApiError.notFound()
      const checked = validateValues(version.variableSchema, values)
      if (!checked.value) throw documentValidation(checked.issues)
      return {
        text: renderTemplate(version.body, checked.value, 'text'),
        html: renderTemplate(version.body, checked.value, 'html'),
      }
    }, context)
  }

  /**
   * Gera um documento (PDF) a partir da versão **publicada**. O ficheiro, a versão do modelo e os valores ficam
   * guardados: o documento emitido já não depende do modelo.
   */
  async generate(
    context: TenantContext,
    id: string,
    input: {
      title?: unknown
      locale?: unknown
      variables?: unknown
      categoryCode?: unknown
      visibility?: unknown
      resourceType?: unknown
      resourceId?: unknown
      documentId?: unknown
    }
  ): Promise<DocumentView> {
    membershipOf(context)
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title || title.length > 200) {
      throw failure('title', 'REQUIRED', 'Indique o título (até 200 caracteres).')
    }
    const values = (input.variables ?? {}) as Record<string, unknown>
    const now = this.clock.now()
    const prepared = await this.uow.run(async (scope) => {
      const template = await this.templates.find(scope, id)
      if (!template) throw ApiError.notFound()
      if (template.channel !== 'DOCUMENT') {
        throw ApiError.conflict('TEMPLATE_NOT_DOCUMENT', 'Só os modelos de documento geram PDF.')
      }
      const locale = typeof input.locale === 'string' && input.locale ? input.locale : undefined
      const version = await this.templates.publishedFor(scope, id, locale)
      if (!version) {
        throw ApiError.conflict('TEMPLATE_NOT_PUBLISHED', 'O modelo não tem uma versão publicada.')
      }
      const checked = validateValues(version.variableSchema, values)
      if (!checked.value) throw documentValidation(checked.issues)
      return { template, version, values: checked.value }
    }, context)

    const text = renderTemplate(prepared.version.body, prepared.values, 'text')
    const pdf = renderPdf({ title, body: text, generatedAt: now })
    const key = `${context.tenantId}/${now.getUTCFullYear()}/${randomUUID()}`
    const checksum = createHash('sha256').update(pdf).digest('hex')
    if (pdf.length > this.limits.maxFileBytes) {
      throw failure('variables', 'FILE_TOO_LARGE', 'O documento gerado excede o tamanho máximo.')
    }
    await this.storage.putBuffer(key, pdf)
    try {
      return await this.uow.run(async (scope) => {
        const used = await this.attachments.lockedUsage(scope, now)
        if (used + pdf.length > this.limits.tenantQuotaBytes) {
          throw failure('title', 'QUOTA_EXCEEDED', 'O espaço de armazenamento do tenant não chega.')
        }
        const attachment = await this.attachments.insert(scope, {
          storageKey: key,
          originalName: `${
            title
              .replace(/[^\p{L}\p{N}._ -]+/gu, '')
              .trim()
              .slice(0, 120) || 'documento'
          }.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          checksum,
          status: 'AVAILABLE',
          source: 'GENERATED',
          uploadExpiresAt: null,
          scannedAt: now,
        })
        const existingId = typeof input.documentId === 'string' ? input.documentId : null
        let documentId: string
        if (existingId) {
          if (!UUID_PATTERN.test(existingId)) throw ApiError.notFound()
          const doc = await this.documents.lock(scope, existingId)
          if (!doc || !(await this.access.canReadDocument(context, doc))) throw ApiError.notFound()
          documentId = doc.id
        } else {
          const resourceType = typeof input.resourceType === 'string' ? input.resourceType : null
          const resourceId = typeof input.resourceId === 'string' ? input.resourceId : null
          if (resourceId !== null && !UUID_PATTERN.test(resourceId)) {
            throw failure('resourceId', 'INVALID', 'O id do recurso tem de ser um UUID.')
          }
          if ((resourceType === null) !== (resourceId === null)) {
            throw failure(
              'resourceId',
              'INCOMPLETE',
              'Indique o tipo e o id do recurso, ou nenhum.'
            )
          }
          const visibility =
            input.visibility === 'TENANT' || input.visibility === 'RESOURCE'
              ? input.visibility
              : 'PRIVATE'
          if (resourceType && resourceId) {
            const resource = documentResourceOf(resourceType)
            if (!resource)
              throw failure(
                'resourceType',
                'RESOURCE_TYPE_UNKNOWN',
                'Tipo de recurso desconhecido.'
              )
            if (!(await this.access.canUseResource(context, resourceType, resourceId))) {
              throw failure(
                'resourceId',
                'RESOURCE_NOT_FOUND',
                'O recurso não existe ou não tem acesso a ele.'
              )
            }
            if (resource.protected && visibility !== 'RESOURCE') {
              throw failure(
                'visibility',
                'VISIBILITY_WIDENS_ACCESS',
                'Os documentos de um recurso protegido só se vêem com acesso ao recurso.'
              )
            }
          }
          if (visibility === 'RESOURCE' && !resourceType) {
            throw failure(
              'resourceType',
              'REQUIRED',
              'Um documento de recurso tem de indicar o recurso.'
            )
          }
          const category =
            typeof input.categoryCode === 'string' && input.categoryCode
              ? input.categoryCode
              : 'general'
          if (!CATEGORY_PATTERN.test(category)) {
            throw failure('categoryCode', 'INVALID', 'Categoria inválida (a-z, 0-9 e _).')
          }
          const created = await this.documents.insert(scope, {
            title,
            categoryCode: category,
            visibility,
            resourceType,
            resourceId,
            retentionUntil: null,
          })
          documentId = created.id
        }
        await this.documents.addVersion(scope, documentId, {
          attachmentId: attachment.id,
          changeNote: `Gerado do modelo ${prepared.template.code} (revisão ${prepared.version.revision}).`,
          templateVersionId: prepared.version.id,
          generatedValues: prepared.values,
        })
        return documentView((await this.documents.find(scope, documentId)) as never)
      }, context)
    } catch (error) {
      await this.storage.remove(key)
      throw error
    }
  }
}
