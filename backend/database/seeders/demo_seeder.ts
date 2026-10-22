import { BaseSeeder } from '@adonisjs/lucid/seeders'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { ApiError } from '#core/http/api_error'
import { authServices } from '#core/auth/index'
import { organizationServices } from '#core/organization/index'
import { partyServices } from '#core/party/index'
import { settingsServices } from '#core/settings/index'
import { LucidMembershipDirectory } from '#core/membership/index'
import { serviceTenantContext } from '#core/tenancy/index'
import { billingServices } from '#platform/billing/index'
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

/** Planos de demonstração (revisão 1, publicados) e o que cada tenant demo contrata. */
const DEMO_PLANS = [
  { code: 'demo_basic', name: 'Demo Básico', price: '49.9000', members: 10 as number | null },
  { code: 'demo_pro', name: 'Demo Profissional', price: '149.9000', members: null },
] as const
const DEMO_PLAN_OF: Record<string, string> = { demo_a: 'demo_basic', demo_b: 'demo_pro' }

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
    await this.seedPlans()
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
      await billingServices().assignSubscription.execute({
        tenantId: (await store.findByCode(demo.code))!.id,
        planCode: DEMO_PLAN_OF[demo.code],
      })
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
      await this.seedParties(store, demo)
    }
  }

  /** Cria a revisão 1 de cada plano demo e publica-a, se ainda não existir (idempotente). */
  private async seedPlans() {
    const { createPlan, publishPlan, listPlans } = billingServices()
    const existing = await listPlans.execute()
    for (const plan of DEMO_PLANS) {
      if (existing.some((p) => p.planCode === plan.code)) continue
      const draft = await createPlan.execute({
        planCode: plan.code,
        name: plan.name,
        currency: 'AOA',
        price: plan.price,
        billingInterval: 'MONTH',
        limits: { members: plan.members },
      })
      await publishPlan.execute(draft.planCode, draft.revision)
    }
  }

  /** Dois cadastros de demonstração por tenant (uma pessoa e um fornecedor), só se ainda não houver nenhum. */
  private async seedParties(store: LucidTenantStore, demo: (typeof DEMO)[number]) {
    const tenant = await store.findByCode(demo.code)
    if (!tenant) return
    const context = serviceTenantContext(
      tenant.id,
      `seed-parties-${demo.code}`,
      tenant.defaultLocale
    )
    const parties = partyServices().parties
    const existing = await parties.list(context, { limit: 1, offset: 0 })
    if (existing.length > 0) return

    await parties.createPerson(context, {
      givenNames: 'Maria',
      familyName: 'Demonstração',
      birthDate: null,
      nationality: 'AO',
      identityType: null,
      identityNumber: null,
      externalReference: null,
      contacts: [
        { type: 'EMAIL', value: `maria@${demo.host}`, label: null, isPrimary: true },
        { type: 'PHONE', value: '+244 900 000 000', label: null, isPrimary: true },
      ],
    })
    await parties.createOrganization(context, {
      legalName: `Fornecedor ${demo.name}, Lda.`,
      taxCountry: 'AO',
      taxId: demo.code === 'demo_a' ? '5000000001' : '5000000002',
      registrationNumber: null,
      externalReference: null,
      addresses: [
        {
          type: 'BILLING',
          line1: 'Rua da Demonstração 1',
          line2: null,
          city: 'Luanda',
          province: 'Luanda',
          countryCode: 'AO',
          postalCode: null,
          isPrimary: true,
        },
      ],
    })
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
    await this.seedReference(context, organization.id)
  }

  /** Unidades, imposto e sequência de demonstração (C09); repetir não duplica (conflitos ignorados). */
  private async seedReference(
    context: ReturnType<typeof serviceTenantContext>,
    organizationId: string
  ) {
    const { units, taxRates, sequences } = settingsServices()
    await ignoreConflict(() =>
      units.create(context, {
        code: 'UN',
        name: 'Unidade',
        dimension: 'COUNT',
        precision: 0,
        baseUnitId: null,
        factor: null,
      })
    )
    await ignoreConflict(() =>
      units.create(context, {
        code: 'KG',
        name: 'Quilograma',
        dimension: 'MASS',
        precision: 3,
        baseUnitId: null,
        factor: null,
      })
    )
    const existing = await units.list(context)
    const kg = existing.find((u) => u.code === 'KG')
    if (kg) {
      await ignoreConflict(() =>
        units.create(context, {
          code: 'G',
          name: 'Grama',
          dimension: 'MASS',
          precision: 0,
          baseUnitId: kg.id,
          factor: '0.001',
        })
      )
    }
    await ignoreConflict(() =>
      taxRates.create(context, {
        organizationId,
        code: 'IVA',
        name: 'IVA normal (demonstração)',
        rate: '14',
        validFrom: '2026-01-01',
        validTo: null,
        category: 'VAT',
        exemptionReason: null,
      })
    )
    await ignoreConflict(() =>
      sequences.create(context, {
        organizationId,
        branchId: null,
        documentType: 'INVOICE',
        series: 'A',
        period: 'ALL',
        prefixTemplate: 'FT {SERIES}/{YYYY}/',
        nextValue: '1',
        padding: 6,
      })
    )
  }
}
