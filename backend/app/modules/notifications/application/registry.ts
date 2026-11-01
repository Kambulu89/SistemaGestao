import type { Channel } from '#modules/notifications/domain/notifications'
import type {
  NotificationRule,
  ChannelProvider,
  ConsentGuard,
  ResourceLink,
} from '#modules/notifications/application/ports'

/**
 * Pontos de ligação públicos do serviço de notificações. Cada módulo regista, no arranque, o que sabe sobre si
 * (regras que transformam eventos do outbox em pedidos, a guarda do consentimento promocional e as ligações a recursos);
 * o serviço nunca importa os módulos que o usam. Os fornecedores de canal registam-se do mesmo modo.
 */
const rules = new Map<string, NotificationRule>()
const guards = new Map<string, ConsentGuard>()
const resources = new Map<string, ResourceLink>()
const providers = new Map<Channel, ChannelProvider>()

export function registerNotificationRule(rule: NotificationRule): void {
  rules.set(rule.code, rule)
}

/** `resourceType` é o tipo do recurso do pedido promocional (por exemplo, `campaign_member`). */
export function registerConsentGuard(resourceType: string, guard: ConsentGuard): void {
  guards.set(resourceType, guard)
}

export function registerResourceLink(resourceType: string, link: ResourceLink): void {
  resources.set(resourceType, link)
}

/** Um canal externo só entrega depois de ter um fornecedor real configurado e registado. */
export function registerChannelProvider(provider: ChannelProvider): void {
  providers.set(provider.channel, provider)
}

export function unregisterChannelProvider(channel: Channel): void {
  providers.delete(channel)
}

export const rulesFor = (eventType: string): NotificationRule[] =>
  [...rules.values()].filter((r) => r.eventTypes.includes(eventType))
export const consentGuardOf = (resourceType: string): ConsentGuard | undefined =>
  guards.get(resourceType)
export const resourceLinkOf = (resourceType: string): ResourceLink | undefined =>
  resources.get(resourceType)
export const providerOf = (channel: Channel): ChannelProvider | undefined => providers.get(channel)
