import db from '@adonisjs/lucid/services/db'
import { ApiError } from '#core/http/api_error'
import { serviceTenantContext, type TenantContext } from '#core/tenancy/index'
import { iamServices } from '#core/permissions/index'
import { organizationServices } from '#core/organization/index'
import { memberServices } from '#core/members/index'
import { billingServices } from '#platform/billing/index'
import { ChangeTenantStatus, CreateTenant, LucidTenantStore } from '#platform/tenants/index'
import type {
  PlatformGrant,
  PlatformPermission,
  ProvisioningStep,
} from '#platform/administration/domain/platform'
import type {
  GrantStore,
  ProvisioningGateway,
  ProvisioningState,
  TenantSummary,
} from '#platform/administration/application/ports'

const conn = () => db.connection('runtime')

interface GrantRow {
  id: string
  user_id: string
  permission: PlatformPermission
  reason: string
  expires_at: Date | null
  revoked_at: Date | null
  created_at: Date
}

const toGrant = (r: GrantRow): PlatformGrant => ({
  id: r.id,
  userId: r.user_id,
  permission: r.permission,
  reason: r.reason,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
})

export class LucidGrantStore implements GrantStore {
  async insert(input: {
    userId: string
    permission: PlatformPermission
    reason: string
    expiresAt: Date | null
  }) {
    const result = await conn().rawQuery(
      `insert into platform_grants (user_id, permission, reason, expires_at)
       values (?, ?, ?, ?)
       on conflict do nothing
       returning *`,
      [input.userId, input.permission, input.reason, input.expiresAt as never]
    )
    const [row] = result.rows as GrantRow[]
    return row ? toGrant(row) : null
  }

  async revoke(userId: string, permission: PlatformPermission, now: Date) {
    const result = await conn().rawQuery(
      `update platform_grants set revoked_at = ?, updated_at = ?, version = version + 1
        where user_id = ? and permission = ? and revoked_at is null`,
      [now, now, userId, permission]
    )
    return (result.rowCount ?? 0) > 0
  }

  async forUser(userId: string) {
    const rows = await conn().from('platform_grants').where('user_id', userId)
    return (rows as GrantRow[]).map(toGrant)
  }

  async list() {
    const rows = await conn().from('platform_grants').orderBy('created_at', 'desc')
    return (rows as GrantRow[]).map(toGrant)
  }
}

/**
 * Provisionamento sobre as APIs públicas dos outros módulos (tenants, billing, permissões, organização,
 * membros). Corre com contextos de **serviço** do tenant alvo: o administrador de plataforma não passa a
 * ter acesso a dados do tenant, só desencadeia estes passos.
 */
export class LucidProvisioningGateway implements ProvisioningGateway {
  private readonly tenants = new LucidTenantStore()

  private async context(tenantId: string): Promise<TenantContext> {
    const tenant = await this.tenants.findById(tenantId)
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
    return serviceTenantContext(tenant.id, `platform-${Date.now()}`, tenant.defaultLocale)
  }

  async findTenant(code: string) {
    const tenant = await this.tenants.findByCode(code)
    return tenant ? { id: tenant.id, code: tenant.code, status: tenant.status } : null
  }

  async createTenant(input: { code: string; name: string }) {
    try {
      await new CreateTenant(this.tenants).execute(input)
      return true
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TENANT_CODE_TAKEN') return false
      throw error
    }
  }

  async assignPlan(input: {
    tenantId: string
    planCode: string
    revision?: number
    trialDays?: number
  }) {
    await billingServices().assignSubscription.execute(input)
  }

  async ensureAdminRole(tenantId: string) {
    await iamServices().syncCatalog.execute()
    const role = await iamServices().ensureTenantAdmin.execute(await this.context(tenantId))
    return { roleId: role.id }
  }

  async ensureInitialOrganization(tenantId: string, name: string) {
    const context = await this.context(tenantId)
    const services = organizationServices()
    const existing = await services.organizations.list(context)
    if (existing.length > 0) return
    try {
      await services.organizations.create(context, {
        code: 'MAIN',
        legalName: name,
        tradeName: null,
        countryCode: 'AO',
        taxId: null,
        baseCurrency: 'AOA',
        fiscalYearStartMonth: 1,
        addressId: null,
        active: true,
      })
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'ORGANIZATION_CODE_TAKEN')) throw error
    }
  }

  async inviteAdmin(tenantId: string, email: string, roleId: string) {
    try {
      await memberServices().invitations.create(await this.context(tenantId), {
        email,
        roleIds: [roleId],
        unitIds: [],
      })
    } catch (error) {
      // Já há convite pendente, ou o utilizador já é membro: o passo está feito.
      if (!(
        error instanceof ApiError && ['INVITATION_PENDING', 'ALREADY_MEMBER'].includes(error.code)
      )) {
        throw error
      }
    }
  }

  async activate(code: string) {
    await new ChangeTenantStatus(this.tenants).execute(code, 'ACTIVE')
  }

  async changeStatus(code: string, to: 'SUSPENDED' | 'ACTIVE') {
    await new ChangeTenantStatus(this.tenants).execute(code, to)
  }

  async summarize(tenantId: string): Promise<TenantSummary | null> {
    const tenant = await this.tenants.findById(tenantId)
    if (!tenant) return null
    const plan = await billingServices().subscriptionSummary.execute(tenant.id)
    return {
      id: tenant.id,
      code: tenant.code,
      name: tenant.name,
      status: tenant.status,
      plan: plan ? { code: plan.planCode, revision: plan.revision, status: plan.status } : null,
    }
  }

  async listTenants() {
    const tenants = await this.tenants.list()
    const summaries = await Promise.all(tenants.map((t) => this.summarize(t.id)))
    return summaries.filter((s): s is TenantSummary => s !== null)
  }

  async state(tenantId: string): Promise<ProvisioningState> {
    const tenant = await this.summarize(tenantId)
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
    const context = await this.context(tenantId)
    const roles = await iamServices().roles.list(context)
    const organizationList = await organizationServices().organizations.list(context)
    const organizations = organizationList.length
    const invitations = await memberServices().invitations.list(context)
    const pending = invitations.filter((i) => i.status === 'PENDING').length
    const invited = invitations.length > 0

    const done: ProvisioningStep[] = ['TENANT']
    if (tenant.plan) done.push('SUBSCRIPTION')
    if (roles.some((r) => r.code === 'tenant_admin')) done.push('ADMIN_ROLE')
    if (organizations > 0) done.push('ORGANIZATION')
    if (invited) done.push('ADMIN_INVITATION')
    if (tenant.status === 'ACTIVE') done.push('ACTIVATION')
    return { tenant, done, organizations, pendingInvitations: pending }
  }
}
