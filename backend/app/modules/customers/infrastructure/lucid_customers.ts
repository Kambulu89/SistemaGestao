import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  CustomerStatus,
  CustomerValues,
  InteractionChannel,
  InteractionValues,
  SegmentValues,
} from '#modules/customers/domain/customers'
import type {
  Customer,
  CustomerFilter,
  CustomerStore,
  Interaction,
  InteractionStore,
  Segment,
  SegmentStore,
} from '#modules/customers/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const constraintOf = (error: unknown): string | null =>
  (error as { code?: string }).code === '23505'
    ? ((error as { constraint?: string }).constraint ?? '')
    : null

const iso = (value: Date | string) => new Date(value).toISOString()

// --- segmentos --------------------------------------------------------------------------------------

interface SegmentRow {
  id: string
  code: string
  name: string
  description: string | null
  active: boolean
  version: number
  created_at: Date
  updated_at: Date
}
const SEGMENT_COLUMNS = 'id, code, name, description, active, version, created_at, updated_at'
const toSegment = (r: SegmentRow): Segment => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidSegmentStore implements SegmentStore {
  async list(scope: TenantScope) {
    const result = await trxOf(scope).rawQuery(
      `select ${SEGMENT_COLUMNS} from customer_segments where tenant_id = ? order by code`,
      [tenantOf(scope)]
    )
    return (result.rows as SegmentRow[]).map(toSegment)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${SEGMENT_COLUMNS} from customer_segments where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as SegmentRow[]
    return row ? toSegment(row) : null
  }

  async insert(scope: TenantScope, v: SegmentValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into customer_segments (tenant_id, code, name, description, active, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [
        tenantOf(scope),
        v.code,
        v.name,
        v.description,
        v.active,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: SegmentValues) {
    const result = await trxOf(scope).rawQuery(
      `update customer_segments
          set name = ?, description = ?, active = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.name,
        v.description,
        v.active,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }
}

// --- clientes ---------------------------------------------------------------------------------------

interface CustomerRow {
  id: string
  party_id: string
  organization_id: string
  code: string
  segment_id: string | null
  account_manager_membership_id: string | null
  payment_term_days: number
  credit_limit: string
  currency: string
  status: CustomerStatus
  status_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
  party_name: string
  party_kind: string
  tax_id: string | null
  segment_name: string | null
}

/** Junta só para ler (nome, tipo e NIF da Party; nome do segmento): o cliente nunca escreve na Party. */
const CUSTOMER_SELECT = `
  select c.id, c.party_id, c.organization_id, c.code, c.segment_id, c.account_manager_membership_id,
         c.payment_term_days, c.credit_limit::text as credit_limit, c.currency, c.status, c.status_reason,
         c.version, c.created_at, c.updated_at,
         p.display_name as party_name, p.kind as party_kind, op.tax_id, s.name as segment_name
    from customers c
    join parties p on p.tenant_id = c.tenant_id and p.id = c.party_id
    left join organization_parties op on op.tenant_id = c.tenant_id and op.party_id = c.party_id
    left join customer_segments s on s.tenant_id = c.tenant_id and s.id = c.segment_id`

const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id,
  partyId: r.party_id,
  organizationId: r.organization_id,
  code: r.code,
  segmentId: r.segment_id,
  accountManagerMembershipId: r.account_manager_membership_id,
  paymentTermDays: r.payment_term_days,
  creditLimit: r.credit_limit,
  currency: r.currency,
  status: r.status,
  statusReason: r.status_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  partyName: r.party_name,
  partyKind: r.party_kind,
  taxId: r.tax_id,
  segmentName: r.segment_name,
})

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

export class LucidCustomerStore implements CustomerStore {
  async list(scope: TenantScope, filter: CustomerFilter) {
    const where = ['c.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.q) {
      const like = `%${escapeLike(filter.q.toLowerCase())}%`
      where.push(
        `(lower(p.display_name) like ? or lower(c.code) like ? or lower(coalesce(op.tax_id, '')) like ?)`
      )
      params.push(like, like, like)
    }
    for (const [column, value] of [
      ['c.segment_id', filter.segmentId],
      ['c.account_manager_membership_id', filter.accountManagerMembershipId],
      ['c.organization_id', filter.organizationId],
      ['c.party_id', filter.partyId],
      ['c.status', filter.status],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `${CUSTOMER_SELECT} where ${clause} order by lower(p.display_name), c.code limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total
         from customers c
         join parties p on p.tenant_id = c.tenant_id and p.id = c.party_id
         left join organization_parties op on op.tenant_id = c.tenant_id and op.party_id = c.party_id
        where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as CustomerRow[]).map(toCustomer),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `${CUSTOMER_SELECT} where c.tenant_id = ? and c.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as CustomerRow[]
    return row ? toCustomer(row) : null
  }

  async insert(scope: TenantScope, v: CustomerValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into customers (tenant_id, party_id, organization_id, code, segment_id, account_manager_membership_id,
           payment_term_days, credit_limit, currency, status, status_reason, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          tenantOf(scope),
          v.partyId,
          v.organizationId,
          v.code,
          v.segmentId,
          v.accountManagerMembershipId,
          v.paymentTermDays,
          v.creditLimit,
          v.currency,
          v.status,
          v.statusReason,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Customer
    } catch (error) {
      const constraint = constraintOf(error)
      if (constraint === 'customers_code_unique') return 'CODE'
      if (constraint === 'customers_party_unique') return 'PARTY'
      throw error
    }
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: CustomerValues) {
    const result = await trxOf(scope).rawQuery(
      `update customers
          set segment_id = ?, account_manager_membership_id = ?, payment_term_days = ?, credit_limit = ?, currency = ?,
              status = ?, status_reason = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.segmentId,
        v.accountManagerMembershipId,
        v.paymentTermDays,
        v.creditLimit,
        v.currency,
        v.status,
        v.statusReason,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }
}

// --- interacções ------------------------------------------------------------------------------------

interface InteractionRow {
  id: string
  party_id: string
  channel: InteractionChannel
  subject: string
  occurred_at: Date
  owner_membership_id: string
  summary: string
  follow_up_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}
const INTERACTION_COLUMNS =
  'id, party_id, channel, subject, occurred_at, owner_membership_id, summary, follow_up_at, version, created_at, updated_at'
const toInteraction = (r: InteractionRow): Interaction => ({
  id: r.id,
  partyId: r.party_id,
  channel: r.channel,
  subject: r.subject,
  occurredAt: iso(r.occurred_at),
  ownerMembershipId: r.owner_membership_id,
  summary: r.summary,
  followUpAt: r.follow_up_at ? iso(r.follow_up_at) : null,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidInteractionStore implements InteractionStore {
  async list(
    scope: TenantScope,
    filter: {
      partyId?: string
      ownerMembershipId?: string
      followUpBefore?: string
      limit: number
      offset: number
    }
  ) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.partyId) {
      where.push('party_id = ?')
      params.push(filter.partyId)
    }
    if (filter.ownerMembershipId) {
      where.push('owner_membership_id = ?')
      params.push(filter.ownerMembershipId)
    }
    if (filter.followUpBefore) {
      where.push('follow_up_at is not null and follow_up_at <= ?')
      params.push(filter.followUpBefore)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${INTERACTION_COLUMNS} from interactions where ${clause}
        order by occurred_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from interactions where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as InteractionRow[]).map(toInteraction),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${INTERACTION_COLUMNS} from interactions where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as InteractionRow[]
    return row ? toInteraction(row) : null
  }

  async insert(scope: TenantScope, v: InteractionValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into interactions (tenant_id, party_id, channel, subject, occurred_at, owner_membership_id, summary, follow_up_at,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.partyId,
        v.channel,
        v.subject,
        v.occurredAt,
        v.ownerMembershipId,
        v.summary,
        v.followUpAt,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Interaction
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: InteractionValues) {
    const result = await trxOf(scope).rawQuery(
      `update interactions
          set channel = ?, subject = ?, occurred_at = ?, summary = ?, follow_up_at = ?,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.channel,
        v.subject,
        v.occurredAt,
        v.summary,
        v.followUpAt,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }
}
