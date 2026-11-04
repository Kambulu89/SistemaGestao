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
  {
    code: 'organization.read',
    module: 'organization',
    description: 'Ver entidades legais, filiais, departamentos, cargos e centros de custo.',
  },
  {
    code: 'organization.manage',
    module: 'organization',
    description: 'Criar, alterar e inactivar a estrutura organizacional.',
  },
]

export const PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.code))

/** Perfil de sistema criado em cada tenant: tem todas as permissões de tenant e não se edita nem elimina. */
export const TENANT_ADMIN_ROLE = 'tenant_admin'

/**
 * Âmbito de uma atribuição: toda a empresa, só registos próprios, ou uma entidade legal / filial / departamento (este
 * inclui os subdepartamentos). As equipas entram quando existir o cadastro de equipas.
 */
export type ScopeType = 'TENANT' | 'OWN' | 'LEGAL_ENTITY' | 'BRANCH' | 'DEPARTMENT'
export const SCOPE_TYPES: readonly ScopeType[] = [
  'TENANT',
  'OWN',
  'LEGAL_ENTITY',
  'BRANCH',
  'DEPARTMENT',
]
/** Âmbitos que exigem o identificador do alvo (`scopeId`). */
export const TARGETED_SCOPES: readonly ScopeType[] = ['LEGAL_ENTITY', 'BRANCH', 'DEPARTMENT']
