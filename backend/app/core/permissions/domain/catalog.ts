/**
 * Catálogo de permissões do núcleo (D-014: `<recurso>.<acção>`, igual à especificação). Cada módulo
 * acrescenta as suas quando existir; o catálogo é semeado a partir daqui (idempotente).
 * Papéis de plataforma (`platform.*`) **não** pertencem a este catálogo: nunca são papéis de tenant.
 */
export interface PermissionDefinition {
  code: string
  moduleCode: string
  description: string
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  {
    code: 'iam.read',
    moduleCode: 'iam',
    description: 'Ver papéis, permissões, atribuições e políticas.',
  },
  {
    code: 'iam.manage',
    moduleCode: 'iam',
    description: 'Gerir papéis, atribuições, políticas e simular acessos.',
  },
  { code: 'member.read', moduleCode: 'member', description: 'Ver os membros do tenant.' },
  { code: 'member.invite', moduleCode: 'member', description: 'Convidar membros.' },
  {
    code: 'member.manage',
    moduleCode: 'member',
    description: 'Gerir membros (suspender, terminar).',
  },
  {
    code: 'organization.read',
    moduleCode: 'organization',
    description: 'Ver organizações e unidades.',
  },
  {
    code: 'organization.manage',
    moduleCode: 'organization',
    description: 'Gerir organizações e unidades.',
  },
]

const CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

export const isValidPermissionCode = (code: string): boolean => CODE.test(code)

export function splitPermission(code: string): { resource: string; action: string } {
  const [resource, action] = code.split('.')
  return { resource, action }
}

/** Código do papel de sistema que concentra todas as permissões do catálogo (por tenant). */
export const TENANT_ADMIN_ROLE = 'tenant_admin'
