import env from '#start/env'
import { LucidMembershipStore } from '#core/membership/index'
import { LucidOutboxReader } from '#core/outbox/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { LucidTenantStore, isOperational } from '#platform/tenants/index'
import { NotificationEngine, NotificationWorker } from '#modules/notifications/application/engine'
import {
  CenterUseCases,
  DeliveryAdminUseCases,
  PreferenceUseCases,
  RequestService,
} from '#modules/notifications/application/notification_use_cases'
import type { References } from '#modules/notifications/application/ports'
import { AesGcmCipher } from '#modules/notifications/infrastructure/cipher'
import {
  LucidCenterStore,
  LucidDeliveryStore,
  LucidPreferenceStore,
  LucidRequestStore,
} from '#modules/notifications/infrastructure/lucid_notifications'

const memberships = new LucidMembershipStore()
const references: References = {
  async membershipActive(scope, membershipId) {
    const found = await memberships.findById(scope, membershipId)
    return found?.status === 'ACTIVE'
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const cipher = new AesGcmCipher(env.get('APP_KEY'))
  const requests = new LucidRequestStore()
  const deliveries = new LucidDeliveryStore(cipher)
  const center = new LucidCenterStore()
  const preferences = new LucidPreferenceStore()
  const clock = { now: () => new Date() }
  const tenants = new LucidTenantStore()
  const requestService = new RequestService(
    uow,
    requests,
    deliveries,
    center,
    preferences,
    references,
    cipher,
    clock
  )
  const engine = (onError?: (tenantId: string, error: unknown) => void) =>
    new NotificationEngine(
      uow,
      new LucidOutboxReader(),
      requestService,
      deliveries,
      requests,
      clock,
      onError
    )
  return {
    requests: requestService,
    center: new CenterUseCases(uow, center, clock),
    preferences: new PreferenceUseCases(uow, preferences),
    deliveries: new DeliveryAdminUseCases(uow, deliveries, requests, clock),
    engine,
    worker: (onError?: (tenantId: string, error: unknown) => void) =>
      new NotificationWorker(
        engine(onError),
        async () => {
          const all = await tenants.list()
          return all.filter((t) => isOperational(t.status)).map((t) => t.id)
        },
        onError
      ),
  }
}

let instance: ReturnType<typeof build> | undefined

export const notificationServices = () => (instance ??= build())
