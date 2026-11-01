import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import {
  MAX_ATTEMPTS,
  minimizeError,
  renderType,
  typeOf,
  type Channel,
  type Classification,
  type DeliveryStatus,
  type QuietHours,
  type RequestStatus,
} from '#modules/notifications/domain/notifications'
import type {
  CenterStore,
  Cipher,
  Delivery,
  DeliveryFilter,
  DeliveryStore,
  DueDelivery,
  NewRequest,
  Notification,
  NotificationRequest,
  Preference,
  PreferenceStore,
  RequestStore,
} from '#modules/notifications/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

// --- pedidos ----------------------------------------------------------------------------------------

interface RequestRow {
  id: string
  type_code: string
  template_version: string
  classification: Classification
  recipient_membership_id: string | null
  recipient_party_id: string | null
  payload: Record<string, unknown>
  dedupe_key: string
  resource_type: string | null
  resource_id: string | null
  status: RequestStatus
  version: number
  created_at: Date
}

const REQUEST_COLUMNS = `id, type_code, template_version, classification, recipient_membership_id, recipient_party_id,
  payload, dedupe_key, resource_type, resource_id, status, version, created_at`

const toRequest = (r: RequestRow): NotificationRequest => ({
  id: r.id,
  typeCode: r.type_code,
  templateVersion: r.template_version,
  classification: r.classification,
  recipientMembershipId: r.recipient_membership_id,
  recipientPartyId: r.recipient_party_id,
  payload: r.payload,
  dedupeKey: r.dedupe_key,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidRequestStore implements RequestStore {
  async insert(scope: TenantScope, v: NewRequest) {
    const inserted = await trxOf(scope).rawQuery(
      `insert into notification_requests (tenant_id, type_code, template_version, classification,
         recipient_membership_id, recipient_party_id, payload, dedupe_key, resource_type, resource_id,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
       on conflict (tenant_id, dedupe_key) do nothing returning ${REQUEST_COLUMNS}`,
      [
        tenantOf(scope),
        v.typeCode,
        v.templateVersion,
        v.classification,
        v.recipientMembershipId,
        v.recipientPartyId,
        JSON.stringify(v.payload),
        v.dedupeKey,
        v.resourceType,
        v.resourceId,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    const row = inserted.rows[0] as RequestRow | undefined
    if (row) return { request: toRequest(row), created: true }
    const existing = await trxOf(scope).rawQuery(
      `select ${REQUEST_COLUMNS} from notification_requests where tenant_id = ? and dedupe_key = ?`,
      [tenantOf(scope), v.dedupeKey] as never[]
    )
    return { request: toRequest(existing.rows[0] as RequestRow), created: false }
  }

  async setStatus(scope: TenantScope, id: string, status: RequestStatus) {
    await trxOf(scope).rawQuery(
      `update notification_requests set status = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and status <> ?`,
      [status, tenantOf(scope), id, status] as never[]
    )
  }

  async refreshStatus(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select count(*)::int as total,
              count(*) filter (where status = 'QUEUED')::int as queued,
              count(*) filter (where status in ('SENT', 'DELIVERED'))::int as ok,
              count(*) filter (where attempts > 0)::int as tried
         from notification_deliveries where tenant_id = ? and request_id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const r = result.rows[0] as { total: number; queued: number; ok: number; tried: number }
    const status: RequestStatus =
      r.total === 0
        ? 'COMPLETED'
        : r.queued > 0
          ? r.tried > 0
            ? 'PROCESSING'
            : 'PENDING'
          : r.ok > 0
            ? 'COMPLETED'
            : 'FAILED'
    await this.setStatus(scope, id, status)
    return status
  }
}

// --- entregas ---------------------------------------------------------------------------------------

interface DeliveryRow {
  id: string
  request_id: string
  type_code: string
  channel: Channel
  destination_hint: string | null
  status: DeliveryStatus
  provider: string | null
  provider_message_id: string | null
  attempts: number
  last_error_code: string | null
  last_error: string | null
  next_attempt_at: Date
  sent_at: Date | null
  delivered_at: Date | null
  version: number
  created_at: Date
}

const DELIVERY_SELECT = `
  select d.id, d.request_id, r.type_code, d.channel, d.destination_hint, d.status, d.provider, d.provider_message_id,
         d.attempts, d.last_error_code, d.last_error, d.next_attempt_at, d.sent_at, d.delivered_at, d.version,
         d.created_at
    from notification_deliveries d
    join notification_requests r on r.tenant_id = d.tenant_id and r.id = d.request_id`

const toDelivery = (r: DeliveryRow): Delivery => ({
  id: r.id,
  requestId: r.request_id,
  typeCode: r.type_code,
  channel: r.channel,
  destinationHint: r.destination_hint,
  status: r.status,
  provider: r.provider,
  providerMessageId: r.provider_message_id,
  attempts: r.attempts,
  lastErrorCode: r.last_error_code,
  lastError: r.last_error,
  nextAttemptAt: r.next_attempt_at,
  sentAt: r.sent_at,
  deliveredAt: r.delivered_at,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidDeliveryStore implements DeliveryStore {
  constructor(private readonly cipher: Cipher) {}

  async insert(
    scope: TenantScope,
    v: {
      requestId: string
      channel: Channel
      destinationEncrypted: string | null
      destinationHint: string | null
      status: DeliveryStatus
      provider: string | null
      nextAttemptAt: Date
    }
  ) {
    await trxOf(scope).rawQuery(
      `insert into notification_deliveries (tenant_id, request_id, channel, destination_encrypted, destination_hint,
         status, provider, next_attempt_at, sent_at, delivered_at, attempts, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, request_id, channel) do nothing`,
      [
        tenantOf(scope),
        v.requestId,
        v.channel,
        v.destinationEncrypted,
        v.destinationHint,
        v.status,
        v.provider,
        v.nextAttemptAt,
        v.status === 'DELIVERED' ? v.nextAttemptAt : null,
        v.status === 'DELIVERED' ? v.nextAttemptAt : null,
        v.status === 'DELIVERED' ? 1 : 0,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
  }

  async list(scope: TenantScope, filter: DeliveryFilter) {
    const where = ['d.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.status) {
      where.push('d.status = ?')
      params.push(filter.status)
    }
    if (filter.channel) {
      where.push('d.channel = ?')
      params.push(filter.channel)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `${DELIVERY_SELECT} where ${clause} order by d.created_at desc, d.id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from notification_deliveries d where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as DeliveryRow[]).map(toDelivery),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `${DELIVERY_SELECT} where d.tenant_id = ? and d.id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as DeliveryRow[]
    return row ? toDelivery(row) : null
  }

  async claimDue(scope: TenantScope, now: Date, limit: number, leaseUntil: Date) {
    const claimed = await trxOf(scope).rawQuery(
      `with due as (
         select d.id, (d.locked_until is not null) as had_lease
           from notification_deliveries d
          where d.tenant_id = ? and d.channel <> 'IN_APP' and d.status = 'QUEUED' and d.next_attempt_at <= ?
            and (d.locked_until is null or d.locked_until <= ?)
          order by d.next_attempt_at, d.id limit ? for update skip locked
       )
       update notification_deliveries d
          set attempts = d.attempts + 1, locked_until = ?, updated_at = now(), version = d.version + 1
         from due
        where d.tenant_id = ? and d.id = due.id
       returning d.id, d.request_id, d.channel, d.destination_encrypted, d.attempts, due.had_lease`,
      [tenantOf(scope), now, now, limit, leaseUntil, tenantOf(scope)] as never[]
    )
    const rows = claimed.rows as {
      id: string
      request_id: string
      channel: Channel
      destination_encrypted: string | null
      attempts: number
      had_lease: boolean
    }[]
    if (rows.length === 0) return []
    const requests = await trxOf(scope).rawQuery(
      `select ${REQUEST_COLUMNS} from notification_requests where tenant_id = ? and id = any(?::uuid[])`,
      [tenantOf(scope), [...new Set(rows.map((r) => r.request_id))]] as never[]
    )
    const byId = new Map((requests.rows as RequestRow[]).map((r) => [r.id, r]))
    return rows.map<DueDelivery>((r) => {
      const request = byId.get(r.request_id) as RequestRow
      const type = typeOf(request.type_code)
      const text = type ? renderType(type, request.payload) : { title: request.type_code, body: '' }
      return {
        id: r.id,
        requestId: r.request_id,
        channel: r.channel,
        destination: r.destination_encrypted ? this.cipher.decrypt(r.destination_encrypted) : '',
        typeCode: request.type_code,
        classification: request.classification,
        title: text.title,
        body: text.body,
        resourceType: request.resource_type,
        resourceId: request.resource_id,
        attempts: r.attempts,
        ambiguous: r.had_lease,
      }
    })
  }

  async recordSent(
    scope: TenantScope,
    id: string,
    result: { provider: string; providerMessageId: string; now: Date }
  ) {
    await trxOf(scope).rawQuery(
      `update notification_deliveries
          set status = 'SENT', provider = ?, provider_message_id = ?, sent_at = ?, locked_until = null,
              last_error_code = null, last_error = null, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [result.provider, result.providerMessageId, result.now, tenantOf(scope), id] as never[]
    )
  }

  async recordFailure(
    scope: TenantScope,
    id: string,
    failure: { code: string; message: string; retryAt: Date | null }
  ) {
    await trxOf(scope).rawQuery(
      `update notification_deliveries
          set status = ?, next_attempt_at = coalesce(?::timestamptz, next_attempt_at), locked_until = null,
              last_error_code = ?, last_error = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [
        failure.retryAt ? 'QUEUED' : 'FAILED',
        failure.retryAt,
        failure.code,
        minimizeError(failure.message),
        tenantOf(scope),
        id,
      ] as never[]
    )
  }

  async confirmDelivered(
    scope: TenantScope,
    provider: string,
    providerMessageId: string,
    now: Date
  ) {
    const result = await trxOf(scope).rawQuery(
      `update notification_deliveries
          set status = 'DELIVERED', delivered_at = coalesce(delivered_at, ?), updated_at = now(), version = version + 1
        where tenant_id = ? and provider = ? and provider_message_id = ? and status in ('SENT', 'DELIVERED')
        returning id`,
      [now, tenantOf(scope), provider, providerMessageId] as never[]
    )
    const row = result.rows[0] as { id: string } | undefined
    return row ? row.id : null
  }

  async requeue(scope: TenantScope, id: string, now: Date) {
    const result = await trxOf(scope).rawQuery(
      `update notification_deliveries
          set status = 'QUEUED', next_attempt_at = ?, locked_until = null, attempts = least(attempts, ?),
              updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and status = 'FAILED' returning id`,
      [now, MAX_ATTEMPTS - 1, tenantOf(scope), id] as never[]
    )
    return result.rows.length > 0
  }
}

// --- centro -----------------------------------------------------------------------------------------

interface NotificationRow {
  id: string
  type_code: string
  title: string
  body: string
  resource_type: string | null
  resource_id: string | null
  read_at: Date | null
  version: number
  created_at: Date
}

const NOTIFICATION_COLUMNS = `id, type_code, title, body, resource_type, resource_id, read_at, version, created_at`

const toNotification = (r: NotificationRow): Notification => ({
  id: r.id,
  typeCode: r.type_code,
  title: r.title,
  body: r.body,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  readAt: r.read_at,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidCenterStore implements CenterStore {
  async insert(
    scope: TenantScope,
    v: {
      recipientMembershipId: string
      requestId: string | null
      typeCode: string
      title: string
      body: string
      resourceType: string | null
      resourceId: string | null
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into notifications (tenant_id, recipient_membership_id, request_id, type_code, title, body,
         resource_type, resource_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${NOTIFICATION_COLUMNS}`,
      [
        tenantOf(scope),
        v.recipientMembershipId,
        v.requestId,
        v.typeCode,
        v.title,
        v.body,
        v.resourceType,
        v.resourceId,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return toNotification(result.rows[0] as NotificationRow)
  }

  async list(
    scope: TenantScope,
    membershipId: string,
    filter: { unread?: boolean; limit: number; offset: number }
  ) {
    const unreadClause = filter.unread ? 'and read_at is null' : ''
    const rows = await trxOf(scope).rawQuery(
      `select ${NOTIFICATION_COLUMNS} from notifications
        where tenant_id = ? and recipient_membership_id = ? ${unreadClause}
        order by created_at desc, id limit ? offset ?`,
      [tenantOf(scope), membershipId, filter.limit, filter.offset] as never[]
    )
    const counts = await trxOf(scope).rawQuery(
      `select count(*) filter (where true ${unreadClause})::int as total,
              count(*) filter (where read_at is null)::int as unread
         from notifications where tenant_id = ? and recipient_membership_id = ?`,
      [tenantOf(scope), membershipId] as never[]
    )
    const c = counts.rows[0] as { total: number; unread: number }
    return {
      items: (rows.rows as NotificationRow[]).map(toNotification),
      total: c.total,
      unread: c.unread,
    }
  }

  async find(scope: TenantScope, membershipId: string, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${NOTIFICATION_COLUMNS} from notifications
        where tenant_id = ? and recipient_membership_id = ? and id = ?`,
      [tenantOf(scope), membershipId, id] as never[]
    )
    const [row] = result.rows as NotificationRow[]
    return row ? toNotification(row) : null
  }

  async markRead(scope: TenantScope, membershipId: string, id: string, now: Date) {
    const result = await trxOf(scope).rawQuery(
      `update notifications set read_at = coalesce(read_at, ?), updated_at = now(), version = version + 1
        where tenant_id = ? and recipient_membership_id = ? and id = ? and read_at is null
        returning ${NOTIFICATION_COLUMNS}`,
      [now, tenantOf(scope), membershipId, id] as never[]
    )
    const [row] = result.rows as NotificationRow[]
    if (row) return toNotification(row)
    return (await this.find(scope, membershipId, id)) as Notification
  }

  async markAllRead(scope: TenantScope, membershipId: string, now: Date) {
    const result = await trxOf(scope).rawQuery(
      `update notifications set read_at = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and recipient_membership_id = ? and read_at is null returning id`,
      [now, tenantOf(scope), membershipId] as never[]
    )
    return result.rows.length
  }
}

// --- preferências -----------------------------------------------------------------------------------

export class LucidPreferenceStore implements PreferenceStore {
  async list(scope: TenantScope, membershipId: string) {
    const result = await trxOf(scope).rawQuery(
      `select type_code, channel, enabled, quiet_hours from notification_preferences
        where tenant_id = ? and membership_id = ? order by type_code, channel`,
      [tenantOf(scope), membershipId] as never[]
    )
    return (
      result.rows as {
        type_code: string
        channel: Channel
        enabled: boolean
        quiet_hours: QuietHours | null
      }[]
    ).map<Preference>((r) => ({
      typeCode: r.type_code,
      channel: r.channel,
      enabled: r.enabled,
      quietHours: r.quiet_hours,
    }))
  }

  async upsert(scope: TenantScope, membershipId: string, v: Preference) {
    await trxOf(scope).rawQuery(
      `insert into notification_preferences (tenant_id, membership_id, type_code, channel, enabled, quiet_hours,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?)
       on conflict (tenant_id, membership_id, type_code, channel)
       do update set enabled = excluded.enabled, quiet_hours = excluded.quiet_hours, updated_at = now(),
                     updated_by_membership_id = excluded.updated_by_membership_id,
                     version = notification_preferences.version + 1`,
      [
        tenantOf(scope),
        membershipId,
        v.typeCode,
        v.channel,
        v.enabled,
        v.quietHours === null ? null : JSON.stringify(v.quietHours),
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
  }
}
