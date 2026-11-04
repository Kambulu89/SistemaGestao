import db from '@adonisjs/lucid/services/db'

export interface UserTenantLink {
  membershipId: string
  tenantId: string
  status: string
}

/**
 * Vínculos de um utilizador em todos os tenants, pela função `app_user_tenants` (a RLS das memberships não permite à
 * conta de runtime ler fora do tenant em contexto). Chamar **só** com o utilizador autenticado.
 */
export async function userTenantLinks(userId: string): Promise<UserTenantLink[]> {
  const result = await db
    .connection('runtime')
    .rawQuery('select membership_id, tenant_id, membership_status from app_user_tenants(?)', [
      userId,
    ])
  return (
    result.rows as { membership_id: string; tenant_id: string; membership_status: string }[]
  ).map((r) => ({
    membershipId: r.membership_id,
    tenantId: r.tenant_id,
    status: r.membership_status,
  }))
}
