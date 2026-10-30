import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  AttachmentStatus,
  TemplateChannel,
  TemplateStatus,
  VariableSchema,
  Visibility,
} from '#modules/documents/domain/documents'
import type {
  Access,
  Attachment,
  AttachmentStore,
  DocumentFilter,
  DocumentRecord,
  DocumentStore,
  DocumentVersionRecord,
  NewAttachment,
  NewDocument,
  ResourceAttachmentRecord,
  ResourceAttachmentStore,
  TemplateRecord,
  TemplateStore,
  TemplateVersionRecord,
} from '#modules/documents/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

type Bind = never[]
const query = async <T>(scope: TenantScope, sql: string, bindings: unknown[]): Promise<T[]> => {
  const result = await trxOf(scope).rawQuery(sql, bindings as Bind)
  return result.rows as T[]
}

const iso = (value: Date | string | null): string | null =>
  value === null
    ? null
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10)

// --- anexos -------------------------------------------------------------------------------------------

interface AttachmentRow {
  id: string
  storage_key: string
  original_name: string
  mime_type: string
  size_bytes: string | number
  checksum: string
  received_size: string | number | null
  received_checksum: string | null
  status: AttachmentStatus
  source: 'UPLOAD' | 'GENERATED'
  reject_code: string | null
  uploaded_by_membership_id: string
  upload_expires_at: Date | null
  scanned_at: Date | null
  created_at: Date
  version: number
}

const ATTACHMENT_COLUMNS = `id, storage_key, original_name, mime_type, size_bytes, checksum, received_size,
  received_checksum, status, source, reject_code, uploaded_by_membership_id, upload_expires_at, scanned_at,
  created_at, version`

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  storageKey: r.storage_key,
  originalName: r.original_name,
  mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes),
  checksum: r.checksum,
  receivedSize: r.received_size === null ? null : Number(r.received_size),
  receivedChecksum: r.received_checksum,
  status: r.status,
  source: r.source,
  rejectCode: r.reject_code,
  uploadedByMembershipId: r.uploaded_by_membership_id,
  uploadExpiresAt: r.upload_expires_at,
  scannedAt: r.scanned_at,
  createdAt: r.created_at,
  version: r.version,
})

export class LucidAttachmentStore implements AttachmentStore {
  async insert(scope: TenantScope, v: NewAttachment) {
    const rows = await query<AttachmentRow>(
      scope,
      `insert into attachments (tenant_id, storage_key, original_name, mime_type, size_bytes, checksum, status, source,
         upload_expires_at, scanned_at, uploaded_by_membership_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${ATTACHMENT_COLUMNS}`,
      [
        tenantOf(scope),
        v.storageKey,
        v.originalName,
        v.mimeType,
        v.sizeBytes,
        v.checksum,
        v.status,
        v.source,
        v.uploadExpiresAt,
        v.scannedAt,
        actorOf(scope),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toAttachment(rows[0] as AttachmentRow)
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<AttachmentRow>(
      scope,
      `select ${ATTACHMENT_COLUMNS} from attachments where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toAttachment(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    const rows = await query<AttachmentRow>(
      scope,
      `select ${ATTACHMENT_COLUMNS} from attachments where tenant_id = ? and id = ? for update`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toAttachment(rows[0]) : null
  }

  async markReceived(scope: TenantScope, id: string, size: number, sha256: string) {
    const rows = await query<AttachmentRow>(
      scope,
      `update attachments set received_size = ?, received_checksum = ?, updated_at = now(), version = version + 1,
              updated_by_membership_id = ?
        where tenant_id = ? and id = ? and status = 'PENDING' returning ${ATTACHMENT_COLUMNS}`,
      [size, sha256, actorOf(scope), tenantOf(scope), id]
    )
    return rows[0] ? toAttachment(rows[0]) : null
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    status: AttachmentStatus,
    extra: { rejectCode?: string | null; signature?: string | null; scannedAt?: Date | null }
  ) {
    const rows = await query<AttachmentRow>(
      scope,
      `update attachments set status = ?, reject_code = coalesce(?, reject_code),
              scan_signature = coalesce(?, scan_signature), scanned_at = coalesce(?, scanned_at),
              deleted_at = case when ? = 'DELETED' then now() else deleted_at end,
              updated_at = now(), version = version + 1, updated_by_membership_id = ?
        where tenant_id = ? and id = ? returning ${ATTACHMENT_COLUMNS}`,
      [
        status,
        extra.rejectCode ?? null,
        extra.signature ?? null,
        extra.scannedAt ?? null,
        status,
        actorOf(scope),
        tenantOf(scope),
        id,
      ]
    )
    return toAttachment(rows[0] as AttachmentRow)
  }

  async lockedUsage(scope: TenantScope, now: Date) {
    await query(scope, `select pg_advisory_xact_lock(hashtextextended(?, 0))`, [
      `documents-quota:${tenantOf(scope)}`,
    ])
    const rows = await query<{ used: string | null }>(
      scope,
      `select coalesce(sum(size_bytes), 0) as used from attachments
        where tenant_id = ?
          and (status in ('QUARANTINED', 'AVAILABLE')
               or (status = 'PENDING' and (upload_expires_at is null or upload_expires_at > ?)))`,
      [tenantOf(scope), now]
    )
    return Number(rows[0]?.used ?? 0)
  }

  async access(scope: TenantScope, id: string): Promise<Access> {
    const [attachment] = await query<{ uploaded_by_membership_id: string }>(
      scope,
      `select uploaded_by_membership_id from attachments where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const docs = await query<DocumentRow>(
      scope,
      `${DOCUMENT_SELECT}
        where d.tenant_id = ? and d.status = 'ACTIVE'
          and d.id in (select document_id from document_versions where tenant_id = ? and attachment_id = ?)`,
      [tenantOf(scope), tenantOf(scope), id]
    )
    const links = await query<{ resource_type: string; resource_id: string }>(
      scope,
      `select resource_type, resource_id from resource_attachments where tenant_id = ? and attachment_id = ?`,
      [tenantOf(scope), id]
    )
    return {
      uploadedBy: attachment?.uploaded_by_membership_id ?? '',
      documents: docs.map(toDocument),
      resources: links.map((l) => ({ resourceType: l.resource_type, resourceId: l.resource_id })),
    }
  }

  async expired(scope: TenantScope, now: Date, limit: number) {
    const rows = await query<AttachmentRow>(
      scope,
      `select ${ATTACHMENT_COLUMNS} from attachments
        where tenant_id = ? and status = 'PENDING' and upload_expires_at < ? limit ?`,
      [tenantOf(scope), now, limit]
    )
    return rows.map(toAttachment)
  }
}

// --- documentos ---------------------------------------------------------------------------------------

interface DocumentRow {
  id: string
  title: string
  category_code: string
  owner_membership_id: string
  visibility: Visibility
  resource_type: string | null
  resource_id: string | null
  current_version_id: string | null
  cur_revision: number | null
  cur_attachment_id: string | null
  cur_file_name: string | null
  cur_mime_type: string | null
  cur_size: string | number | null
  cur_status: AttachmentStatus | null
  retention_until: Date | string | null
  legal_hold: boolean
  status: 'ACTIVE' | 'DELETED'
  version: number
  created_at: Date
  updated_at: Date
}

const DOCUMENT_SELECT = `select d.id, d.title, d.category_code, d.owner_membership_id, d.visibility, d.resource_type,
    d.resource_id, d.current_version_id, v.revision as cur_revision, v.attachment_id as cur_attachment_id,
    a.original_name as cur_file_name, a.mime_type as cur_mime_type, a.size_bytes as cur_size, a.status as cur_status,
    d.retention_until, d.legal_hold, d.status, d.version, d.created_at, d.updated_at
  from documents d
  left join document_versions v on v.tenant_id = d.tenant_id and v.id = d.current_version_id
  left join attachments a on a.tenant_id = v.tenant_id and a.id = v.attachment_id`

const toDocument = (r: DocumentRow): DocumentRecord => ({
  id: r.id,
  title: r.title,
  categoryCode: r.category_code,
  ownerMembershipId: r.owner_membership_id,
  visibility: r.visibility,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  currentVersionId: r.current_version_id,
  currentRevision: r.cur_revision,
  currentAttachmentId: r.cur_attachment_id,
  currentFileName: r.cur_file_name,
  currentMimeType: r.cur_mime_type,
  currentSize: r.cur_size === null ? null : Number(r.cur_size),
  currentStatus: r.cur_status,
  retentionUntil: iso(r.retention_until),
  legalHold: r.legal_hold,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface VersionRow {
  id: string
  document_id: string
  revision: number
  attachment_id: string
  original_name: string
  mime_type: string
  size_bytes: string | number
  att_status: AttachmentStatus
  change_note: string | null
  template_version_id: string | null
  created_by_membership_id: string | null
  created_at: Date
}

const toVersion = (r: VersionRow): DocumentVersionRecord => ({
  id: r.id,
  documentId: r.document_id,
  revision: r.revision,
  attachmentId: r.attachment_id,
  fileName: r.original_name,
  mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes),
  attachmentStatus: r.att_status,
  changeNote: r.change_note,
  templateVersionId: r.template_version_id,
  createdByMembershipId: r.created_by_membership_id,
  createdAt: r.created_at,
})

const VERSION_SELECT = `select v.id, v.document_id, v.revision, v.attachment_id, a.original_name, a.mime_type,
    a.size_bytes, a.status as att_status, v.change_note, v.template_version_id, v.created_by_membership_id, v.created_at
  from document_versions v join attachments a on a.tenant_id = v.tenant_id and a.id = v.attachment_id`

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

export class LucidDocumentStore implements DocumentStore {
  async insert(scope: TenantScope, v: NewDocument) {
    const rows = await query<{ id: string }>(
      scope,
      `insert into documents (tenant_id, title, category_code, owner_membership_id, visibility, resource_type,
         resource_id, retention_until, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.title,
        v.categoryCode,
        actorOf(scope),
        v.visibility,
        v.resourceType,
        v.resourceId,
        v.retentionUntil,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return (await this.find(scope, (rows[0] as { id: string }).id)) as DocumentRecord
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<DocumentRow>(
      scope,
      `${DOCUMENT_SELECT} where d.tenant_id = ? and d.id = ?`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toDocument(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    await query(scope, `select 1 from documents where tenant_id = ? and id = ? for update`, [
      tenantOf(scope),
      id,
    ])
    return this.find(scope, id)
  }

  async list(
    scope: TenantScope,
    filter: DocumentFilter,
    visible: { membershipId: string; resourceTypes: readonly string[] }
  ) {
    const where = [
      `d.tenant_id = ?`,
      `d.status = 'ACTIVE'`,
      `(d.visibility = 'TENANT'
        or (d.visibility = 'PRIVATE' and d.owner_membership_id = ?)
        or (d.visibility = 'RESOURCE' and d.resource_type = any(?::text[])))`,
    ]
    const binds: unknown[] = [tenantOf(scope), visible.membershipId, [...visible.resourceTypes]]
    if (filter.search) {
      where.push(`d.title ilike ? escape '\\'`)
      binds.push(`%${escapeLike(filter.search)}%`)
    }
    if (filter.categoryCode) {
      where.push(`d.category_code = ?`)
      binds.push(filter.categoryCode)
    }
    if (filter.resourceType) {
      where.push(`d.resource_type = ?`)
      binds.push(filter.resourceType)
    }
    if (filter.resourceId) {
      where.push(`d.resource_id = ?`)
      binds.push(filter.resourceId)
    }
    const clause = where.join(' and ')
    const [count] = await query<{ total: number }>(
      scope,
      `select count(*)::int as total from documents d where ${clause}`,
      binds
    )
    const rows = await query<DocumentRow>(
      scope,
      `${DOCUMENT_SELECT} where ${clause} order by d.updated_at desc, d.id limit ? offset ?`,
      [...binds, filter.limit, filter.offset]
    )
    return { items: rows.map(toDocument), total: count?.total ?? 0 }
  }

  async update(
    scope: TenantScope,
    id: string,
    version: number,
    patch: Partial<NewDocument> & { legalHold?: boolean }
  ) {
    const sets: string[] = []
    const binds: unknown[] = []
    const columns: [keyof typeof patch, string][] = [
      ['title', 'title'],
      ['categoryCode', 'category_code'],
      ['visibility', 'visibility'],
      ['resourceType', 'resource_type'],
      ['resourceId', 'resource_id'],
      ['retentionUntil', 'retention_until'],
      ['legalHold', 'legal_hold'],
    ]
    for (const [key, column] of columns) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`)
        binds.push(patch[key])
      }
    }
    const rows = await query<{ id: string }>(
      scope,
      `update documents set ${sets.length ? sets.join(', ') + ',' : ''} updated_at = now(), version = version + 1,
              updated_by_membership_id = ?
        where tenant_id = ? and id = ? and version = ? returning id`,
      [...binds, actorOf(scope), tenantOf(scope), id, version]
    )
    return rows[0] ? this.find(scope, id) : null
  }

  async addVersion(
    scope: TenantScope,
    documentId: string,
    v: {
      attachmentId: string
      changeNote: string | null
      templateVersionId: string | null
      generatedValues: Record<string, string> | null
    }
  ) {
    const [next] = await query<{ revision: number }>(
      scope,
      `select coalesce(max(revision), 0) + 1 as revision from document_versions
        where tenant_id = ? and document_id = ?`,
      [tenantOf(scope), documentId]
    )
    const inserted = await query<{ id: string }>(
      scope,
      `insert into document_versions (tenant_id, document_id, revision, attachment_id, change_note,
         template_version_id, generated_values, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) returning id`,
      [
        tenantOf(scope),
        documentId,
        next?.revision ?? 1,
        v.attachmentId,
        v.changeNote,
        v.templateVersionId,
        v.generatedValues ? JSON.stringify(v.generatedValues) : null,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const versionId = (inserted[0] as { id: string }).id
    await query(
      scope,
      `update documents set current_version_id = ?, updated_at = now(), version = version + 1,
              updated_by_membership_id = ? where tenant_id = ? and id = ?`,
      [versionId, actorOf(scope), tenantOf(scope), documentId]
    )
    const rows = await query<VersionRow>(
      scope,
      `${VERSION_SELECT} where v.tenant_id = ? and v.id = ?`,
      [tenantOf(scope), versionId]
    )
    return toVersion(rows[0] as VersionRow)
  }

  async versions(scope: TenantScope, documentId: string) {
    const rows = await query<VersionRow>(
      scope,
      `${VERSION_SELECT} where v.tenant_id = ? and v.document_id = ? order by v.revision desc`,
      [tenantOf(scope), documentId]
    )
    return rows.map(toVersion)
  }

  async markDeleted(scope: TenantScope, id: string) {
    await query(
      scope,
      `update documents set status = 'DELETED', deleted_at = now(), updated_at = now(), version = version + 1,
              updated_by_membership_id = ? where tenant_id = ? and id = ?`,
      [actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as DocumentRecord
  }

  async attachmentsOf(scope: TenantScope, documentId: string) {
    const rows = await query<AttachmentRow>(
      scope,
      `select ${ATTACHMENT_COLUMNS.split(',')
        .map((c) => `a.${c.trim()}`)
        .join(', ')}
         from attachments a join document_versions v on v.tenant_id = a.tenant_id and v.attachment_id = a.id
        where v.tenant_id = ? and v.document_id = ?`,
      [tenantOf(scope), documentId]
    )
    return rows.map(toAttachment)
  }

  async attachmentIsLinked(scope: TenantScope, attachmentId: string) {
    const rows = await query(
      scope,
      `select 1 from document_versions where tenant_id = ? and attachment_id = ?`,
      [tenantOf(scope), attachmentId]
    )
    return rows.length > 0
  }
}

// --- anexos de recursos ------------------------------------------------------------------------------

interface LinkRow {
  id: string
  resource_type: string
  resource_id: string
  attachment_id: string
  category: string | null
  original_name: string
  mime_type: string
  size_bytes: string | number
  att_status: AttachmentStatus
  created_at: Date
}

const toLink = (r: LinkRow): ResourceAttachmentRecord => ({
  id: r.id,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  attachmentId: r.attachment_id,
  category: r.category,
  fileName: r.original_name,
  mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes),
  attachmentStatus: r.att_status,
  createdAt: r.created_at,
})

const LINK_SELECT = `select r.id, r.resource_type, r.resource_id, r.attachment_id, r.category, a.original_name,
    a.mime_type, a.size_bytes, a.status as att_status, r.created_at
  from resource_attachments r join attachments a on a.tenant_id = r.tenant_id and a.id = r.attachment_id`

export class LucidResourceAttachmentStore implements ResourceAttachmentStore {
  async insert(
    scope: TenantScope,
    v: { resourceType: string; resourceId: string; attachmentId: string; category: string | null }
  ) {
    const inserted = await query<{ id: string }>(
      scope,
      `insert into resource_attachments (tenant_id, resource_type, resource_id, attachment_id, category,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, resource_type, resource_id, attachment_id) do nothing returning id`,
      [
        tenantOf(scope),
        v.resourceType,
        v.resourceId,
        v.attachmentId,
        v.category,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const rows = await query<LinkRow>(
      scope,
      `${LINK_SELECT} where r.tenant_id = ? and r.resource_type = ? and r.resource_id = ? and r.attachment_id = ?`,
      [tenantOf(scope), v.resourceType, v.resourceId, v.attachmentId]
    )
    return { record: toLink(rows[0] as LinkRow), created: inserted.length > 0 }
  }

  async list(scope: TenantScope, resourceType: string, resourceId: string) {
    const rows = await query<LinkRow>(
      scope,
      `${LINK_SELECT} where r.tenant_id = ? and r.resource_type = ? and r.resource_id = ? order by r.created_at desc`,
      [tenantOf(scope), resourceType, resourceId]
    )
    return rows.map(toLink)
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<LinkRow>(scope, `${LINK_SELECT} where r.tenant_id = ? and r.id = ?`, [
      tenantOf(scope),
      id,
    ])
    return rows[0] ? toLink(rows[0]) : null
  }

  async remove(scope: TenantScope, id: string) {
    await query(scope, `delete from resource_attachments where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }
}

// --- modelos -----------------------------------------------------------------------------------------

interface TemplateRow {
  id: string
  code: string
  name: string
  channel: TemplateChannel
  resource_type: string | null
  version: number
  published_revision: number | null
  latest_revision: number | null
  created_at: Date
}

const TEMPLATE_SELECT = `select t.id, t.code, t.name, t.channel, t.resource_type, t.version, t.created_at,
    (select max(revision) from template_versions tv
      where tv.tenant_id = t.tenant_id and tv.template_id = t.id and tv.status = 'PUBLISHED') as published_revision,
    (select max(revision) from template_versions tv
      where tv.tenant_id = t.tenant_id and tv.template_id = t.id) as latest_revision
  from templates t`

const toTemplate = (r: TemplateRow): TemplateRecord => ({
  id: r.id,
  code: r.code,
  name: r.name,
  channel: r.channel,
  resourceType: r.resource_type,
  version: r.version,
  publishedRevision: r.published_revision,
  latestRevision: r.latest_revision,
  createdAt: r.created_at,
})

interface TemplateVersionRow {
  id: string
  template_id: string
  revision: number
  body: string
  variable_schema: VariableSchema
  status: TemplateStatus
  locale: string
  published_at: Date | null
  version: number
  created_at: Date
}

const TV_COLUMNS = `id, template_id, revision, body, variable_schema, status, locale, published_at, version, created_at`

const toTemplateVersion = (r: TemplateVersionRow): TemplateVersionRecord => ({
  id: r.id,
  templateId: r.template_id,
  revision: r.revision,
  body: r.body,
  variableSchema: r.variable_schema,
  status: r.status,
  locale: r.locale,
  publishedAt: r.published_at,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidTemplateStore implements TemplateStore {
  async insert(
    scope: TenantScope,
    v: { code: string; name: string; channel: TemplateChannel; resourceType: string | null }
  ) {
    const rows = await query<{ id: string }>(
      scope,
      `insert into templates (tenant_id, code, name, channel, resource_type, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?) on conflict (tenant_id, code) do nothing returning id`,
      [tenantOf(scope), v.code, v.name, v.channel, v.resourceType, actorOf(scope), actorOf(scope)]
    )
    return rows[0] ? this.find(scope, rows[0].id) : null
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<TemplateRow>(
      scope,
      `${TEMPLATE_SELECT} where t.tenant_id = ? and t.id = ?`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toTemplate(rows[0]) : null
  }

  async list(scope: TenantScope) {
    const rows = await query<TemplateRow>(
      scope,
      `${TEMPLATE_SELECT} where t.tenant_id = ? order by t.name, t.id`,
      [tenantOf(scope)]
    )
    return rows.map(toTemplate)
  }

  async versions(scope: TenantScope, templateId: string) {
    const rows = await query<TemplateVersionRow>(
      scope,
      `select ${TV_COLUMNS} from template_versions where tenant_id = ? and template_id = ? order by revision desc`,
      [tenantOf(scope), templateId]
    )
    return rows.map(toTemplateVersion)
  }

  async findVersion(scope: TenantScope, templateId: string, versionId: string) {
    const rows = await query<TemplateVersionRow>(
      scope,
      `select ${TV_COLUMNS} from template_versions where tenant_id = ? and template_id = ? and id = ?`,
      [tenantOf(scope), templateId, versionId]
    )
    return rows[0] ? toTemplateVersion(rows[0]) : null
  }

  async lockVersion(scope: TenantScope, templateId: string, versionId: string) {
    const rows = await query<TemplateVersionRow>(
      scope,
      `select ${TV_COLUMNS} from template_versions where tenant_id = ? and template_id = ? and id = ? for update`,
      [tenantOf(scope), templateId, versionId]
    )
    return rows[0] ? toTemplateVersion(rows[0]) : null
  }

  async addVersion(
    scope: TenantScope,
    templateId: string,
    v: { body: string; variableSchema: VariableSchema; locale: string }
  ) {
    await query(scope, `select 1 from templates where tenant_id = ? and id = ? for update`, [
      tenantOf(scope),
      templateId,
    ])
    const rows = await query<TemplateVersionRow>(
      scope,
      `insert into template_versions (tenant_id, template_id, revision, body, variable_schema, locale,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, (select coalesce(max(revision), 0) + 1 from template_versions
                       where tenant_id = ? and template_id = ?), ?, ?::jsonb, ?, ?, ?)
       returning ${TV_COLUMNS}`,
      [
        tenantOf(scope),
        templateId,
        tenantOf(scope),
        templateId,
        v.body,
        JSON.stringify(v.variableSchema),
        v.locale,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toTemplateVersion(rows[0] as TemplateVersionRow)
  }

  async updateDraft(
    scope: TenantScope,
    versionId: string,
    expected: number,
    v: { body: string; variableSchema: VariableSchema; locale: string }
  ) {
    const rows = await query<TemplateVersionRow>(
      scope,
      `update template_versions set body = ?, variable_schema = ?::jsonb, locale = ?, updated_at = now(),
              version = version + 1, updated_by_membership_id = ?
        where tenant_id = ? and id = ? and status = 'DRAFT' and version = ? returning ${TV_COLUMNS}`,
      [
        v.body,
        JSON.stringify(v.variableSchema),
        v.locale,
        actorOf(scope),
        tenantOf(scope),
        versionId,
        expected,
      ]
    )
    return rows[0] ? toTemplateVersion(rows[0]) : null
  }

  async deleteDraft(scope: TenantScope, versionId: string) {
    await query(
      scope,
      `delete from template_versions where tenant_id = ? and id = ? and status = 'DRAFT'`,
      [tenantOf(scope), versionId]
    )
  }

  async publish(scope: TenantScope, versionId: string, locale: string, at: Date) {
    const [current] = await query<{ template_id: string }>(
      scope,
      `select template_id from template_versions where tenant_id = ? and id = ?`,
      [tenantOf(scope), versionId]
    )
    await query(
      scope,
      `update template_versions set status = 'RETIRED', updated_at = now(), version = version + 1
        where tenant_id = ? and template_id = ? and locale = ? and status = 'PUBLISHED'`,
      [tenantOf(scope), current?.template_id, locale]
    )
    const rows = await query<TemplateVersionRow>(
      scope,
      `update template_versions set status = 'PUBLISHED', published_at = ?, published_by_membership_id = ?,
              updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? returning ${TV_COLUMNS}`,
      [at, actorOf(scope), tenantOf(scope), versionId]
    )
    return toTemplateVersion(rows[0] as TemplateVersionRow)
  }

  async publishedFor(scope: TenantScope, templateId: string, locale?: string) {
    const rows = await query<TemplateVersionRow>(
      scope,
      `select ${TV_COLUMNS} from template_versions
        where tenant_id = ? and template_id = ? and status = 'PUBLISHED' ${locale ? 'and locale = ?' : ''}
        order by published_at desc limit 1`,
      locale ? [tenantOf(scope), templateId, locale] : [tenantOf(scope), templateId]
    )
    return rows[0] ? toTemplateVersion(rows[0]) : null
  }
}
