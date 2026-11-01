import { ApiError } from '#core/http/api_error'
import { serviceTenantContext } from '#core/tenancy/index'
import { authServices, normalizeEmail } from '#core/auth/index'
import { LucidMembershipDirectory } from '#core/membership/index'
import { iamServices } from '#core/permissions/index'
import { LucidTenantStore } from '#platform/tenants/infrastructure/lucid_tenant_store'

/**
 * Operações de plataforma sobre autorização (comandos `node ace`), com contexto de **serviço** explícito
 * por tenant. Semear o catálogo de permissões e o papel `tenant_admin` é idempotente.
 */
export async function syncIam(): Promise<{ tenants: number }> {
  await iamServices().syncCatalog.execute()
  const tenants = await new LucidTenantStore().list()
  for (const tenant of tenants) {
    await iamServices().ensureTenantAdmin.execute(
      serviceTenantContext(tenant.id, `cmd-${Date.now()}`, tenant.defaultLocale)
    )
  }
  return { tenants: tenants.length }
}

/** Atribui o papel `tenant_admin` a um utilizador que já pertence ao tenant. */
export async function bootstrapTenantAdmin(code: string, email: string) {
  const tenant = await new LucidTenantStore().findByCode(code.trim().toLowerCase())
  if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
  const user = await authServices().users.findByEmail(normalizeEmail(email))
  if (!user) throw ApiError.notFound('Utilizador não encontrado.')
  const membership = await new LucidMembershipDirectory().findForUser(user.id, tenant.id)
  if (!membership) throw ApiError.notFound('O utilizador não pertence a este tenant.')

  await iamServices().syncCatalog.execute()
  return iamServices().ensureTenantAdmin.execute(
    serviceTenantContext(tenant.id, `cmd-${Date.now()}`, tenant.defaultLocale),
    membership.id
  )
}
