import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  UUID_PATTERN,
  normalizeDocument,
  type DocumentInput,
} from '#modules/documents/domain/documents'
import { AccessPolicy } from '#modules/documents/application/access'
import { documentValidation, failure, MAX_PAGE } from '#modules/documents/application/errors'
import { documentResourceOf, documentResourceTypes } from '#modules/documents/application/registry'
import type {
  Attachment,
  AttachmentStore,
  Clock,
  DocumentRecord,
  DocumentStore,
  DocumentVersionRecord,
  ObjectStorage,
  ResourceAttachmentRecord,
  ResourceAttachmentStore,
  Authorize,
} from '#modules/documents/application/ports'

const membershipOf = (context: TenantContext): string => {
  if (!context.membershipId) throw ApiError.notFound()
  return context.membershipId
}

export interface DocumentView {
  id: string
  title: string
  categoryCode: string
  ownerMembershipId: string
  visibility: DocumentRecord['visibility']
  resourceType: string | null
  resourceId: string | null
  retentionUntil: string | null
  legalHold: boolean
  version: number
  current: {
    versionId: string
    revision: number
    attachmentId: string
    fileName: string
    mimeType: string
    sizeBytes: number
    status: Attachment['status']
  } | null
  createdAt: string
  updatedAt: string
}

export const documentView = (d: DocumentRecord): DocumentView => ({
  id: d.id,
  title: d.title,
  categoryCode: d.categoryCode,
  ownerMembershipId: d.ownerMembershipId,
  visibility: d.visibility,
  resourceType: d.resourceType,
  resourceId: d.resourceId,
  retentionUntil: d.retentionUntil,
  legalHold: d.legalHold,
  version: d.version,
  current:
    d.currentVersionId && d.currentAttachmentId
      ? {
          versionId: d.currentVersionId,
          revision: d.currentRevision as number,
          attachmentId: d.currentAttachmentId,
          fileName: d.currentFileName as string,
          mimeType: d.currentMimeType as string,
          sizeBytes: d.currentSize as number,
          status: d.currentStatus as Attachment['status'],
        }
      : null,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
})

export interface VersionView {
  id: string
  revision: number
  attachmentId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  status: Attachment['status']
  changeNote: string | null
  templateVersionId: string | null
  createdAt: string
}

const versionView = (v: DocumentVersionRecord): VersionView => ({
  id: v.id,
  revision: v.revision,
  attachmentId: v.attachmentId,
  fileName: v.fileName,
  mimeType: v.mimeType,
  sizeBytes: v.sizeBytes,
  status: v.attachmentStatus,
  changeNote: v.changeNote,
  templateVersionId: v.templateVersionId,
  createdAt: v.createdAt.toISOString(),
})

/**
 * Documentos: título, categoria, visibilidade e versões imutáveis. A visibilidade nunca é mais larga do que a do
 * recurso a que o documento está ligado quando esse recurso é protegido (financeiro, clínico…).
 */
export class DocumentUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly documents: DocumentStore,
    private readonly attachments: AttachmentStore,
    private readonly storage: ObjectStorage,
    private readonly access: AccessPolicy,
    private readonly authorize: Authorize,
    private readonly clock: Clock
  ) {}

  private async checkTarget(
    context: TenantContext,
    input: Pick<DocumentInput, 'visibility' | 'resourceType' | 'resourceId'>
  ) {
    if (!input.resourceType || !input.resourceId) return
    const resource = documentResourceOf(input.resourceType)
    if (!resource) {
      throw failure(
        'resourceType',
        'RESOURCE_TYPE_UNKNOWN',
        `Tipo de recurso desconhecido. Aceites: ${documentResourceTypes().join(', ') || 'nenhum'}.`
      )
    }
    if (!(await this.access.canUseResource(context, input.resourceType, input.resourceId))) {
      throw failure(
        'resourceId',
        'RESOURCE_NOT_FOUND',
        'O recurso não existe ou não tem acesso a ele.'
      )
    }
    if (resource.protected && input.visibility !== 'RESOURCE') {
      throw failure(
        'visibility',
        'VISIBILITY_WIDENS_ACCESS',
        'Os documentos de um recurso protegido só se vêem com acesso ao recurso.'
      )
    }
  }

  /** O anexo tem de estar disponível, ser de quem o liga e não pertencer já a outra versão. */
  private async claimAttachment(
    scope: TenantScope,
    context: TenantContext,
    attachmentId: string
  ): Promise<Attachment> {
    const attachment = UUID_PATTERN.test(attachmentId)
      ? await this.attachments.find(scope, attachmentId)
      : null
    if (!attachment || attachment.uploadedByMembershipId !== membershipOf(context)) {
      throw failure('attachmentId', 'ATTACHMENT_NOT_FOUND', 'Ficheiro não encontrado.')
    }
    if (attachment.status !== 'AVAILABLE') {
      throw failure(
        'attachmentId',
        'ATTACHMENT_NOT_AVAILABLE',
        'Só se pode ligar um ficheiro depois de enviado e verificado.'
      )
    }
    if (await this.documents.attachmentIsLinked(scope, attachmentId)) {
      throw ApiError.conflict(
        'ATTACHMENT_ALREADY_LINKED',
        'Este ficheiro já pertence a uma versão.'
      )
    }
    return attachment
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<DocumentView> {
    membershipOf(context)
    const { value, issues } = normalizeDocument(input)
    if (issues.length) throw documentValidation(issues)
    const doc = value as DocumentInput
    await this.checkTarget(context, doc)
    const attachmentId = typeof input['attachmentId'] === 'string' ? input['attachmentId'] : ''
    const note = typeof input['changeNote'] === 'string' ? input['changeNote'].slice(0, 1000) : null
    return this.uow.run(async (scope) => {
      await this.claimAttachment(scope, context, attachmentId)
      const created = await this.documents.insert(scope, doc)
      await this.documents.addVersion(scope, created.id, {
        attachmentId,
        changeNote: note,
        templateVersionId: null,
        generatedValues: null,
      })
      return documentView((await this.documents.find(scope, created.id)) as DocumentRecord)
    }, context)
  }

  async list(
    context: TenantContext,
    filter: {
      search?: string
      categoryCode?: string
      resourceType?: string
      resourceId?: string
      limit?: number
      offset?: number
    }
  ): Promise<{ items: DocumentView[]; total: number }> {
    const membershipId = membershipOf(context)
    // Os tipos de recurso a que a pessoa tem acesso por permissão; a existência verifica-se linha a linha.
    const resourceTypes: string[] = []
    for (const type of documentResourceTypes()) {
      const resource = documentResourceOf(type)
      if (resource && (await this.authorize(context, resource.permission))) resourceTypes.push(type)
    }
    const limit = Math.min(filter.limit ?? 50, MAX_PAGE)
    return this.uow.run(async (scope) => {
      const { items, total } = await this.documents.list(
        scope,
        { ...filter, limit, offset: filter.offset ?? 0 },
        { membershipId, resourceTypes }
      )
      const visible: DocumentView[] = []
      for (const doc of items) {
        if (await this.access.canReadDocument(context, doc)) visible.push(documentView(doc))
      }
      return { items: visible, total }
    }, context)
  }

  private async readable(
    scope: TenantScope,
    context: TenantContext,
    id: string
  ): Promise<DocumentRecord> {
    const doc = await this.documents.find(scope, id)
    if (!doc || !(await this.access.canReadDocument(context, doc))) throw ApiError.notFound()
    return doc
  }

  async get(
    context: TenantContext,
    id: string
  ): Promise<{ document: DocumentView; versions: VersionView[] }> {
    return this.uow.run(async (scope) => {
      const doc = await this.readable(scope, context, id)
      const versions = await this.documents.versions(scope, id)
      return { document: documentView(doc), versions: versions.map(versionView) }
    }, context)
  }

  /** Só quem pode ler pode alterar, e só o dono altera um documento privado. */
  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<DocumentView> {
    const { value, issues } = normalizeDocument(input, true)
    const legalHold = input['legalHold']
    if (legalHold !== undefined && typeof legalHold !== 'boolean') {
      issues.push({ path: 'legalHold', code: 'INVALID', message: 'Indique verdadeiro ou falso.' })
    }
    if (issues.length) throw documentValidation(issues)
    return this.uow.run(async (scope) => {
      const current = await this.documents.lock(scope, id)
      if (!current || !(await this.access.canReadDocument(context, current))) {
        throw ApiError.notFound()
      }
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const next = {
        visibility: value.visibility ?? current.visibility,
        resourceType: value.resourceType !== undefined ? value.resourceType : current.resourceType,
        resourceId: value.resourceId !== undefined ? value.resourceId : current.resourceId,
      }
      if (next.visibility === 'RESOURCE' && !next.resourceType) {
        throw failure(
          'resourceType',
          'REQUIRED',
          'Um documento de recurso tem de indicar o recurso.'
        )
      }
      await this.checkTarget(context, next)
      const updated = await this.documents.update(scope, id, version, {
        ...value,
        ...(typeof legalHold === 'boolean' ? { legalHold } : {}),
      })
      if (!updated) throw ApiError.versionConflict(current.version)
      return documentView(updated)
    }, context)
  }

  async addVersion(
    context: TenantContext,
    id: string,
    input: { attachmentId?: unknown; changeNote?: unknown }
  ): Promise<VersionView> {
    const attachmentId = typeof input.attachmentId === 'string' ? input.attachmentId : ''
    const note = typeof input.changeNote === 'string' ? input.changeNote.slice(0, 1000) : null
    return this.uow.run(async (scope) => {
      const doc = await this.documents.lock(scope, id)
      if (!doc || !(await this.access.canReadDocument(context, doc))) throw ApiError.notFound()
      await this.claimAttachment(scope, context, attachmentId)
      return versionView(
        await this.documents.addVersion(scope, id, {
          attachmentId,
          changeNote: note,
          templateVersionId: null,
          generatedValues: null,
        })
      )
    }, context)
  }

  /**
   * Apaga (lógico). Retenção e retenção legal impedem-no; os ficheiros saem do armazenamento depois de confirmado.
   */
  async remove(context: TenantContext, id: string): Promise<void> {
    const today = this.clock.now().toISOString().slice(0, 10)
    const keys = await this.uow.run(async (scope) => {
      const doc = await this.documents.lock(scope, id)
      if (!doc || !(await this.access.canReadDocument(context, doc))) throw ApiError.notFound()
      if (doc.legalHold) {
        throw ApiError.conflict('DOCUMENT_LEGAL_HOLD', 'O documento está em retenção legal.')
      }
      if (doc.retentionUntil && doc.retentionUntil > today) {
        throw ApiError.conflict(
          'DOCUMENT_RETENTION',
          `O documento está retido até ${doc.retentionUntil}.`
        )
      }
      const files = await this.documents.attachmentsOf(scope, id)
      await this.documents.markDeleted(scope, id)
      for (const file of files) {
        await this.attachments.setStatus(scope, file.id, 'DELETED', {})
      }
      return files.map((f) => f.storageKey)
    }, context)
    for (const key of keys) await this.storage.remove(key)
  }
}

export interface ResourceAttachmentView {
  id: string
  resourceType: string
  resourceId: string
  attachmentId: string
  category: string | null
  fileName: string
  mimeType: string
  sizeBytes: number
  status: Attachment['status']
  createdAt: string
}

const linkView = (r: ResourceAttachmentRecord): ResourceAttachmentView => ({
  id: r.id,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  attachmentId: r.attachmentId,
  category: r.category,
  fileName: r.fileName,
  mimeType: r.mimeType,
  sizeBytes: r.sizeBytes,
  status: r.attachmentStatus,
  createdAt: r.createdAt.toISOString(),
})

/** Anexos directos a um recurso (por exemplo, o PDF assinado de uma factura). */
export class ResourceAttachmentUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly links: ResourceAttachmentStore,
    private readonly attachments: AttachmentStore,
    private readonly access: AccessPolicy
  ) {}

  private async resource(context: TenantContext, type: string, id: string) {
    if (!documentResourceOf(type)) {
      throw failure('resourceType', 'RESOURCE_TYPE_UNKNOWN', 'Tipo de recurso desconhecido.')
    }
    if (!(await this.access.canUseResource(context, type, id))) {
      throw failure(
        'resourceId',
        'RESOURCE_NOT_FOUND',
        'O recurso não existe ou não tem acesso a ele.'
      )
    }
  }

  async link(
    context: TenantContext,
    input: {
      resourceType?: unknown
      resourceId?: unknown
      attachmentId?: unknown
      category?: unknown
    }
  ): Promise<{ link: ResourceAttachmentView; created: boolean }> {
    const membershipId = membershipOf(context)
    const type = typeof input.resourceType === 'string' ? input.resourceType : ''
    const id = typeof input.resourceId === 'string' ? input.resourceId : ''
    const attachmentId = typeof input.attachmentId === 'string' ? input.attachmentId : ''
    const category =
      typeof input.category === 'string' && input.category.trim()
        ? input.category.trim().slice(0, 50)
        : null
    if (!UUID_PATTERN.test(id)) {
      throw failure('resourceId', 'INVALID', 'O id do recurso tem de ser um UUID.')
    }
    await this.resource(context, type, id)
    return this.uow.run(async (scope) => {
      const attachment = UUID_PATTERN.test(attachmentId)
        ? await this.attachments.find(scope, attachmentId)
        : null
      if (!attachment || attachment.uploadedByMembershipId !== membershipId) {
        throw failure('attachmentId', 'ATTACHMENT_NOT_FOUND', 'Ficheiro não encontrado.')
      }
      if (attachment.status !== 'AVAILABLE') {
        throw failure(
          'attachmentId',
          'ATTACHMENT_NOT_AVAILABLE',
          'Só se pode ligar um ficheiro depois de enviado e verificado.'
        )
      }
      const { record, created } = await this.links.insert(scope, {
        resourceType: type,
        resourceId: id,
        attachmentId,
        category,
      })
      return { link: linkView(record), created }
    }, context)
  }

  async list(
    context: TenantContext,
    resourceType: string,
    resourceId: string
  ): Promise<ResourceAttachmentView[]> {
    if (
      !documentResourceOf(resourceType) ||
      !(await this.access.canUseResource(context, resourceType, resourceId))
    ) {
      throw ApiError.notFound()
    }
    return this.uow.run(async (scope) => {
      const found = await this.links.list(scope, resourceType, resourceId)
      return found.map(linkView)
    }, context)
  }

  async unlink(context: TenantContext, id: string): Promise<void> {
    await this.uow.run(async (scope) => {
      const found = await this.links.find(scope, id)
      if (
        !found ||
        !(await this.access.canUseResource(context, found.resourceType, found.resourceId))
      ) {
        throw ApiError.notFound()
      }
      await this.links.remove(scope, id)
    }, context)
  }
}
