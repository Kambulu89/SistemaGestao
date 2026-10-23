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
    code: 'settings.read',
    moduleCode: 'settings',
    description: 'Ver configurações, impostos, unidades de medida e sequências.',
  },
  {
    code: 'settings.manage',
    moduleCode: 'settings',
    description: 'Alterar configurações, impostos e unidades de medida.',
  },
  {
    code: 'sequence.manage',
    moduleCode: 'settings',
    description: 'Criar e alterar sequências de numeração.',
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
    code: 'entity.read',
    moduleCode: 'dynamic',
    description: 'Ver as definições de entidades dinâmicas, os seus campos e versões.',
  },
  {
    code: 'entity.design',
    moduleCode: 'dynamic',
    description: 'Criar e editar rascunhos de entidades dinâmicas e dos seus campos.',
  },
  {
    code: 'entity.publish',
    moduleCode: 'dynamic',
    description: 'Publicar versões de entidades dinâmicas e arquivar entidades.',
  },
  {
    code: 'dynamic.read',
    moduleCode: 'dynamic',
    description: 'Ver registos de entidades dinâmicas (restringível por entidade com políticas).',
  },
  {
    code: 'dynamic.create',
    moduleCode: 'dynamic',
    description: 'Criar registos de entidades dinâmicas.',
  },
  {
    code: 'dynamic.update',
    moduleCode: 'dynamic',
    description: 'Alterar registos de entidades dinâmicas.',
  },
  {
    code: 'dynamic.archive',
    moduleCode: 'dynamic',
    description: 'Arquivar registos de entidades dinâmicas.',
  },
  {
    code: 'dynamic.sensitive',
    moduleCode: 'dynamic',
    description: 'Ver e escrever campos marcados como sensíveis nas entidades dinâmicas.',
  },
  {
    code: 'dynamic.all',
    moduleCode: 'dynamic',
    description: 'Aceder aos registos de todos os responsáveis em entidades de modo OWNER.',
  },
  {
    code: 'rule.read',
    moduleCode: 'dynamic',
    description: 'Ver regras de validação, as suas revisões e avaliações.',
  },
  {
    code: 'rule.manage',
    moduleCode: 'dynamic',
    description: 'Criar, simular, publicar e desactivar regras de validação.',
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
