import { LucidTenantDatabase } from '#core/tenancy/index'
import {
  LucidAuditReader,
  LucidSecurityEventLog,
  LucidSecurityEventReader,
} from '#core/audit/infrastructure/lucid_audit'

export const securityEvents = new LucidSecurityEventLog()

export const auditServices = {
  uow: new LucidTenantDatabase(),
  audit: new LucidAuditReader(),
  events: new LucidSecurityEventReader(),
}
