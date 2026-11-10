import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { effectivePermissions } from '#modules/rbac/index'
import { assertEntitled, assertWithinQuota } from '#modules/subscription/index'
import { audit } from '#modules/audit/index'
import { canViewRequest } from '#modules/approvals/index'
import { ORGANIZATION_ENTITY_TYPES, organizationRecordExists } from '#modules/organization/index'
import {
  certificateAccess,
  disciplinaryCaseAccess,
  terminationAccess,
  employeeAccess,
  leaveRequestAccess,
} from '#modules/hr/index'
import {
  extensionOf,
  FILE_TYPES,
  MAX_FILE_BYTES,
  safeFileName,
} from '#modules/attachments/domain/files'
import { LocalStorage } from '#modules/attachments/infrastructure/local_storage'
import { productExists } from '#modules/inventory/index'

/**
 * Política de acesso por tipo de registo: o anexo herda a autorização (e a funcionalidade contratada) do registo a que
 * pertence. `access` devolve `null` se o registo não existe ou não é visível (404), senão se pode ler e/ou escrever.
 */
interface SubjectPolicy {
  /** Funcionalidade contratada exigida (`null`: núcleo, sempre disponível). */
  feature: string | null
  access: (scope: TenantScope, id: string) => Promise<{ read: boolean; write: boolean } | null>
}

function policies(): Record<string, SubjectPolicy> {
  const map: Record<string, SubjectPolicy> = {
    approval_request: {
      feature: 'approvals',
      access: async (scope, id) => {
        const request = await canViewRequest(scope, id)
        if (!request) return null
        const own = request.requestedBy.membershipId === scope.context.membershipId
        const manager = (await effectivePermissions(scope)).tenant.has('approvals.manage')
        return { read: true, write: (own && request.status === 'PENDING') || manager }
      },
    },
  }
  // Documentos do perfil da empresa (o assunto é o próprio tenant).
  map.tenant_profile = {
    feature: null,
    access: async (scope, id) => {
      if (id !== scope.context.tenantId) return null
      const held = (await effectivePermissions(scope)).tenant
      if (!held.has('settings.read')) return null
      return { read: true, write: held.has('settings.manage') }
    },
  }
  // Comprovativos de contas bancárias (ex.: declaração do banco).
  map.bank_account = {
    feature: null,
    access: async (scope, id) => {
      const held = (await effectivePermissions(scope)).tenant
      if (!held.has('bank_accounts.read')) return null
      const r = await scope.trx.rawQuery(
        'select 1 from bank_accounts where tenant_id = ? and id = ?',
        [scope.context.tenantId, id]
      )
      if (r.rows.length === 0) return null
      return { read: true, write: held.has('bank_accounts.manage') }
    },
  }
  // Documentos de suporte de lançamentos: acrescentam-se até à contabilização; depois ficam só para consulta.
  map.journal_entry = {
    feature: 'accounting',
    access: async (scope, id) => {
      const held = (await effectivePermissions(scope)).tenant
      if (!held.has('accounting.read')) return null
      const r = await scope.trx.rawQuery(
        'select status from journal_entries where tenant_id = ? and id = ?',
        [scope.context.tenantId, id]
      )
      const entry = r.rows[0] as { status: string } | undefined
      if (!entry) return null
      return { read: true, write: held.has('accounting.create') && entry.status !== 'POSTED' }
    },
  }
  // Documentos do colaborador (BI, contrato, certificados): dados pessoais, seguem `hr.sensitive` no âmbito.
  map.employee = {
    feature: 'hr',
    access: (scope, id) => employeeAccess(scope, id, 'sensitive'),
  }
  // Justificativos de ausências (ex.: atestado médico): os confidenciais só para o próprio e `hr.sensitive`.
  map.leave_request = {
    feature: 'hr',
    access: (scope, id) => leaveRequestAccess(scope, id),
  }
  // Certificados de formação: o mesmo acesso da formação do colaborador.
  map.employee_certificate = {
    feature: 'hr',
    access: (scope, id) => certificateAccess(scope, id),
  }
  // Documentos de processos disciplinares (acesso restrito; encerrado, só leitura).
  map.disciplinary_case = {
    feature: 'hr',
    access: (scope, id) => disciplinaryCaseAccess(scope, id),
  }
  // Documentos da cessação (carta de denúncia, acordo, declarações): o mesmo acesso do processo.
  map.employee_termination = {
    feature: 'hr',
    access: (scope, id) => terminationAccess(scope, id),
  }
  // Imagens e fichas técnicas do produto: ler com `inventory.read`, acrescentar com `inventory.products.manage`.
  map.product = {
    feature: 'inventory',
    access: async (scope, id) => {
      const held = (await effectivePermissions(scope)).tenant
      if (!held.has('inventory.read') || !(await productExists(scope, id))) return null
      return { read: true, write: held.has('inventory.products.manage') }
    },
  }
  for (const type of Object.values(ORGANIZATION_ENTITY_TYPES)) {
    map[type] = {
      feature: 'organization',
      access: async (scope, id) => {
        const held = (await effectivePermissions(scope)).tenant
        if (!held.has('organization.read')) return null
        if (!(await organizationRecordExists(scope, type, id))) return null
        return { read: true, write: held.has('organization.manage') }
      },
    }
  }
  return map
}

export const ATTACHMENT_SUBJECT_TYPES = () => Object.keys(policies())

export interface AttachmentView {
  id: string
  subjectType: string
  subjectId: string
  fileName: string
  contentType: string
  sizeBytes: number
  sha256: string
  createdAt: string
  createdBy: { userId: string; fullName: string | null } | null
}

const toView = (r: any): AttachmentView => ({
  id: r.id,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  fileName: r.file_name,
  contentType: r.content_type,
  sizeBytes: Number(r.size_bytes),
  sha256: r.sha256,
  createdAt: new Date(r.created_at).toISOString(),
  createdBy: r.created_by ? { userId: r.created_by, fullName: r.full_name } : null,
})

const SELECT = `select a.id, a.subject_type, a.subject_id, a.file_name, a.content_type, a.size_bytes, a.sha256,
                       a.storage_key, a.status, a.created_at, a.created_by, u.full_name
                  from attachments a left join users u on u.id = a.created_by`

const storage = new LocalStorage()

async function authorize(
  scope: TenantScope,
  subjectType: string,
  subjectId: string,
  need: 'read' | 'write'
) {
  const policy = policies()[subjectType]
  if (!policy) throw ApiError.notFound()
  if (policy.feature) await assertEntitled(scope.context.tenantId, policy.feature)
  const access = await policy.access(scope, subjectId)
  if (!access) throw ApiError.notFound()
  if (!access[need]) throw ApiError.forbidden()
}

async function findActive(scope: TenantScope, id: string) {
  const result = await scope.trx.rawQuery(
    `${SELECT} where a.tenant_id = ? and a.id = ? and a.status = 'ACTIVE'`,
    [scope.context.tenantId, id]
  )
  return (result.rows[0] as any) ?? null
}

export class AttachmentService {
  list(context: TenantContext, subjectType: string, subjectId: string) {
    return runInTenant(context, async (scope) => {
      await authorize(scope, subjectType, subjectId, 'read')
      const result = await scope.trx.rawQuery(
        `${SELECT} where a.tenant_id = ? and a.subject_type = ? and a.subject_id = ? and a.status = 'ACTIVE'
          order by a.created_at desc, a.id`,
        [context.tenantId, subjectType, subjectId]
      )
      return (result.rows as any[]).map(toView)
    })
  }

  /** Valida o ficheiro (tamanho, extensão e assinatura), grava-o e regista os metadados; tudo ou nada. */
  async upload(
    context: TenantContext,
    input: { subjectType: string; subjectId: string; clientName: string; content: Buffer }
  ): Promise<AttachmentView> {
    const fileName = safeFileName(input.clientName)
    const type = FILE_TYPES[extensionOf(fileName)]
    if (input.content.length === 0)
      throw ApiError.validation([
        { path: 'file', code: 'EMPTY', message: 'O ficheiro está vazio.' },
      ])
    if (input.content.length > MAX_FILE_BYTES)
      throw ApiError.validation([
        { path: 'file', code: 'TOO_LARGE', message: 'Máximo de 10 MB por ficheiro.' },
      ])
    if (!type)
      throw ApiError.validation([
        {
          path: 'file',
          code: 'TYPE_NOT_ALLOWED',
          message: `Tipos aceites: ${Object.keys(FILE_TYPES).join(', ')}.`,
        },
      ])
    if (!type.matches(input.content.subarray(0, 4096)))
      throw ApiError.validation([
        {
          path: 'file',
          code: 'CONTENT_MISMATCH',
          message: 'O conteúdo não corresponde à extensão do ficheiro.',
        },
      ])
    const id = randomUUID()
    const key = storage.keyFor(context.tenantId, id)
    const sha256 = createHash('sha256').update(input.content).digest('hex')
    let written = false
    try {
      return await runInTenant(context, async (scope) => {
        await authorize(scope, input.subjectType, input.subjectId, 'write')
        await assertWithinQuota(
          scope.trx,
          context.tenantId,
          'attachments.storage_mb',
          async () => {
            const r = await scope.trx.rawQuery(
              `select coalesce(sum(size_bytes), 0)::bigint as used from attachments where tenant_id = ? and status = 'ACTIVE'`,
              [context.tenantId]
            )
            return Number((r.rows[0] as { used: string }).used)
          },
          input.content.length,
          1024 * 1024
        )
        await scope.trx.rawQuery(
          `insert into attachments (id, tenant_id, created_by, updated_by, subject_type, subject_id, file_name,
                                    content_type, size_bytes, sha256, storage_key)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            context.tenantId,
            context.userId,
            context.userId,
            input.subjectType,
            input.subjectId,
            fileName,
            type.contentType,
            input.content.length,
            sha256,
            key,
          ]
        )
        await audit(scope, {
          action: 'attachment.uploaded',
          entityType: 'attachment',
          entityId: id,
          metadata: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            fileName,
            sizeBytes: input.content.length,
            sha256,
          },
        })
        // Último passo antes do commit: se a gravação falhar, a transacção volta atrás.
        await storage.put(key, input.content)
        written = true
        return toView(await findActive(scope, id))
      })
    } catch (error) {
      if (written) await storage.remove(key)
      throw error
    }
  }

  /** Conteúdo para descarga, depois de verificar o acesso ao registo; a descarga fica auditada. */
  download(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const row = await findActive(scope, id)
      if (!row) throw ApiError.notFound()
      await authorize(scope, row.subject_type, row.subject_id, 'read')
      const content = await storage.get(row.storage_key)
      if (!content) throw ApiError.notFound()
      if (createHash('sha256').update(content).digest('hex') !== row.sha256)
        throw new ApiError(
          500,
          'INTEGRITY_ERROR',
          'O ficheiro guardado não corresponde ao registado.'
        )
      await audit(scope, {
        action: 'attachment.downloaded',
        entityType: 'attachment',
        entityId: id,
        metadata: { subjectType: row.subject_type, subjectId: row.subject_id },
      })
      return { view: toView(row), content }
    })
  }

  remove(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const row = await findActive(scope, id)
      if (!row) throw ApiError.notFound()
      await authorize(scope, row.subject_type, row.subject_id, 'write')
      await scope.trx.rawQuery(
        `update attachments set status = 'DELETED', deleted_at = now(), deleted_by = ?, updated_by = ?, updated_at = now(),
                version = version + 1 where tenant_id = ? and id = ?`,
        [context.userId, context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'attachment.deleted',
        entityType: 'attachment',
        entityId: id,
        metadata: {
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          fileName: row.file_name,
        },
      })
    })
  }
}

/** Espaço ocupado pelos anexos activos da empresa, em bytes (para o painel). */
export async function storageUsedBytes(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select coalesce(sum(size_bytes), 0)::bigint as used from attachments where tenant_id = ? and status = 'ACTIVE'`,
    [scope.context.tenantId]
  )
  return Number((r.rows[0] as { used: string }).used)
}
