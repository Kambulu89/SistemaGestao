/** API pública do módulo de identidade. */
export type { User } from '#modules/identity/domain/user'
export { normalizeEmail, passwordIssues } from '#modules/identity/domain/user'
export { AccountService } from '#modules/identity/application/account_service'
export {
  devMailboxMessages,
  clearDevMailbox,
  type DeliveryStatus,
} from '#modules/identity/infrastructure/mailer'
