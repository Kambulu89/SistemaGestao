import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { securityEvents } from '#core/audit/index'
import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import { normalizePrepare, verifyContent } from '#modules/documents/domain/documents'
import { AccessPolicy } from '#modules/documents/application/access'
import { documentValidation, failure } from '#modules/documents/application/errors'
import {
  StorageLimitError,
  type Attachment,
  type AttachmentStore,
  type Clock,
  type ContentScanner,
  type Limits,
  type ObjectStorage,
  type UrlSigner,
} from '#modules/documents/application/ports'

/** O que o cliente vê de um anexo: nunca a chave de armazenamento. */
export interface AttachmentView {
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  checksum: string
  status: Attachment['status']
  rejectCode: string | null
  scannedAt: string | null
  createdAt: string
  /** Só um anexo disponível se descarrega. */
  downloadable: boolean
}

export const viewOf = (a: Attachment): AttachmentView => ({
  id: a.id,
  originalName: a.originalName,
  mimeType: a.mimeType,
  sizeBytes: a.sizeBytes,
  checksum: a.checksum,
  status: a.status,
  rejectCode: a.rejectCode,
  scannedAt: a.scannedAt ? a.scannedAt.toISOString() : null,
  createdAt: a.createdAt.toISOString(),
  downloadable: a.status === 'AVAILABLE',
})

const membershipOf = (context: TenantContext): string => {
  if (!context.membershipId) throw ApiError.notFound()
  return context.membershipId
}

const unavailable = (status: string) =>
  new ApiError(409, 'ATTACHMENT_UNAVAILABLE', 'O ficheiro não está disponível para descarga.', [
    { path: 'status', code: status, message: `Estado do ficheiro: ${status}.` },
  ])

/**
 * Anexos: preparar → enviar → concluir. O servidor decide a chave, confere o tamanho e o SHA-256 recebidos, reconhece o
 * tipo real pelo conteúdo, analisa-o e só então o torna `AVAILABLE`. Antes disso (e se for suspeito) não se descarrega.
 */
export class AttachmentUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly attachments: AttachmentStore,
    private readonly storage: ObjectStorage,
    private readonly scanner: ContentScanner,
    private readonly signer: UrlSigner,
    private readonly access: AccessPolicy,
    private readonly limits: Limits,
    private readonly clock: Clock
  ) {}

  /** Autoriza a quota e reserva a chave. Nada é gravado em disco ainda. */
  async prepare(context: TenantContext, input: Record<string, unknown>): Promise<AttachmentView> {
    membershipOf(context)
    const { value, issues } = normalizePrepare(input, this.limits.maxFileBytes)
    if (!value) throw documentValidation(issues)
    const now = this.clock.now()
    return this.uow.run(async (scope) => {
      const used = await this.attachments.lockedUsage(scope, now)
      if (used + value.sizeBytes > this.limits.tenantQuotaBytes) {
        throw failure(
          'sizeBytes',
          'QUOTA_EXCEEDED',
          'O espaço de armazenamento do tenant não chega para este ficheiro.'
        )
      }
      const key = `${context.tenantId}/${now.getUTCFullYear()}/${randomUUID()}`
      const created = await this.attachments.insert(scope, {
        storageKey: key,
        originalName: value.fileName,
        mimeType: value.mimeType,
        sizeBytes: value.sizeBytes,
        checksum: value.checksum,
        status: 'PENDING',
        source: 'UPLOAD',
        uploadExpiresAt: new Date(now.getTime() + this.limits.uploadTtlSeconds * 1000),
        scannedAt: null,
      })
      return viewOf(created)
    }, context)
  }

  /** Recebe o conteúdo. Só quem preparou o carrega, e só enquanto está pendente e por expirar. */
  async receive(context: TenantContext, id: string, source: Readable): Promise<AttachmentView> {
    const membershipId = membershipOf(context)
    const now = this.clock.now()
    const current = await this.uow.run(async (scope) => {
      const found = await this.attachments.find(scope, id)
      if (!found || found.uploadedByMembershipId !== membershipId) throw ApiError.notFound()
      if (found.status !== 'PENDING') {
        throw ApiError.conflict('ATTACHMENT_NOT_PENDING', 'Este ficheiro já não aceita conteúdo.')
      }
      if (found.uploadExpiresAt && found.uploadExpiresAt < now) {
        throw ApiError.conflict('UPLOAD_EXPIRED', 'O pedido de upload expirou; prepare outro.')
      }
      return found
    }, context)

    let stored: { size: number; sha256: string }
    try {
      stored = await this.storage.put(current.storageKey, source, current.sizeBytes)
    } catch (error) {
      if (error instanceof StorageLimitError) {
        await this.reject(context, id, 'SIZE_MISMATCH', current.storageKey)
        throw failure('sizeBytes', 'SIZE_MISMATCH', 'O ficheiro excede o tamanho declarado.')
      }
      throw error
    }
    const updated = await this.uow.run(
      (scope) => this.attachments.markReceived(scope, id, stored.size, stored.sha256),
      context
    )
    if (!updated) {
      throw ApiError.conflict('ATTACHMENT_NOT_PENDING', 'Este ficheiro já não aceita conteúdo.')
    }
    return viewOf(updated)
  }

  /** Conclui: confere, reconhece o tipo real, analisa e torna disponível. Repetir devolve o estado actual. */
  async complete(context: TenantContext, id: string): Promise<AttachmentView> {
    const membershipId = membershipOf(context)
    const current = await this.uow.run(async (scope) => {
      const found = await this.attachments.find(scope, id)
      if (!found || found.uploadedByMembershipId !== membershipId) throw ApiError.notFound()
      return found
    }, context)
    if (current.status !== 'PENDING') return viewOf(current)
    if (current.receivedSize === null || current.receivedChecksum === null) {
      throw ApiError.conflict('NOT_UPLOADED', 'O conteúdo ainda não foi enviado.')
    }
    if (current.receivedSize !== current.sizeBytes) {
      return this.rejectAndFail(
        context,
        current,
        'SIZE_MISMATCH',
        'O tamanho recebido não coincide com o declarado.'
      )
    }
    if (current.receivedChecksum !== current.checksum) {
      return this.rejectAndFail(
        context,
        current,
        'CHECKSUM_MISMATCH',
        'O SHA-256 recebido não coincide com o declarado.'
      )
    }
    const head = await this.storage.head(current.storageKey, 8192)
    const verdict = verifyContent(head, current.mimeType)
    if (!verdict.ok) {
      return this.rejectAndFail(
        context,
        current,
        verdict.code,
        verdict.code === 'MIME_MISMATCH'
          ? 'O conteúdo não corresponde ao tipo declarado.'
          : 'Tipo de ficheiro não permitido.'
      )
    }
    let scan
    try {
      scan = await this.scanner.scan(() => this.storage.open(current.storageKey))
    } catch {
      throw new ApiError(
        503,
        'SCAN_UNAVAILABLE',
        'A análise do ficheiro não está disponível; tente de novo.'
      )
    }
    const now = this.clock.now()
    if (!scan.clean) {
      const quarantined = await this.uow.run(async (scope) => {
        const locked = await this.attachments.lock(scope, id)
        if (!locked || locked.status !== 'PENDING') return locked
        return this.attachments.setStatus(scope, id, 'QUARANTINED', {
          signature: scan.signature ?? null,
          scannedAt: now,
        })
      }, context)
      await securityEvents.record({
        type: 'ATTACHMENT_QUARANTINED',
        severity: 'HIGH',
        tenantId: context.tenantId,
        userId: context.userId,
        metadata: { attachmentId: id, detection: scan.signature ?? null },
      })
      return viewOf(quarantined as Attachment)
    }
    const done = await this.uow.run(async (scope) => {
      const locked = await this.attachments.lock(scope, id)
      if (!locked || locked.status !== 'PENDING') return locked
      return this.attachments.setStatus(scope, id, 'AVAILABLE', { scannedAt: now })
    }, context)
    return viewOf(done as Attachment)
  }

  async get(context: TenantContext, id: string): Promise<AttachmentView> {
    return this.uow.run(async (scope) => {
      const found = await this.attachments.find(scope, id)
      if (!found || found.status === 'DELETED') throw ApiError.notFound()
      const access = await this.attachments.access(scope, id)
      if (!(await this.access.canReadAttachment(context, access))) throw ApiError.notFound()
      return viewOf(found)
    }, context)
  }

  /** URL de descarga curta, emitida só depois de autorizar. */
  async downloadUrl(
    context: TenantContext,
    id: string
  ): Promise<{ url: string; expiresAt: string }> {
    const membershipId = membershipOf(context)
    await this.authorizeDownload(context, id)
    const expiresAt = Math.floor(this.clock.now().getTime() / 1000) + this.limits.downloadTtlSeconds
    const token = this.signer.sign({
      tenantId: context.tenantId,
      attachmentId: id,
      membershipId,
      userId: context.userId as string,
      expiresAt,
    })
    return { url: `/api/v1/files/${token}`, expiresAt: new Date(expiresAt * 1000).toISOString() }
  }

  /** Descarga (autenticada por sessão e tenant, ou pelo token depois de revalidar o acesso). */
  async open(
    context: TenantContext,
    id: string
  ): Promise<{ attachment: Attachment; stream: Readable }> {
    const attachment = await this.authorizeDownload(context, id)
    return { attachment, stream: this.storage.open(attachment.storageKey) }
  }

  /** O token é só um convite: tenant, anexo e membro vêm dele, mas o acesso volta a decidir-se agora. */
  parseToken(token: string) {
    return this.signer.verify(token, this.clock.now())
  }

  private async authorizeDownload(context: TenantContext, id: string): Promise<Attachment> {
    return this.uow.run(async (scope) => {
      const found = await this.attachments.find(scope, id)
      if (!found || found.status === 'DELETED') throw ApiError.notFound()
      const access = await this.attachments.access(scope, id)
      if (!(await this.access.canReadAttachment(context, access))) throw ApiError.notFound()
      if (found.status !== 'AVAILABLE') throw unavailable(found.status)
      return found
    }, context)
  }

  private async reject(context: TenantContext, id: string, code: string, key: string) {
    await this.uow.run(async (scope) => {
      const locked = await this.attachments.lock(scope, id)
      if (locked?.status === 'PENDING') {
        await this.attachments.setStatus(scope, id, 'REJECTED', { rejectCode: code })
      }
    }, context)
    await this.storage.remove(key)
    await securityEvents.record({
      type: 'ATTACHMENT_REJECTED',
      severity: 'WARN',
      tenantId: context.tenantId,
      userId: context.userId,
      metadata: { attachmentId: id, code },
    })
  }

  private async rejectAndFail(
    context: TenantContext,
    attachment: Attachment,
    code: string,
    message: string
  ): Promise<never> {
    await this.reject(context, attachment.id, code, attachment.storageKey)
    throw failure('file', code, message)
  }
}
