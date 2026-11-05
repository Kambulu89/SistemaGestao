import { randomBytes, randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { createTenantWithAdmin, createUserWithPassword } from '#modules/members/index'
import { MembershipRepository, runInTenant, userTenantLinks } from '#modules/tenancy/index'
import { AssignmentService, RoleService, syncPermissionCatalog } from '#modules/rbac/index'
import {
  FEATURES,
  PlatformSubscriptionService,
  syncFeatureCatalog,
} from '#modules/subscription/index'
import { OrganizationService } from '#modules/organization/index'
import { WorkflowService } from '#modules/approvals/index'

/**
 * Dados de **demonstração** para desenvolvimento local: uma empresa fictícia (`DEMO`), três contas `@demo.invalid`, um
 * plano `DEMO`, estrutura organizacional mínima, dois perfis e um workflow. Nunca corre em produção, não altera nada se a
 * empresa `DEMO` já existir e não toca em dados reais. A palavra-passe vem de `DEMO_PASSWORD` ou é gerada e mostrada uma
 * vez.
 */
export interface DemoSummary {
  created: boolean
  tenantCode: string
  users: string[]
  generatedPassword: string | null
}

export const DEMO_TENANT = 'DEMO'
export const DEMO_USERS = {
  admin: { email: 'admin@demo.invalid', name: 'Administração (demo)' },
  approver: { email: 'aprovacao@demo.invalid', name: 'Aprovação (demo)' },
  employee: { email: 'colaborador@demo.invalid', name: 'Colaborador (demo)' },
}

const runtime = () => db.connection('runtime')

async function userId(email: string, name: string, password: string) {
  const found = await runtime().rawQuery('select id from users where lower(email) = lower(?)', [
    email,
  ])
  if (found.rows[0]) return (found.rows[0] as { id: string }).id
  return (await createUserWithPassword(email, name, password)).id
}

export async function seedDemo(): Promise<DemoSummary> {
  if (app.inProduction) throw new Error('Os dados de demonstração não correm em produção.')
  const users = Object.values(DEMO_USERS).map((u) => u.email)
  const existing = await runtime().rawQuery('select id from tenants where code = ?', [DEMO_TENANT])
  if (existing.rows.length > 0)
    return { created: false, tenantCode: DEMO_TENANT, users, generatedPassword: null }

  const given = process.env.DEMO_PASSWORD
  const generatedPassword = given ? null : randomBytes(12).toString('base64url')
  const password = given ?? generatedPassword!
  if (password.length < 12) throw new Error('DEMO_PASSWORD tem de ter pelo menos 12 caracteres.')

  await syncPermissionCatalog()
  await syncFeatureCatalog()
  const adminId = await userId(DEMO_USERS.admin.email, DEMO_USERS.admin.name, password)
  const approverId = await userId(DEMO_USERS.approver.email, DEMO_USERS.approver.name, password)
  const employeeId = await userId(DEMO_USERS.employee.email, DEMO_USERS.employee.name, password)

  const plans = new PlatformSubscriptionService()
  const plan =
    (await plans.listPlans()).find((p) => p.code === 'DEMO') ??
    (await plans.createPlan({
      code: 'DEMO',
      name: 'Plano de demonstração',
      description: 'Só para desenvolvimento local.',
      features: FEATURES.map((f) => ({
        featureCode: f.code,
        limitValue:
          f.code === 'members.max'
            ? 25
            : f.code === 'legal_entities.max'
              ? 5
              : f.code === 'attachments.storage_mb'
                ? 100
                : null,
      })),
    }))
  if (plan.status === 'DRAFT') await plans.setPlanStatus(plan.id, 'ACTIVE')

  const tenant = await createTenantWithAdmin({
    code: DEMO_TENANT,
    name: 'Empresa de Demonstração, Lda.',
    countryCode: 'AO',
    defaultCurrency: 'AOA',
    adminEmail: DEMO_USERS.admin.email,
  })
  await plans.start(
    tenant.id,
    { planId: plan.id, trial: false, reason: 'Dados de demonstração' },
    null
  )

  const membershipId = (await userTenantLinks(adminId)).find(
    (l) => l.tenantId === tenant.id
  )!.membershipId
  const context = { tenantId: tenant.id, userId: adminId, membershipId, requestId: 'demo-seed' }

  const org = new OrganizationService()
  const le = await org.create(context, 'legalEntities', {
    code: 'DEMO-SA',
    legalName: 'Demonstração Comercial, S.A.',
    tradeName: 'Demo',
    taxId: '0000000000',
    countryCode: 'AO',
    functionalCurrency: 'AOA',
  })
  const hq = await org.create(context, 'branches', {
    code: 'SEDE',
    name: 'Sede (demo)',
    legalEntityId: le.id,
    type: 'HEADQUARTERS',
  })
  await org.create(context, 'branches', {
    code: 'LOJA1',
    name: 'Loja 1 (demo)',
    legalEntityId: le.id,
    type: 'STORE',
  })
  const finance = await org.create(context, 'departments', {
    code: 'FIN',
    name: 'Finanças (demo)',
    legalEntityId: le.id,
    branchId: hq.id,
  })
  await org.create(context, 'departments', {
    code: 'FIN-TES',
    name: 'Tesouraria (demo)',
    legalEntityId: le.id,
    branchId: hq.id,
    parentId: finance.id,
  })
  await org.create(context, 'positions', {
    code: 'ANL',
    name: 'Analista (demo)',
    departmentId: finance.id,
    level: 3,
  })
  await org.create(context, 'costCenters', {
    code: 'CC-FIN',
    name: 'Finanças (demo)',
    legalEntityId: le.id,
    departmentId: finance.id,
  })

  const roles = new RoleService()
  const approverRole = await roles.create(context, {
    code: 'aprovador',
    name: 'Aprovador',
    description: 'Aprova despesas (demo).',
    permissionCodes: ['members.read', 'approvals.read', 'organization.read'],
  })
  const employeeRole = await roles.create(context, {
    code: 'colaborador',
    name: 'Colaborador',
    description: 'Submete pedidos (demo).',
    permissionCodes: ['approvals.request', 'organization.read'],
  })

  const memberships = new MembershipRepository()
  const assignments = new AssignmentService()
  await runInTenant(context, async (scope) => {
    for (const [uid, roleId] of [
      [approverId, approverRole.id],
      [employeeId, employeeRole.id],
    ]) {
      const id = randomUUID()
      await memberships.insertActive(scope, id, uid)
      await assignments.assign(scope, id, roleId, 'TENANT')
    }
  })

  const workflows = new WorkflowService()
  const wf = await workflows.create(context, {
    code: 'DESPESAS',
    name: 'Aprovação de despesas (demo)',
    subjectType: 'manual',
    steps: [
      {
        name: 'Aprovador',
        approverType: 'ROLE',
        approverRoleId: approverRole.id,
        requiredApprovals: 1,
      },
    ],
  })
  await workflows.setStatus(context, wf.id, wf.version, 'ACTIVE')

  return { created: true, tenantCode: DEMO_TENANT, users, generatedPassword }
}
