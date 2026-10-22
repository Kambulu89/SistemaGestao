import db from '@adonisjs/lucid/services/db'
import { serviceTenantContext, LucidTenantDatabase } from '#core/tenancy/index'
import { AddMember, LucidMembershipStore, type Membership } from '#core/membership/index'
import {
  ChangeTenantStatus,
  CreateTenant,
  LucidTenantStore,
  type Tenant,
} from '#platform/tenants/index'

const store = new LucidTenantStore()
let counter = 0

export const tenantCode = () => `mt_${process.pid}_${Date.now()}_${counter++}`

/** Cria um tenant já activo. */
export async function createActiveTenant(code = tenantCode()): Promise<Tenant> {
  const tenant = await new CreateTenant(store).execute({ code, name: `Tenant ${code}` })
  return new ChangeTenantStatus(store).execute(tenant.code, 'ACTIVE')
}

export async function addMember(
  tenant: Tenant,
  userId: string,
  status: 'ACTIVE' | 'INVITED' = 'ACTIVE'
): Promise<Membership> {
  return new AddMember(new LucidTenantDatabase(), new LucidMembershipStore()).execute(
    serviceTenantContext(tenant.id, 'teste'),
    { userId, status }
  )
}

/**
 * Remove memberships e tenants de teste. A RLS é forçada também para a conta dona, por isso as
 * memberships apagam-se dentro de uma transacção com o tenant definido.
 */
export async function deleteTestTenants() {
  const owner = db.connection('owner')
  const tenants = await owner.from('tenants').where('code', 'like', 'mt\\_%').select('id')
  for (const { id } of tenants) {
    await owner.transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [id])
      for (const table of [
        'invitations',
        'user_preferences',
        'role_assignments',
        'role_permissions',
        'roles',
        'access_policies',
        'membership_scopes',
        'team_members',
        'cost_centers',
        'organization_units',
        'organizations',
      ]) {
        await trx.from(table).where('tenant_id', id).delete()
      }
      await trx.from('tenant_memberships').where('tenant_id', id).delete()
    })
  }
  await owner.rawQuery(
    `delete from tenant_domains where tenant_id in (select id from tenants where code like 'mt\\_%')`
  )
  await owner.rawQuery(`delete from tenants where code like 'mt\\_%'`)
}
