/**
 * Catálogo de permissões, definido no código (fonte de verdade) e sincronizado para a tabela `permissions` com
 * `node ace rbac:sync`. Cada módulo acrescenta as suas aqui quando é implementado; nunca permissões sem rota que as use.
 */
export interface PermissionDefinition {
  code: string
  module: string
  description: string
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  {
    code: 'members.read',
    module: 'members',
    description: 'Ver os membros da empresa e os seus perfis.',
  },
  { code: 'members.invite', module: 'members', description: 'Convidar pessoas para a empresa.' },
  {
    code: 'members.manage',
    module: 'members',
    description:
      'Suspender, reactivar e atribuir ou retirar perfis a membros (nunca a si próprio).',
  },
  { code: 'roles.read', module: 'rbac', description: 'Ver perfis e permissões.' },
  {
    code: 'roles.manage',
    module: 'rbac',
    description: 'Criar, alterar e eliminar perfis (só com permissões que o próprio tem).',
  },
]

export const PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.code))

/** Perfil de sistema criado em cada tenant: tem todas as permissões de tenant e não se edita nem elimina. */
export const TENANT_ADMIN_ROLE = 'tenant_admin'

export type ScopeType = 'TENANT' | 'OWN'
export const SCOPE_TYPES: readonly ScopeType[] = ['TENANT', 'OWN']
