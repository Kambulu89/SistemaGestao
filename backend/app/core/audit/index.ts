/** API pública do módulo de auditoria (S06). Outros módulos importam **apenas** daqui. */
export { REDACTED, redactSecrets } from '#core/audit/domain/redaction'
export {
  AUDIT_EXEMPT_TABLES,
  AUDIT_READ_PERMISSION,
  SECURITY_EVENT_TYPES,
  type SecurityEventInput,
  type SecurityEventType,
  type SecurityEventView,
  type Severity,
} from '#core/audit/domain/security_event'
export type { SecurityEventLog } from '#core/audit/application/ports'
export { securityEvents } from '#core/audit/presentation/composition'
