import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { ApiError } from '#shared/http/api_error'
import { FEATURES } from '#modules/subscription/domain/features'
import {
  computeEntitlements,
  effectiveStatus,
  type Entitlement,
} from '#modules/subscription/domain/subscription'
import { SubscriptionRepository } from '#modules/subscription/infrastructure/subscription_repository'

const repository = new SubscriptionRepository()

/** Funcionalidades efectivas de um tenant agora (plano + excepções), e o estado efectivo da subscrição. */
export async function entitlementsFor(tenantId: string, now = new Date()) {
  const subscription = await repository.currentSubscription(tenantId)
  const status = effectiveStatus(subscription, now)
  const plan = subscription ? await repository.findPlan(subscription.planId) : null
  const overrides = await repository.overrides(tenantId)
  const features = computeEntitlements(FEATURES, status, plan?.features ?? [], overrides, now)
  return { subscription, status, plan, features }
}

export async function assertEntitled(tenantId: string, feature: string) {
  const { features } = await entitlementsFor(tenantId)
  if (!features.get(feature)?.enabled) {
    throw ApiError.forbidden(
      'NOT_ENTITLED',
      'Esta funcionalidade não está incluída na subscrição da empresa.'
    )
  }
}

/**
 * Verifica um limite contratado dentro da transacção de quem vai criar o registo. Primeiro serializa por tenant e limite
 * (advisory lock), depois o chamador conta: assim dois pedidos simultâneos não ultrapassam o limite juntos.
 */
export async function assertWithinLimit(
  trx: TransactionClientContract,
  tenantId: string,
  feature: string,
  count: () => Promise<number>
) {
  await trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [`${tenantId}:limit:${feature}`])
  const entitlement: Entitlement | undefined = (await entitlementsFor(tenantId)).features.get(
    feature
  )
  if (!entitlement?.enabled) {
    throw ApiError.forbidden(
      'NOT_ENTITLED',
      'Esta funcionalidade não está incluída na subscrição da empresa.'
    )
  }
  if (entitlement.limit !== null && (await count()) >= entitlement.limit) {
    throw ApiError.conflict('LIMIT_REACHED', `Atingiu o limite contratado (${entitlement.limit}).`)
  }
}
