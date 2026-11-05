/** API pública da auditoria: os módulos gravam eventos na sua própria transacção com `audit(scope, …)`. */
export { audit, writeAudit, listAuditEvents } from '#modules/audit/application/audit_log'
export { diff, redact, type AuditInput } from '#modules/audit/domain/audit'
