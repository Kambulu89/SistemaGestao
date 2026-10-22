import type { Tenant, TenantDomain, TenantStatus } from '#platform/tenants/domain/tenant'

export interface TenantStore {
  /** `null` se o código já existir (decidido pela base). */
  insert(input: {
    code: string
    name: string
    defaultLocale?: string
    timezone?: string
  }): Promise<Tenant | null>
  findByCode(code: string): Promise<Tenant | null>
  findById(id: string): Promise<Tenant | null>
  /** Muda o estado só se a versão coincidir. Devolve `null` em conflito. */
  updateStatus(
    id: string,
    status: TenantStatus,
    expectedVersion: number,
    now: Date
  ): Promise<Tenant | null>
  /** `null` se o hostname já pertencer a qualquer tenant (unicidade global). */
  insertDomain(input: {
    tenantId: string
    hostname: string
    verificationTokenHash: string
    isPrimary: boolean
  }): Promise<TenantDomain | null>
  findDomainByHostname(
    hostname: string
  ): Promise<(TenantDomain & { verificationTokenHash: string | null }) | null>
  markDomainVerified(id: string, now: Date): Promise<void>
  hasDomains(tenantId: string): Promise<boolean>
}
