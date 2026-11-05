import { randomUUID } from 'node:crypto'
import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'
import { ApiError } from '#shared/http/api_error'
import { normalizeEmail, passwordIssues } from '#modules/identity/index'
import {
  normalizeTenant,
  runInTenant,
  TenantRepository,
  MembershipRepository,
} from '#modules/tenancy/index'
import { bootstrapTenantAdmin, syncPermissionCatalog } from '#modules/rbac/index'
import { syncFeatureCatalog } from '#modules/subscription/index'
import { audit } from '#modules/audit/index'

/** Cria um tenant, a membership activa do administrador e o perfil `tenant_admin`, tudo ou nada. */
export async function createTenantWithAdmin(input: {
  code: string
  name: string
  countryCode: string
  defaultCurrency: string
  adminEmail: string
}) {
  const { values, issues } = normalizeTenant(input, null)
  if (!values) throw ApiError.validation(issues)
  const email = normalizeEmail(input.adminEmail)
  const found = email
    ? await db
        .connection('runtime')
        .rawQuery('select id from users where lower(email) = lower(?)', [email])
    : null
  const adminId = (found?.rows[0] as { id: string } | undefined)?.id
  if (!adminId)
    throw ApiError.validation([
      { path: 'adminEmail', code: 'UNKNOWN_USER', message: 'A conta não existe.' },
    ])
  await syncPermissionCatalog()
  await syncFeatureCatalog()
  const tenant = await new TenantRepository().insert(values)
  const membershipId = randomUUID()
  const context = { tenantId: tenant.id, userId: adminId, membershipId, requestId: 'bootstrap' }
  try {
    await runInTenant(context, async (scope) => {
      await new MembershipRepository().insertActive(scope, membershipId, adminId)
      await bootstrapTenantAdmin(scope, membershipId)
      await audit(scope, {
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: tenant.id,
        metadata: { code: tenant.code, adminMembershipId: membershipId },
      })
    })
  } catch (error) {
    await db.connection('owner').rawQuery('delete from tenants where id = ?', [tenant.id])
    throw error
  }
  return tenant
}

export async function createUserWithPassword(rawEmail: string, fullName: string, password: string) {
  const email = normalizeEmail(rawEmail)
  const issues = [
    ...(email ? [] : [{ path: 'email', code: 'INVALID_EMAIL', message: 'Email inválido.' }]),
    ...passwordIssues(password),
  ]
  if (issues.length > 0) throw ApiError.validation(issues)
  const result = await db
    .connection('runtime')
    .rawQuery(
      'insert into users (email, full_name, password_hash) values (?, ?, ?) returning id, email',
      [email!, fullName.trim().slice(0, 160), await hash.make(password)]
    )
  return result.rows[0] as { id: string; email: string }
}
