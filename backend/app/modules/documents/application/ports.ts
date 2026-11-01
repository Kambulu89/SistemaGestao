import type { Readable } from 'node:stream'
import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  AttachmentStatus,
  TemplateChannel,
  TemplateStatus,
  VariableSchema,
  Visibility,
} from '#modules/documents/domain/documents'

export interface Clock {
  now(): Date
}

// --- armazenamento, análise e URLs assinadas -------------------------------------------------------------

export class StorageLimitError extends Error {
  constructor() {
    super('O ficheiro excede o tamanho declarado.')
    this.name = 'StorageLimitError'
  }
}

/** Armazenamento de objectos. As chaves são sempre geradas pelo servidor; nunca vêm do cliente. */
export interface ObjectStorage {
  /** Grava o fluxo e devolve o tamanho e o SHA-256 reais. Excedendo `maxBytes` apaga o parcial e falha. */
  put(key: string, source: Readable, maxBytes: number): Promise<{ size: number; sha256: string }>
  putBuffer(key: string, data: Buffer): Promise<{ size: number; sha256: string }>
  open(key: string): Readable
  /** Os primeiros bytes (para reconhecer o tipo real). */
  head(key: string, bytes: number): Promise<Uint8Array>
  remove(key: string): Promise<void>
}

export interface ScanVerdict {
  clean: boolean
  signature?: string
}

/** Análise de conteúdo (antivírus). Sem verdicto limpo o ficheiro não fica disponível. */
export interface ContentScanner {
  scan(open: () => Readable): Promise<ScanVerdict>
}

export interface SignedDownload {
  tenantId: string
  attachmentId: string
  membershipId: string
  userId: string
  /** Segundos desde a época. */
  expiresAt: number
}

export interface UrlSigner {
  sign(payload: SignedDownload): string
  verify(token: string, now: Date): SignedDownload | null
}

// --- modelos de dados ------------------------------------------------------------------------------------

export interface Attachment {
  id: string
  storageKey: string
  originalName: string
  mimeType: string
  sizeBytes: number
  checksum: string
  receivedSize: number | null
  receivedChecksum: string | null
  status: AttachmentStatus
  source: 'UPLOAD' | 'GENERATED'
  rejectCode: string | null
  uploadedByMembershipId: string
  uploadExpiresAt: Date | null
  scannedAt: Date | null
  createdAt: Date
  version: number
}

export interface NewAttachment {
  storageKey: string
  originalName: string
  mimeType: string
  sizeBytes: number
  checksum: string
  status: AttachmentStatus
  source: 'UPLOAD' | 'GENERATED'
  uploadExpiresAt: Date | null
  scannedAt: Date | null
}

export interface DocumentRecord {
  id: string
  title: string
  categoryCode: string
  ownerMembershipId: string
  visibility: Visibility
  resourceType: string | null
  resourceId: string | null
  currentVersionId: string | null
  currentRevision: number | null
  currentAttachmentId: string | null
  currentFileName: string | null
  currentMimeType: string | null
  currentSize: number | null
  currentStatus: AttachmentStatus | null
  retentionUntil: string | null
  legalHold: boolean
  status: 'ACTIVE' | 'DELETED'
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface DocumentVersionRecord {
  id: string
  documentId: string
  revision: number
  attachmentId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  attachmentStatus: AttachmentStatus
  changeNote: string | null
  templateVersionId: string | null
  createdByMembershipId: string | null
  createdAt: Date
}

export interface DocumentFilter {
  search?: string
  categoryCode?: string
  resourceType?: string
  resourceId?: string
  limit: number
  offset: number
}

export interface Access {
  /** O membro que carregou, para anexos ainda sem vínculo. */
  uploadedBy: string
  documents: DocumentRecord[]
  resources: { resourceType: string; resourceId: string }[]
}

export interface AttachmentStore {
  insert(scope: TenantScope, v: NewAttachment): Promise<Attachment>
  find(scope: TenantScope, id: string): Promise<Attachment | null>
  /** `FOR UPDATE`: serializa pedidos concorrentes sobre o mesmo anexo. */
  lock(scope: TenantScope, id: string): Promise<Attachment | null>
  markReceived(
    scope: TenantScope,
    id: string,
    size: number,
    sha256: string
  ): Promise<Attachment | null>
  setStatus(
    scope: TenantScope,
    id: string,
    status: AttachmentStatus,
    extra: { rejectCode?: string | null; signature?: string | null; scannedAt?: Date | null }
  ): Promise<Attachment>
  /** Bytes ocupados (PENDING não expirado, QUARANTINED e AVAILABLE), sob um bloqueio por tenant. */
  lockedUsage(scope: TenantScope, now: Date): Promise<number>
  access(scope: TenantScope, id: string): Promise<Access>
  /** Pendentes expirados, para limpeza. */
  expired(scope: TenantScope, now: Date, limit: number): Promise<Attachment[]>
}

export interface NewDocument {
  title: string
  categoryCode: string
  visibility: Visibility
  resourceType: string | null
  resourceId: string | null
  retentionUntil: string | null
}

export interface DocumentStore {
  insert(scope: TenantScope, v: NewDocument): Promise<DocumentRecord>
  find(scope: TenantScope, id: string): Promise<DocumentRecord | null>
  lock(scope: TenantScope, id: string): Promise<DocumentRecord | null>
  list(
    scope: TenantScope,
    filter: DocumentFilter,
    visible: { membershipId: string; resourceTypes: readonly string[] }
  ): Promise<{ items: DocumentRecord[]; total: number }>
  update(
    scope: TenantScope,
    id: string,
    version: number,
    patch: Partial<NewDocument> & { legalHold?: boolean }
  ): Promise<DocumentRecord | null>
  addVersion(
    scope: TenantScope,
    documentId: string,
    v: {
      attachmentId: string
      changeNote: string | null
      templateVersionId: string | null
      generatedValues: Record<string, string> | null
    }
  ): Promise<DocumentVersionRecord>
  versions(scope: TenantScope, documentId: string): Promise<DocumentVersionRecord[]>
  markDeleted(scope: TenantScope, id: string): Promise<DocumentRecord>
  attachmentsOf(scope: TenantScope, documentId: string): Promise<Attachment[]>
  attachmentIsLinked(scope: TenantScope, attachmentId: string): Promise<boolean>
}

export interface ResourceAttachmentRecord {
  id: string
  resourceType: string
  resourceId: string
  attachmentId: string
  category: string | null
  fileName: string
  mimeType: string
  sizeBytes: number
  attachmentStatus: AttachmentStatus
  createdAt: Date
}

export interface ResourceAttachmentStore {
  insert(
    scope: TenantScope,
    v: { resourceType: string; resourceId: string; attachmentId: string; category: string | null }
  ): Promise<{ record: ResourceAttachmentRecord; created: boolean }>
  list(
    scope: TenantScope,
    resourceType: string,
    resourceId: string
  ): Promise<ResourceAttachmentRecord[]>
  find(scope: TenantScope, id: string): Promise<ResourceAttachmentRecord | null>
  remove(scope: TenantScope, id: string): Promise<void>
}

export interface TemplateRecord {
  id: string
  code: string
  name: string
  channel: TemplateChannel
  resourceType: string | null
  version: number
  /** A versão publicada mais recente, se existir. */
  publishedRevision: number | null
  latestRevision: number | null
  createdAt: Date
}

export interface TemplateVersionRecord {
  id: string
  templateId: string
  revision: number
  body: string
  variableSchema: VariableSchema
  status: TemplateStatus
  locale: string
  publishedAt: Date | null
  version: number
  createdAt: Date
}

export interface TemplateStore {
  insert(
    scope: TenantScope,
    v: { code: string; name: string; channel: TemplateChannel; resourceType: string | null }
  ): Promise<TemplateRecord | null>
  find(scope: TenantScope, id: string): Promise<TemplateRecord | null>
  list(scope: TenantScope): Promise<TemplateRecord[]>
  versions(scope: TenantScope, templateId: string): Promise<TemplateVersionRecord[]>
  findVersion(
    scope: TenantScope,
    templateId: string,
    versionId: string
  ): Promise<TemplateVersionRecord | null>
  lockVersion(
    scope: TenantScope,
    templateId: string,
    versionId: string
  ): Promise<TemplateVersionRecord | null>
  addVersion(
    scope: TenantScope,
    templateId: string,
    v: { body: string; variableSchema: VariableSchema; locale: string }
  ): Promise<TemplateVersionRecord>
  updateDraft(
    scope: TenantScope,
    versionId: string,
    expected: number,
    v: { body: string; variableSchema: VariableSchema; locale: string }
  ): Promise<TemplateVersionRecord | null>
  deleteDraft(scope: TenantScope, versionId: string): Promise<void>
  /** Retira a publicada da mesma língua e publica esta, numa só operação. */
  publish(
    scope: TenantScope,
    versionId: string,
    locale: string,
    at: Date
  ): Promise<TemplateVersionRecord>
  publishedFor(
    scope: TenantScope,
    templateId: string,
    locale?: string
  ): Promise<TemplateVersionRecord | null>
}

// --- ligação a recursos de outros módulos ----------------------------------------------------------------

/** O que um módulo regista para que um recurso seu possa ter documentos (ResourceRegistry). */
export interface DocumentResource {
  /** Permissão exigida para ver os documentos do recurso. */
  permission: string
  /**
   * Conteúdo protegido (financeiro, clínico…): os documentos do recurso só se vêem com acesso ao recurso, nunca por
   * partilha mais ampla.
   */
  protected: boolean
  /** O recurso existe no tenant do contexto e o actor pode vê-lo. */
  exists(context: TenantContext, id: string): Promise<boolean>
}

export type Authorize = (context: TenantContext, permission: string) => Promise<boolean>

export interface Limits {
  maxFileBytes: number
  tenantQuotaBytes: number
  uploadTtlSeconds: number
  downloadTtlSeconds: number
}
