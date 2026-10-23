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
      await trx.rawQuery(
        `select set_config('app.tenant_id', ?, true),
                set_config('app.audit_purge', 'on', true),
                set_config('app.audit_disabled', 'on', true)`,
        [id]
      )
      // A auditoria é imutável: só a conta dona, com o interruptor de retenção, a pode apagar.
      await trx.from('audit_logs').where('tenant_id', id).delete()
      await trx.from('tenant_memberships').where('tenant_id', id).update({ person_id: null })
      // Unidades derivadas primeiro (a FK para a base é RESTRICT).
      await trx
        .from('units_of_measure')
        .where('tenant_id', id)
        .whereNotNull('base_unit_id')
        .delete()
      for (const table of [
        'outbox_deliveries',
        'automation_runs',
        'automations',
        'approval_delegations',
        'workflow_tasks',
        'workflow_instances',
        'workflow_definitions',
        'outbox_events',
        'state_history',
        'record_states',
        'state_machines',
        'form_definitions',
        'rule_evaluations',
        'rule_definitions',
        'dynamic_unique_values',
        'dynamic_records',
        'field_definitions',
        'entity_schema_versions',
        'entity_definitions',
        'sequences',
        'tax_rates',
        'units_of_measure',
        'setting_values',
        'tenant_features',
        'tenant_modules',
        'party_relationships',
        'addresses',
        'contacts',
        'people',
        'organization_parties',
        'parties',
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
  await deleteTenantRows('mt\\_%')
}

/**
 * Apaga tenants de teste e o que lhes é próprio (domínios, auditoria). A auditoria é imutável: só a
 * conta dona, com os interruptores de retenção/desactivação, a apaga.
 */
export async function deleteTenantRows(codePattern: string) {
  const owner = db.connection('owner')
  const tenants = await owner.from('tenants').where('code', 'like', codePattern).select('id')
  for (const { id } of tenants) {
    await owner.transaction(async (trx) => {
      await trx.rawQuery(
        `select set_config('app.tenant_id', ?, true), set_config('app.audit_purge', 'on', true),
                set_config('app.audit_disabled', 'on', true)`,
        [id]
      )
      await trx.from('subscription_changes').where('tenant_id', id).delete()
      await trx.from('subscriptions').where('tenant_id', id).delete()
      await trx.from('tenant_domains').where('tenant_id', id).delete()
      await trx.from('audit_logs').where('tenant_id', id).delete()
      await trx.from('security_events').where('tenant_id', id).delete()
      await trx.from('tenants').where('id', id).delete()
    })
  }
}
