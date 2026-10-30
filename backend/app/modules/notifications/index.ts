/** API pública das notificações (S02). Outros módulos importam **apenas** daqui. */
export { notificationServices } from '#modules/notifications/presentation/composition'
export {
  registerChannelProvider,
  registerConsentGuard,
  registerNotificationRule,
  registerResourceLink,
  unregisterChannelProvider,
} from '#modules/notifications/application/registry'
export {
  ProviderError,
  type ChannelProvider,
  type NotificationRule,
  type OutgoingMessage,
  type RequestDraft,
} from '#modules/notifications/application/ports'
export { NOTIFICATION_TYPES } from '#modules/notifications/domain/notifications'
