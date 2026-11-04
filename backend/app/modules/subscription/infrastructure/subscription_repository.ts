import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { SubscriptionStatus } from '#modules/subscription/domain/subscription'

export const conn = () => db.connection('runtime')
type Q = TransactionClientContract | ReturnType<typeof conn>

export interface Plan {
  id: string
  code: string
  name: string
  description: string | null
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED'
  trialDays: number
  publishedAt: Date | null
  version: number
  features: { featureCode: string; enabled: boolean; limitValue: number | null }[]
}

export interface Subscription {
  id: string
  tenantId: string
  planId: string
  planCode: string
  status: SubscriptionStatus
  startsAt: Date
  trialEndsAt: Date | null
  endsAt: Date | null
  version: number
}

const PLAN_SELECT = `
  select p.id, p.code, p.name, p.description, p.status, p.trial_days, p.published_at, p.version,
         coalesce(json_agg(json_build_object('featureCode', pf.feature_code, 'enabled', pf.enabled,
                  'limitValue', pf.limit_value) order by pf.feature_code)
                  filter (where pf.id is not null), '[]') as features
    from plans p left join plan_features pf on pf.plan_id = p.id`

const toPlan = (r: Record<string, any>): Plan => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  status: r.status,
  trialDays: r.trial_days,
  publishedAt: r.published_at,
  version: r.version,
  features: r.features,
})

const SUB_SELECT = `select s.id, s.tenant_id, s.plan_id, p.code as plan_code, s.status, s.starts_at, s.trial_ends_at,
                           s.ends_at, s.version from subscriptions s join plans p on p.id = s.plan_id`
const toSub = (r: Record<string, any>): Subscription => ({
  id: r.id,
  tenantId: r.tenant_id,
  planId: r.plan_id,
  planCode: r.plan_code,
  status: r.status,
  startsAt: r.starts_at,
  trialEndsAt: r.trial_ends_at,
  endsAt: r.ends_at,
  version: r.version,
})

/** Repositório do plano de controlo das subscrições (tabelas globais; só a plataforma escreve). */
export class SubscriptionRepository {
  async listPlans(q: Q = conn()): Promise<Plan[]> {
    const r = await q.rawQuery(`${PLAN_SELECT} group by p.id order by p.code`)
    return r.rows.map(toPlan)
  }

  async findPlan(id: string, q: Q = conn(), lock = false): Promise<Plan | null> {
    if (lock) await q.rawQuery('select id from plans where id = ? for update', [id])
    const r = await q.rawQuery(`${PLAN_SELECT} where p.id = ? group by p.id`, [id])
    return r.rows[0] ? toPlan(r.rows[0]) : null
  }

  async findPlanByCode(code: string, q: Q = conn()): Promise<Plan | null> {
    const r = await q.rawQuery(`${PLAN_SELECT} where p.code = ? group by p.id`, [code])
    return r.rows[0] ? toPlan(r.rows[0]) : null
  }

  async insertPlan(
    q: Q,
    v: { code: string; name: string; description: string | null; trialDays: number }
  ) {
    const r = await q.rawQuery(
      `insert into plans (code, name, description, trial_days) values (?, ?, ?, ?) returning id`,
      [v.code, v.name, v.description, v.trialDays] as never[]
    )
    return (r.rows[0] as { id: string }).id
  }

  async updatePlan(
    q: Q,
    id: string,
    expectedVersion: number,
    v: { name: string; description: string | null; trialDays: number }
  ) {
    const r = await q.rawQuery(
      `update plans set name = ?, description = ?, trial_days = ?, version = version + 1, updated_at = now()
        where id = ? and version = ? returning id`,
      [v.name, v.description, v.trialDays, id, expectedVersion] as never[]
    )
    return r.rows.length > 0
  }

  async replacePlanFeatures(
    q: Q,
    planId: string,
    features: { featureCode: string; enabled: boolean; limitValue: number | null }[]
  ) {
    await q.rawQuery('delete from plan_features where plan_id = ?', [planId])
    for (const f of features) {
      await q.rawQuery(
        'insert into plan_features (plan_id, feature_code, enabled, limit_value) values (?, ?, ?, ?)',
        [planId, f.featureCode, f.enabled, f.limitValue] as never[]
      )
    }
  }

  async setPlanStatus(q: Q, id: string, status: Plan['status']) {
    await q.rawQuery(
      `update plans set status = ?, published_at = case when ? = 'ACTIVE' then now() else published_at end,
              version = version + 1, updated_at = now() where id = ?`,
      [status, status, id]
    )
  }

  async currentSubscription(
    tenantId: string,
    q: Q = conn(),
    lock = false
  ): Promise<Subscription | null> {
    const r = await q.rawQuery(
      `${SUB_SELECT} where s.tenant_id = ? and s.status in ('TRIALING', 'ACTIVE', 'SUSPENDED')${lock ? ' for update of s' : ''}`,
      [tenantId]
    )
    return r.rows[0] ? toSub(r.rows[0]) : null
  }

  async findSubscription(id: string, q: Q = conn(), lock = false): Promise<Subscription | null> {
    const r = await q.rawQuery(`${SUB_SELECT} where s.id = ?${lock ? ' for update of s' : ''}`, [
      id,
    ])
    return r.rows[0] ? toSub(r.rows[0]) : null
  }

  async insertSubscription(
    q: Q,
    v: { tenantId: string; planId: string; status: SubscriptionStatus; trialEndsAt: Date | null }
  ) {
    const r = await q.rawQuery(
      `insert into subscriptions (tenant_id, plan_id, status, starts_at, trial_ends_at) values (?, ?, ?, now(), ?) returning id`,
      [v.tenantId, v.planId, v.status, v.trialEndsAt] as never[]
    )
    return (r.rows[0] as { id: string }).id
  }

  async updateSubscription(
    q: Q,
    id: string,
    expectedVersion: number,
    v: { status: SubscriptionStatus; planId: string; endsAt: Date | null }
  ) {
    const r = await q.rawQuery(
      `update subscriptions set status = ?, plan_id = ?, ends_at = ?, version = version + 1, updated_at = now()
        where id = ? and version = ? returning id`,
      [v.status, v.planId, v.endsAt, id, expectedVersion] as never[]
    )
    return r.rows.length > 0
  }

  async addEvent(
    q: Q,
    e: {
      subscriptionId: string
      tenantId: string
      action: string
      fromStatus: string | null
      toStatus: string
      planId: string
      actorUserId: string | null
      reason: string | null
    }
  ) {
    await q.rawQuery(
      `insert into subscription_events (subscription_id, tenant_id, action, from_status, to_status, plan_id, actor_user_id, reason)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.subscriptionId,
        e.tenantId,
        e.action,
        e.fromStatus,
        e.toStatus,
        e.planId,
        e.actorUserId,
        e.reason,
      ] as never[]
    )
  }

  async events(tenantId: string) {
    const r = await conn().rawQuery(
      `select e.id, e.action, e.from_status, e.to_status, p.code as plan_code, e.actor_user_id, e.reason, e.created_at
         from subscription_events e join plans p on p.id = e.plan_id where e.tenant_id = ? order by e.created_at desc, e.id desc`,
      [tenantId]
    )
    return r.rows.map((x: Record<string, any>) => ({
      id: x.id,
      action: x.action,
      fromStatus: x.from_status,
      toStatus: x.to_status,
      planCode: x.plan_code,
      actorUserId: x.actor_user_id,
      reason: x.reason,
      createdAt: x.created_at,
    }))
  }

  async overrides(tenantId: string) {
    const r = await conn().rawQuery(
      `select feature_code, enabled, limit_value, reason, expires_at from tenant_entitlement_overrides where tenant_id = ?`,
      [tenantId]
    )
    return r.rows.map((x: Record<string, any>) => ({
      featureCode: x.feature_code as string,
      enabled: x.enabled as boolean,
      limitValue: x.limit_value as number | null,
      reason: x.reason as string,
      expiresAt: x.expires_at as Date | null,
    }))
  }

  async upsertOverride(v: {
    tenantId: string
    featureCode: string
    enabled: boolean
    limitValue: number | null
    reason: string
    expiresAt: Date | null
    createdBy: string
  }) {
    await conn().rawQuery(
      `insert into tenant_entitlement_overrides (tenant_id, feature_code, enabled, limit_value, reason, expires_at, created_by)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, feature_code) do update set enabled = excluded.enabled, limit_value = excluded.limit_value,
         reason = excluded.reason, expires_at = excluded.expires_at, created_by = excluded.created_by, updated_at = now()`,
      [
        v.tenantId,
        v.featureCode,
        v.enabled,
        v.limitValue,
        v.reason,
        v.expiresAt,
        v.createdBy,
      ] as never[]
    )
  }

  async deleteOverride(tenantId: string, featureCode: string) {
    const r = await conn().rawQuery(
      'delete from tenant_entitlement_overrides where tenant_id = ? and feature_code = ? returning id',
      [tenantId, featureCode]
    )
    return r.rows.length > 0
  }
}
