import { ApiError } from '#core/http/api_error'
import { serviceTenantContext } from '#core/tenancy/index'
import { authServices, normalizeEmail } from '#core/auth/index'
import {
  AddMember,
  ChangeMembershipStatus,
  LucidMembershipStore,
  type MembershipStatus,
} from '#core/membership/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { LucidTenantStore } from '#platform/tenants/infrastructure/lucid_tenant_store'

/**
 * Operações de plataforma sobre memberships (comandos `node ace`): resolvem o tenant pelo código e
 * correm com um contexto de **serviço** explícito para esse tenant. Os convites e a API de membros
 * chegam na fatia 1.6.
 */
async function target(code: string, email: string) {
  const tenant = await new LucidTenantStore().findByCode(code.trim().toLowerCase())
  if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
  const user = await authServices().users.findByEmail(normalizeEmail(email))
  if (!user) throw ApiError.notFound('Utilizador não encontrado.')
  return {
    user,
    context: serviceTenantContext(tenant.id, `cmd-${Date.now()}`, tenant.defaultLocale),
  }
}

export async function addMemberByEmail(code: string, email: string) {
  const { user, context } = await target(code, email)
  return new AddMember(new LucidTenantDatabase(), new LucidMembershipStore()).execute(context, {
    userId: user.id,
  })
}

export async function changeMemberStatusByEmail(
  code: string,
  email: string,
  status: MembershipStatus
) {
  const { user, context } = await target(code, email)
  return new ChangeMembershipStatus(new LucidTenantDatabase(), new LucidMembershipStore()).execute(
    context,
    { userId: user.id, status }
  )
}
