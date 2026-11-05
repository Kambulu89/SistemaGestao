import { ApiError } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'

export interface NotificationInput {
  type: string
  title: string
  body?: string | null
  subjectType?: string | null
  subjectId?: string | null
}

export interface NotificationView {
  id: string
  type: string
  title: string
  body: string | null
  subjectType: string | null
  subjectId: string | null
  createdAt: string
  readAt: string | null
}

/**
 * Notifica membros na transacção de quem chama (se a operação falhar, a notificação não fica). Ignora duplicados e
 * o próprio actor (ninguém é notificado do que acabou de fazer).
 */
export async function notify(
  scope: TenantScope,
  recipientMembershipIds: readonly string[],
  input: NotificationInput
) {
  const recipients = [...new Set(recipientMembershipIds)].filter(
    (id) => id !== scope.context.membershipId
  )
  for (const recipient of recipients) {
    await scope.trx.rawQuery(
      `insert into notifications (tenant_id, created_by, updated_by, recipient_membership_id, type, title, body,
                                  subject_type, subject_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        scope.context.userId,
        scope.context.userId,
        recipient,
        input.type,
        input.title.slice(0, 200),
        input.body ?? null,
        input.subjectType ?? null,
        input.subjectId ?? null,
      ] as never[]
    )
  }
  return recipients.length
}

const toView = (r: any): NotificationView => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  createdAt: new Date(r.created_at).toISOString(),
  readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
})

/** Caixa do membro em contexto (sempre filtrada pelo destinatário). */
export class NotificationService {
  list(context: TenantContext, filter: { unread?: boolean; limit: number; offset: number }) {
    return runInTenant(context, async ({ trx }) => {
      const where = `tenant_id = ? and recipient_membership_id = ?${filter.unread ? ' and read_at is null' : ''}`
      const params = [context.tenantId, context.membershipId]
      const rows = await trx.rawQuery(
        `select id, type, title, body, subject_type, subject_id, created_at, read_at from notifications
          where ${where} order by created_at desc, id desc limit ? offset ?`,
        [...params, filter.limit, filter.offset]
      )
      const counts = await trx.rawQuery(
        `select count(*)::int as total, count(*) filter (where read_at is null)::int as unread
           from notifications where ${where}`,
        params
      )
      const { total, unread } = counts.rows[0] as { total: number; unread: number }
      return { items: (rows.rows as any[]).map(toView), total, unread }
    })
  }

  markRead(context: TenantContext, id: string) {
    return runInTenant(context, async ({ trx }) => {
      const result = await trx.rawQuery(
        `update notifications set read_at = coalesce(read_at, now()), updated_at = now()
          where tenant_id = ? and id = ? and recipient_membership_id = ?
          returning id, type, title, body, subject_type, subject_id, created_at, read_at`,
        [context.tenantId, id, context.membershipId]
      )
      if (result.rows.length === 0) throw ApiError.notFound()
      return toView(result.rows[0])
    })
  }

  markAllRead(context: TenantContext) {
    return runInTenant(context, async ({ trx }) => {
      const result = await trx.rawQuery(
        `update notifications set read_at = now(), updated_at = now()
          where tenant_id = ? and recipient_membership_id = ? and read_at is null`,
        [context.tenantId, context.membershipId]
      )
      return { updated: result.rowCount ?? 0 }
    })
  }
}
