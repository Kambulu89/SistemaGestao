import type { User } from '#modules/identity/index'
import type { Tenant, TenantContext } from '#modules/tenancy/index'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** Definido pelo middleware `auth`. */
    authUser?: User
    sessionId?: string
    /** Definidos pelo middleware `tenant`. */
    tenant?: Tenant
    tenantContext?: TenantContext
  }
}
