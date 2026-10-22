import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { ApiError } from '#core/http/api_error'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import { LucidMembershipStore } from '#core/membership/index'
import type {
  ChangeKind,
  MetricCode,
  PlanVersion,
  Subscription,
  SubscriptionStatus,
} from '#platform/billing/domain/plan'
import type {
  LockedSubscription,
  NewPlanVersion,
  PlanStore,
  SubscriptionChange,
  SubscriptionStore,
  UsageReader,
} from '#platform/billing/application/ports'

const conn = () => db.connection('runtime')

interface PlanRow {
  id: string
  plan_code: string
  revision: number
  name: string
  currency: string
  price: string
  billing_interval: PlanVersion['billingInterval']
  limits: PlanVersion['limits']
  entitlements: PlanVersion['entitlements']
  status: PlanVersion['status']
  published_at: Date | null
}

const toPlan = (r: PlanRow): PlanVersion => ({
  id: r.id,
  planCode: r.plan_code,
  revision: r.revision,
  name: r.name,
  currency: r.currency,
  price: r.price,
  billingInterval: r.billing_interval,
  limits: r.limits,
  entitlements: r.entitlements,
  status: r.status,
  publishedAt: r.published_at,
})

export class LucidPlanStore implements PlanStore {
  async insertDraft(input: NewPlanVersion) {
    return conn().transaction(async (trx) => {
      await trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [`plan:${input.planCode}`])
      const result = await trx.rawQuery(
        `insert into plan_versions
           (plan_code, revision, name, currency, price, billing_interval, limits, entitlements)
         select ?, coalesce(max(revision), 0) + 1, ?, ?, ?, ?, ?::jsonb, ?::jsonb
           from plan_versions where plan_code = ?
         returning *`,
        [
          input.planCode,
          input.name,
          input.currency,
          input.price,
          input.billingInterval,
          JSON.stringify(input.limits),
          JSON.stringify(input.entitlements),
          input.planCode,
        ]
      )
      return toPlan((result.rows as PlanRow[])[0])
    })
  }

  async findById(id: string) {
    const row = await conn().from('plan_versions').where('id', id).first()
    return row ? toPlan(row) : null
  }

  async find(planCode: string, revision: number) {
    const row = await conn().from('plan_versions').where({ plan_code: planCode, revision }).first()
    return row ? toPlan(row) : null
  }

  async latestPublished(planCode: string) {
    const row = await conn()
      .from('plan_versions')
      .where({ plan_code: planCode, status: 'PUBLISHED' })
      .orderBy('revision', 'desc')
      .first()
    return row ? toPlan(row) : null
  }

  async list() {
    const rows = await conn().from('plan_versions').orderBy(['plan_code', 'revision'])
    return (rows as PlanRow[]).map(toPlan)
  }

  async setStatus(id: string, from: PlanVersion['status'], to: PlanVersion['status'], now: Date) {
    const result = await conn().rawQuery(
      `update plan_versions
          set status = ?, updated_at = ?, version = version + 1,
              published_at = case when ? = 'PUBLISHED' then ? else published_at end
        where id = ? and status = ?
        returning *`,
      [to, now, to, now, id, from]
    )
    const [row] = result.rows as PlanRow[]
    return row ? toPlan(row) : null
  }
}

interface SubscriptionRow {
  id: string
  tenant_id: string
  plan_version_id: string
  status: SubscriptionStatus
  starts_at: Date
  period_end: Date
  trial_end: Date | null
  grace_end: Date | null
  adequacy_until: Date | null
  external_customer_id: string | null
  cancel_at_period_end: boolean
  version: number
}

const toSubscription = (r: SubscriptionRow): Subscription => ({
  id: r.id,
  tenantId: r.tenant_id,
  planVersionId: r.plan_version_id,
  status: r.status,
  startsAt: r.starts_at,
  periodEnd: r.period_end,
  trialEnd: r.trial_end,
  graceEnd: r.grace_end,
  adequacyUntil: r.adequacy_until,
  externalCustomerId: r.external_customer_id,
  cancelAtPeriodEnd: r.cancel_at_period_end,
  version: r.version,
})

const COLUMN: Record<string, string> = {
  planVersionId: 'plan_version_id',
  status: 'status',
  adequacyUntil: 'adequacy_until',
  graceEnd: 'grace_end',
  trialEnd: 'trial_end',
  cancelAtPeriodEnd: 'cancel_at_period_end',
}

class LockedTx implements LockedSubscription {
  constructor(
    private readonly trx: TransactionClientContract,
    private readonly tenantId: string
  ) {}

  async current() {
    const row = await this.trx
      .from('subscriptions')
      .where('tenant_id', this.tenantId)
      .whereNot('status', 'CANCELLED')
      .first()
    return row ? toSubscription(row) : null
  }

  async create(input: Parameters<LockedSubscription['create']>[0]) {
    try {
      const result = await this.trx.rawQuery(
        `insert into subscriptions
           (tenant_id, plan_version_id, status, starts_at, period_end, trial_end, grace_end)
         values (?, ?, ?, ?, ?, ?, ?) returning *`,
        [
          this.tenantId,
          input.planVersionId,
          input.status,
          input.startsAt,
          input.periodEnd,
          input.trialEnd as never,
          input.graceEnd as never,
        ]
      )
      return toSubscription((result.rows as SubscriptionRow[])[0])
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.notFound('Tenant não encontrado.')
      }
      throw error
    }
  }

  async update(id: string, patch: Parameters<LockedSubscription['update']>[1]) {
    const values: Record<string, unknown> = { updated_at: new Date() }
    for (const [key, value] of Object.entries(patch)) values[COLUMN[key]] = value
    const [row] = await this.trx
      .from('subscriptions')
      .where('id', id)
      .update(values)
      .increment('version', 1)
      .returning('*')
    return toSubscription(row as SubscriptionRow)
  }

  async record(change: Parameters<LockedSubscription['record']>[0]) {
    await this.trx.table('subscription_changes').insert({
      subscription_id: change.subscriptionId,
      tenant_id: this.tenantId,
      kind: change.kind,
      from_plan_version_id: change.fromPlanVersionId,
      to_plan_version_id: change.toPlanVersionId,
      from_status: change.fromStatus,
      to_status: change.toStatus,
      adequacy_until: change.adequacyUntil,
      detail: JSON.stringify(change.detail),
    })
  }
}

interface ChangeRow {
  id: string
  kind: ChangeKind
  from_plan_version_id: string | null
  to_plan_version_id: string | null
  from_status: SubscriptionStatus | null
  to_status: SubscriptionStatus | null
  adequacy_until: Date | null
  detail: Record<string, unknown>
  occurred_at: Date
}

export class LucidSubscriptionStore implements SubscriptionStore {
  /** Lock consultivo por tenant: serializa atribuições e mudanças mesmo quando ainda não há linha. */
  async exclusive<T>(tenantId: string, work: (tx: LockedSubscription) => Promise<T>) {
    return conn().transaction(async (trx) => {
      await trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [`subscription:${tenantId}`])
      return work(new LockedTx(trx, tenantId))
    })
  }

  /** Filtra sempre pelo tenant do contexto: a tabela é global (sem RLS). */
  async findCurrent(tenantId: string) {
    const row = await conn()
      .from('subscriptions')
      .where('tenant_id', tenantId)
      .whereNot('status', 'CANCELLED')
      .first()
    return row ? toSubscription(row) : null
  }

  async history(tenantId: string, limit: number): Promise<SubscriptionChange[]> {
    const rows = await conn()
      .from('subscription_changes')
      .where('tenant_id', tenantId)
      .orderBy([
        { column: 'occurred_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit)
    return (rows as ChangeRow[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      fromPlanVersionId: r.from_plan_version_id,
      toPlanVersionId: r.to_plan_version_id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      adequacyUntil: r.adequacy_until,
      detail: r.detail,
      occurredAt: r.occurred_at,
    }))
  }
}

/** Memberships ocupadas (não "LEFT"): conta memberships, não pessoas. */
export class LucidUsageReader implements UsageReader {
  private readonly uow = new LucidTenantDatabase()
  private readonly memberships = new LucidMembershipStore()

  async usage(tenantId: string): Promise<Record<MetricCode, number>> {
    return this.uow.run(
      async (scope) => ({ members: await this.memberships.countOccupied(scope) }),
      serviceTenantContext(tenantId, `billing-${Date.now()}`)
    )
  }
}
