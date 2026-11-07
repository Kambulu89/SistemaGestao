/** Item de navegação: só aparece se o membro tiver a permissão e a empresa tiver a funcionalidade. */
export interface NavItem {
  label: string;
  path: string;
  icon: string;
  permission?: string;
  feature?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  platform?: boolean;
}

export const NAVIGATION: NavGroup[] = [
  {
    label: 'Geral',
    items: [
      { label: 'Painel', path: '/painel', icon: 'home' },
      { label: 'Notificações', path: '/notificacoes', icon: 'bell' },
      { label: 'Aprovações', path: '/aprovacoes', icon: 'approvals', feature: 'approvals' },
    ],
  },
  {
    label: 'Organização',
    items: [
      {
        label: 'Entidades legais',
        path: '/organizacao/legal-entities',
        icon: 'building',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Filiais',
        path: '/organizacao/branches',
        icon: 'branch',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Departamentos',
        path: '/organizacao/departments',
        icon: 'tree',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Cargos',
        path: '/organizacao/positions',
        icon: 'badge',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Centros de custo',
        path: '/organizacao/cost-centers',
        icon: 'coins',
        permission: 'organization.read',
        feature: 'organization',
      },
    ],
  },
  {
    label: 'Contabilidade',
    items: [
      {
        label: 'Lançamentos',
        path: '/contabilidade/lancamentos',
        icon: 'file',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Balancete',
        path: '/contabilidade/balancete',
        icon: 'grid',
        permission: 'accounting.reports',
        feature: 'accounting',
      },
      {
        label: 'Razão',
        path: '/contabilidade/razao',
        icon: 'file',
        permission: 'accounting.reports',
        feature: 'accounting',
      },
      {
        label: 'Analítica',
        path: '/contabilidade/analitica',
        icon: 'grid',
        permission: 'accounting.analytics',
        feature: 'accounting',
      },
      {
        label: 'Dimensões analíticas',
        path: '/contabilidade/dimensoes',
        icon: 'layers',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Chaves de repartição',
        path: '/contabilidade/chaves',
        icon: 'tree',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Regularizações',
        path: '/contabilidade/regularizacoes',
        icon: 'history',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Provisões',
        path: '/contabilidade/provisoes',
        icon: 'shield',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Diferenças cambiais',
        path: '/contabilidade/diferencas-cambiais',
        icon: 'globe',
        permission: 'accounting.adjustments',
        feature: 'accounting',
      },
      {
        label: 'Reconciliação de contas',
        path: '/contabilidade/reconciliacao',
        icon: 'check',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Activos fixos',
        path: '/contabilidade/activos',
        icon: 'building',
        permission: 'fixed_assets.read',
        feature: 'accounting',
      },
      {
        label: 'Depreciações',
        path: '/contabilidade/depreciacoes',
        icon: 'coins',
        permission: 'fixed_assets.read',
        feature: 'accounting',
      },
      {
        label: 'Classes de activos',
        path: '/contabilidade/classes-activos',
        icon: 'layers',
        permission: 'fixed_assets.read',
        feature: 'accounting',
      },
      {
        label: 'Saldos de abertura',
        path: '/contabilidade/abertura',
        icon: 'download',
        permission: 'accounting.create',
        feature: 'accounting',
      },
      {
        label: 'Planos de contas',
        path: '/contabilidade/planos',
        icon: 'tree',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Exercícios',
        path: '/contabilidade/exercicios',
        icon: 'calendar',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Regras de contabilização',
        path: '/contabilidade/regras',
        icon: 'flow',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Eventos contabilísticos',
        path: '/contabilidade/eventos',
        icon: 'history',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        label: 'Diários',
        path: '/contabilidade/diarios',
        icon: 'layers',
        permission: 'accounting.read',
        feature: 'accounting',
      },
    ],
  },
  {
    label: 'Empresa',
    items: [
      {
        label: 'Perfil da empresa',
        path: '/empresa/perfil',
        icon: 'building',
        permission: 'settings.read',
      },
      {
        label: 'Configurações',
        path: '/empresa/configuracoes',
        icon: 'settings',
        permission: 'settings.read',
      },
      {
        label: 'Câmbios',
        path: '/empresa/exchange-rates',
        icon: 'coins',
        permission: 'settings.read',
      },
      {
        label: 'Séries documentais',
        path: '/empresa/document-series',
        icon: 'layers',
        permission: 'settings.read',
      },
      {
        label: 'Calendários',
        path: '/empresa/calendars',
        icon: 'calendar',
        permission: 'settings.read',
      },
      {
        label: 'Contas bancárias',
        path: '/empresa/bank-accounts',
        icon: 'card',
        permission: 'bank_accounts.read',
      },
    ],
  },
  {
    label: 'Administração',
    items: [
      { label: 'Membros', path: '/membros', icon: 'users', permission: 'members.read' },
      { label: 'Perfis', path: '/perfis', icon: 'shield', permission: 'roles.read' },
      {
        label: 'Matriz de permissões',
        path: '/perfis/matriz',
        icon: 'grid',
        permission: 'roles.read',
      },
      {
        label: 'Workflows de aprovação',
        path: '/aprovacoes/workflows',
        icon: 'flow',
        permission: 'approvals.manage',
        feature: 'approvals',
      },
      { label: 'Subscrição', path: '/subscricao', icon: 'card', permission: 'subscription.read' },
      { label: 'Auditoria', path: '/auditoria', icon: 'history', permission: 'audit.read' },
    ],
  },
];

export const PLATFORM_NAVIGATION: NavGroup = {
  label: 'Plataforma',
  platform: true,
  items: [
    { label: 'Empresas', path: '/plataforma/empresas', icon: 'globe' },
    { label: 'Planos', path: '/plataforma/planos', icon: 'layers' },
  ],
};

/** Grupos visíveis para as permissões e funcionalidades dadas (grupos vazios desaparecem). */
export function visibleNavigation(
  can: (permission: string) => boolean,
  has: (feature: string) => boolean,
  withTenant: boolean,
  platformAdmin: boolean,
): NavGroup[] {
  const groups = withTenant
    ? NAVIGATION.map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => (!i.permission || can(i.permission)) && (!i.feature || has(i.feature)),
        ),
      })).filter((g) => g.items.length > 0)
    : [];
  return platformAdmin ? [...groups, PLATFORM_NAVIGATION] : groups;
}
