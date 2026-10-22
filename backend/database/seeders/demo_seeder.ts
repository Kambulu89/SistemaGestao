import { BaseSeeder } from '@adonisjs/lucid/seeders'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { ApiError } from '#core/http/api_error'
import { authServices } from '#core/auth/index'
import { organizationServices } from '#core/organization/index'
import { LucidMembershipDirectory } from '#core/membership/index'
import { serviceTenantContext } from '#core/tenancy/index'
import {
  ChangeTenantStatus,
  CreateTenant,
  LucidTenantStore,
  RegisterTenantDomain,
  addMemberByEmail,
  bootstrapTenantAdmin,
} from '#platform/tenants/index'

/** Dois tenants de demonstração, separados. Os domínios/emails usam TLDs reservados (`.test`, `.invalid`). */
const DEMO = [
  { code: 'demo_a', name: 'Demo A', host: 'demo-a.exemplo.test', admin: 'admin@demo-a.invalid' },
  { code: 'demo_b', name: 'Demo B', host: 'demo-b.exemplo.test', admin: 'admin@demo-b.invalid' },
] as const

/** Conta presente nos dois tenants: serve para exercitar a troca de tenant. */
const MULTI_TENANT_USER = 'multi@demo.invalid'

const ignoreConflict = async (action: () => Promise<unknown>) => {
  try {
    await action()
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error
  }
}

/**
 * Idempotente. Nunca corre em produção. A palavra-passe vem de `DEMO_USER_PASSWORD`
 * (nada de credenciais no código). Cada administrador demo recebe o papel `tenant_admin`; `multi@` é membro sem papéis (nega por omissão).
 */
export default class DemoSeeder extends BaseSeeder {
  static environment = ['development', 'test']

  async run() {
    if (app.inProduction) throw new Error('Os dados de demonstração não correm em produção.')
    const password = env.get('DEMO_USER_PASSWORD')
    if (!password) {
      throw new Error('Defina DEMO_USER_PASSWORD (12+ caracteres) para criar os utilizadores demo.')
    }

    const store = new LucidTenantStore()
    for (const demo of DEMO) {
      await ignoreConflict(async () => {
        await new CreateTenant(store).execute({ code: demo.code, name: demo.name })
      })
      const tenant = await store.findByCode(demo.code)
      if (tenant?.status === 'PROVISIONING') {
        await new ChangeTenantStatus(store).execute(demo.code, 'ACTIVE')
      }
      await ignoreConflict(async () => {
        await new RegisterTenantDomain(store).execute({ code: demo.code, hostname: demo.host })
      })
      await ignoreConflict(async () => {
        await authServices().createUser.execute({
          email: demo.admin,
          displayName: `Administrador ${demo.name}`,
          password,
          verified: true,
        })
      })
      await ignoreConflict(() => addMemberByEmail(demo.code, demo.admin))
      await bootstrapTenantAdmin(demo.code, demo.admin)
    }

    await ignoreConflict(async () => {
      await authServices().createUser.execute({
        email: MULTI_TENANT_USER,
        displayName: 'Utilizador nos dois tenants',
        password,
        verified: true,
      })
    })
    for (const demo of DEMO) {
      await ignoreConflict(() => addMemberByEmail(demo.code, MULTI_TENANT_USER))
      await this.seedOrganization(store, demo)
    }
  }

  /** Organização de demonstração com uma árvore de unidades e um âmbito total para o administrador. */
  private async seedOrganization(store: LucidTenantStore, demo: (typeof DEMO)[number]) {
    const tenant = await store.findByCode(demo.code)
    const admin = await authServices().users.findByEmail(demo.admin)
    if (!tenant || !admin) return
    const membership = await new LucidMembershipDirectory().findForUser(admin.id, tenant.id)
    if (!membership) return

    const context = serviceTenantContext(tenant.id, `seed-${demo.code}`, tenant.defaultLocale)
    const services = organizationServices()
    const code = `ORG-${demo.code.toUpperCase()}`
    await ignoreConflict(() =>
      services.organizations.create(context, {
        code,
        legalName: `${demo.name}, Lda.`,
        tradeName: demo.name,
        countryCode: 'AO',
        taxId: null,
        baseCurrency: 'AOA',
        fiscalYearStartMonth: 1,
        addressId: null,
        active: true,
      })
    )
    const organizations = await services.organizations.list(context)
    const organization = organizations.find((o) => o.code === code)
    if (!organization) return

    const unit = async (
      unitCode: string,
      name: string,
      type: 'BRANCH' | 'DEPARTMENT' | 'TEAM',
      parentCode?: string
    ) => {
      const existing = await services.units.list(context, organization.id)
      const parent = existing.find((u) => u.code === parentCode)
      await ignoreConflict(() =>
        services.units.create(context, {
          organizationId: organization.id,
          parentId: parent?.id ?? null,
          code: unitCode,
          name,
          type,
          managerMembershipId: null,
          timezone: null,
          active: true,
        })
      )
    }
    await unit('SEDE', 'Sede', 'BRANCH')
    await unit('VENDAS', 'Vendas', 'DEPARTMENT', 'SEDE')
    await unit('EQ-1', 'Equipa 1', 'TEAM', 'VENDAS')
    await ignoreConflict(() =>
      services.scopes.add(context, {
        membershipId: membership.id,
        organizationId: organization.id,
        organizationUnitId: null,
        includeDescendants: false,
      })
    )
  }
}
