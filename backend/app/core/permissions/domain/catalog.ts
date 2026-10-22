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
  { code: 'party.read', moduleCode: 'party', description: 'Ver pessoas e organizações externas.' },
  {
    code: 'party.create',
    moduleCode: 'party',
    description: 'Criar pessoas e organizações externas.',
  },
  {
    code: 'party.update',
    moduleCode: 'party',
    description: 'Alterar pessoas, contactos, moradas e relações.',
  },
  {
    code: 'module.read',
    moduleCode: 'modules',
    description: 'Ver o catálogo de módulos e funcionalidades do tenant.',
  },
  {
    code: 'module.manage',
    moduleCode: 'modules',
    description: 'Activar e desactivar módulos e funcionalidades do tenant.',
  },
  {
    code: 'subscription.read',
    moduleCode: 'billing',
    description: 'Ver o plano contratado, o consumo e os limites do tenant.',
  },
  {
    code: 'audit.read',
    moduleCode: 'audit',
    description: 'Ver o histórico de auditoria e os eventos de segurança.',
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
