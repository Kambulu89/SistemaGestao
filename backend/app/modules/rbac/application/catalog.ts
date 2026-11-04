import db from '@adonisjs/lucid/services/db'
import type { TenantScope } from '#modules/tenancy/index'
import { PERMISSIONS, TENANT_ADMIN_ROLE } from '#modules/rbac/domain/permissions'
import { RbacRepository } from '#modules/rbac/infrastructure/rbac_repository'

const repository = new RbacRepository()

/**
 * Sincroniza o catálogo do código para a tabela `permissions` e dá todas as permissões aos perfis `tenant_admin` de todas
 * as empresas. Comando de manutenção (`node ace rbac:sync`): usa a conta dona, que não está sujeita à RLS.
 */
export async function syncPermissionCatalog() {
  const owner = db.connection('owner')
  await owner.transaction(async (trx) => {
    for (const p of PERMISSIONS) {
      await trx.rawQuery(
        `insert into permissions (code, module, description) values (?, ?, ?)
         on conflict (code) do update set module = excluded.module, description = excluded.description, updated_at = now()`,
        [p.code, p.module, p.description]
      )
    }
    await trx.rawQuery(`delete from permissions where code <> all(?::text[])`, [
      PERMISSIONS.map((p) => p.code),
    ])
    await trx.rawQuery(
      `insert into role_permissions (tenant_id, role_id, permission_code)
       select r.tenant_id, r.id, p.code from roles r cross join permissions p
        where r.code = ? and r.is_system
       on conflict (tenant_id, role_id, permission_code) do nothing`,
      [TENANT_ADMIN_ROLE]
    )
  })
}

/** Cria (se não existir) o perfil de sistema `tenant_admin` na empresa em contexto e atribui-o à membership indicada. */
export async function bootstrapTenantAdmin(scope: TenantScope, membershipId: string) {
  const existing = await repository.findRoleByCode(scope, TENANT_ADMIN_ROLE)
  const role =
    existing ??
    (await repository.insertRole(
      scope,
      {
        code: TENANT_ADMIN_ROLE,
        name: 'Administrador da empresa',
        description: 'Perfil de sistema com todas as permissões da empresa.',
        status: 'ACTIVE',
        permissionCodes: PERMISSIONS.map((p) => p.code),
      },
      true
    ))
  await repository.assign(scope, membershipId, role.id, 'TENANT')
}
