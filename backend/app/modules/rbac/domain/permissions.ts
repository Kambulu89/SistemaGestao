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
  {
    code: 'accounting.adjustments',
    module: 'accounting',
    description:
      'Gerir planos de regularização e provisões e gerar os seus rascunhos e as diferenças cambiais.',
  },
  {
    code: 'accounting.reconcile',
    module: 'accounting',
    description: 'Reconciliar linhas contabilizadas de uma conta e desfazer reconciliações.',
  },
  {
    code: 'accounting.statements',
    module: 'accounting',
    description: 'Redigir as notas às demonstrações financeiras.',
  },
  {
    code: 'fixed_assets.read',
    module: 'accounting',
    description: 'Consultar activos fixos, classes, mapa de depreciação e movimentos.',
  },
  {
    code: 'fixed_assets.manage',
    module: 'accounting',
    description: 'Gerir classes e fichas de activos fixos e registar transferências.',
  },
  {
    code: 'fixed_assets.post',
    module: 'accounting',
    description: 'Contabilizar aquisições, depreciações e abates de activos fixos (e anulá-los).',
  },
  {
    code: 'hr.read',
    module: 'hr',
    description: 'Ver colaboradores (dados profissionais) no âmbito atribuído.',
  },
  {
    code: 'hr.manage',
    module: 'hr',
    description:
      'Criar e alterar fichas de colaboradores, suspender e reactivar, no âmbito atribuído.',
  },
  {
    code: 'hr.sensitive',
    module: 'hr',
    description:
      'Ver e alterar dados pessoais (documentos, NIF, segurança social, morada, banco) e anexos dos colaboradores no âmbito atribuído.',
  },
  {
    code: 'hr.recruitment.read',
    module: 'hr',
    description:
      'Ver vagas, candidatos, candidaturas, entrevistas e propostas no âmbito atribuído.',
  },
  {
    code: 'hr.recruitment.manage',
    module: 'hr',
    description:
      'Criar vagas e candidatos, gerir candidaturas, entrevistas e propostas, e contratar, no âmbito atribuído.',
  },
  {
    code: 'hr.recruitment.approve',
    module: 'hr',
    description:
      'Aprovar vagas (remuneração autorizada) e propostas no âmbito atribuído, sem ser quem as preparou.',
  },
  {
    code: 'hr.contracts.read',
    module: 'hr',
    description:
      'Ver contratos de trabalho (condições, remuneração, adendas e histórico) no âmbito atribuído.',
  },
  {
    code: 'hr.contracts.manage',
    module: 'hr',
    description:
      'Criar, activar, suspender, terminar e alterar por adenda ou renovação contratos de trabalho no âmbito atribuído.',
  },
  {
    code: 'hr.leave.read',
    module: 'hr',
    description:
      'Ver pedidos de ausência e saldos de férias dos colaboradores no âmbito atribuído.',
  },
  {
    code: 'hr.leave.request',
    module: 'hr',
    description: 'Pedir férias e ausências para si próprio (self-service).',
  },
  {
    code: 'hr.leave.approve',
    module: 'hr',
    description: 'Aprovar ou recusar pedidos de ausência no âmbito atribuído (nunca os próprios).',
  },
  {
    code: 'hr.leave.manage',
    module: 'hr',
    description:
      'Registar ausências por conta dos colaboradores, gerar direitos de férias, ajustar saldos e cancelar ausências aprovadas, no âmbito atribuído.',
  },
  {
    code: 'hr.leave.settings',
    module: 'hr',
    description:
      'Configurar tipos de ausência e políticas de férias (versionadas, com fonte legal).',
  },
  {
    code: 'hr.compensation.read',
    module: 'hr',
    description:
      'Ver a remuneração dos colaboradores (componentes, histórico e propostas) no âmbito atribuído.',
  },
  {
    code: 'hr.compensation.manage',
    module: 'hr',
    description: 'Preparar e submeter propostas de compensação no âmbito atribuído.',
  },
  {
    code: 'hr.compensation.approve',
    module: 'hr',
    description:
      'Aprovar propostas de compensação no âmbito atribuído, nunca as que preparou nem a sua própria remuneração.',
  },
  {
    code: 'hr.compensation.settings',
    module: 'hr',
    description:
      'Configurar componentes de remuneração e a incidência de IRT e INSS por vigência (com fonte legal).',
  },
  {
    code: 'hr.loans.read',
    module: 'hr',
    description:
      'Ver adiantamentos e empréstimos dos colaboradores (plano de prestações e saldo) no âmbito atribuído.',
  },
  {
    code: 'hr.loans.manage',
    module: 'hr',
    description:
      'Preparar, submeter e cancelar pedidos de adiantamento ou empréstimo e registar pagamentos directos de prestações, no âmbito atribuído.',
  },
  {
    code: 'hr.loans.approve',
    module: 'hr',
    description:
      'Aprovar adiantamentos e empréstimos no âmbito atribuído, nunca os que preparou nem os seus.',
  },
  {
    code: 'hr.payroll.read',
    module: 'hr',
    description:
      'Ver processamentos salariais (lotes, recibos calculados e erros) da empresa ou das entidades legais atribuídas.',
  },
  {
    code: 'hr.payroll.manage',
    module: 'hr',
    description:
      'Preparar, calcular (simular), submeter, fechar e cancelar processamentos salariais da empresa ou das entidades legais atribuídas.',
  },
  {
    code: 'hr.payroll.approve',
    module: 'hr',
    description:
      'Aprovar processamentos salariais da empresa ou das entidades legais atribuídas, nunca os que preparou ou calculou nem um lote com o próprio recibo.',
  },
  {
    code: 'hr.payroll.pay',
    module: 'hr',
    description:
      'Registar pagamentos dos salários e das obrigações (IRT, INSS, descontos) de lotes fechados, da empresa ou das entidades legais atribuídas.',
  },
  {
    code: 'hr.payroll.settings',
    module: 'hr',
    description:
      'Configurar as regras de processamento (taxas de INSS, tabela de IRT, incidência do salário base) por vigência e com fonte.',
  },
  {
    code: 'hr.settings',
    module: 'hr',
    description:
      'Configurar os recursos humanos (workflows de aprovação e limites de adiantamentos e empréstimos, com fonte).',
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
