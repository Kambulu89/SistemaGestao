/**
 * Catálogo de permissões, definido no código (fonte de verdade) e sincronizado para a tabela `permissions` com
 * `node ace catalog:sync`. Cada módulo acrescenta as suas aqui quando é implementado; nunca permissões sem rota que as use.
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
  {
    code: 'subscription.read',
    module: 'subscription',
    description: 'Ver o plano, o estado da subscrição e as funcionalidades contratadas da empresa.',
  },
  {
    code: 'settings.read',
    module: 'settings',
    description:
      'Ver o perfil da empresa, configurações, câmbios, séries documentais e calendários.',
  },
  {
    code: 'settings.manage',
    module: 'settings',
    description:
      'Alterar o perfil da empresa, configurações, câmbios, séries documentais e calendários.',
  },
  {
    code: 'bank_accounts.read',
    module: 'settings',
    description: 'Ver as contas bancárias institucionais.',
  },
  {
    code: 'bank_accounts.manage',
    module: 'settings',
    description:
      'Registar e inactivar contas bancárias institucionais (com aprovação, se configurada).',
  },
  {
    code: 'audit.read',
    module: 'audit',
    description: 'Consultar o registo de auditoria da empresa.',
  },
  {
    code: 'approvals.read',
    module: 'approvals',
    description:
      'Ver todos os pedidos de aprovação da empresa (os próprios e os que decide vêem-se sempre).',
  },
  {
    code: 'approvals.request',
    module: 'approvals',
    description: 'Submeter pedidos de aprovação.',
  },
  {
    code: 'approvals.manage',
    module: 'approvals',
    description:
      'Gerir workflows de aprovação, cancelar qualquer pedido e ver ou revogar delegações de outros.',
  },
  {
    code: 'accounting.read',
    module: 'accounting',
    description: 'Ver planos de contas, exercícios, diários e lançamentos.',
  },
  {
    code: 'accounting.create',
    module: 'accounting',
    description: 'Criar, alterar e submeter lançamentos em rascunho.',
  },
  {
    code: 'accounting.approve',
    module: 'accounting',
    description: 'Aprovar ou rejeitar lançamentos submetidos (nunca os próprios).',
  },
  {
    code: 'accounting.post',
    module: 'accounting',
    description: 'Contabilizar lançamentos aprovados (passam a imutáveis).',
  },
  {
    code: 'accounting.reverse',
    module: 'accounting',
    description: 'Estornar lançamentos contabilizados.',
  },
  {
    code: 'accounting.close',
    module: 'accounting',
    description: 'Fechar períodos contabilísticos.',
  },
  {
    code: 'accounting.reopen',
    module: 'accounting',
    description: 'Reabrir períodos contabilísticos fechados.',
  },
  {
    code: 'accounting.settings',
    module: 'accounting',
    description: 'Gerir planos de contas, contas, exercícios e diários.',
  },
  {
    code: 'accounting.reports',
    module: 'accounting',
    description: 'Consultar razão e balancete (só lançamentos contabilizados).',
  },
  {
    code: 'accounting.analytics',
    module: 'accounting',
    description: 'Imputar linhas a centros de custo e dimensões e consultar o relatório analítico.',
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
