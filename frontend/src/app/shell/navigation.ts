/** Item de navegação: só aparece se o membro tiver a permissão e a empresa tiver a funcionalidade. */
export interface NavItem {
  label: string;
  path: string;
  icon: string;
  permission?: string;
  feature?: string;
  /** A permissão vale em qualquer âmbito (a API filtra os registos pelo âmbito do membro). */
  anyScope?: boolean;
  /** Subtítulo dentro do domínio (ex.: "Relatórios financeiros"). */
  section?: string;
}

export interface NavGroup {
  label: string;
  icon?: string;
  items: NavItem[];
  platform?: boolean;
}

/**
 * Navegação por domínios do ERP (prompt de interface): cada grupo é um domínio e as secções arrumam os ecrãs dentro
 * dele. Só entram ecrãs com backend real; os domínios ainda sem módulos (Operações Comerciais, Pessoas e Talento,
 * Operações Empresariais, Inteligência e Automação) não aparecem até existirem.
 */
export const NAVIGATION: NavGroup[] = [
  {
    label: 'Início',
    icon: 'home',
    items: [
      { label: 'Painel', path: '/painel', icon: 'home' },
      { label: 'Notificações', path: '/notificacoes', icon: 'bell' },
      { label: 'Aprovações', path: '/aprovacoes', icon: 'approvals', feature: 'approvals' },
    ],
  },
  {
    label: 'Gestão Financeira',
    icon: 'coins',
    items: [
      {
        label: 'Lançamentos',
        path: '/contabilidade/lancamentos',
        icon: 'file',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Contabilidade',
      },
      {
        label: 'Fecho',
        path: '/contabilidade/fecho',
        icon: 'check',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Contabilidade',
      },
      {
        label: 'Saldos de abertura',
        path: '/contabilidade/abertura',
        icon: 'download',
        permission: 'accounting.create',
        feature: 'accounting',
        section: 'Contabilidade',
      },
      {
        label: 'Regras de contabilização',
        path: '/contabilidade/regras',
        icon: 'flow',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Contabilidade',
      },
      {
        label: 'Eventos contabilísticos',
        path: '/contabilidade/eventos',
        icon: 'history',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Contabilidade',
      },
      {
        label: 'Balancete',
        path: '/contabilidade/balancete',
        icon: 'grid',
        permission: 'accounting.reports',
        feature: 'accounting',
        section: 'Relatórios financeiros',
      },
      {
        label: 'Razão',
        path: '/contabilidade/razao',
        icon: 'file',
        permission: 'accounting.reports',
        feature: 'accounting',
        section: 'Relatórios financeiros',
      },
      {
        label: 'Demonstrações financeiras',
        path: '/contabilidade/demonstracoes',
        icon: 'file',
        permission: 'accounting.reports',
        feature: 'accounting',
        section: 'Relatórios financeiros',
      },
      {
        label: 'Analítica',
        path: '/contabilidade/analitica',
        icon: 'grid',
        permission: 'accounting.analytics',
        feature: 'accounting',
        section: 'Relatórios financeiros',
      },
      {
        label: 'Activos fixos',
        path: '/contabilidade/activos',
        icon: 'building',
        permission: 'fixed_assets.read',
        feature: 'accounting',
        section: 'Activos e regularizações',
      },
      {
        label: 'Depreciações',
        path: '/contabilidade/depreciacoes',
        icon: 'coins',
        permission: 'fixed_assets.read',
        feature: 'accounting',
        section: 'Activos e regularizações',
      },
      {
        label: 'Regularizações',
        path: '/contabilidade/regularizacoes',
        icon: 'history',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Activos e regularizações',
      },
      {
        label: 'Provisões',
        path: '/contabilidade/provisoes',
        icon: 'shield',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Activos e regularizações',
      },
      {
        label: 'Diferenças cambiais',
        path: '/contabilidade/diferencas-cambiais',
        icon: 'globe',
        permission: 'accounting.adjustments',
        feature: 'accounting',
        section: 'Activos e regularizações',
      },
      {
        label: 'Reconciliação de contas',
        path: '/contabilidade/reconciliacao',
        icon: 'check',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Activos e regularizações',
      },
      {
        label: 'Planos de contas',
        path: '/contabilidade/planos',
        icon: 'tree',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Configuração financeira',
      },
      {
        label: 'Exercícios',
        path: '/contabilidade/exercicios',
        icon: 'calendar',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Configuração financeira',
      },
      {
        label: 'Diários',
        path: '/contabilidade/diarios',
        icon: 'layers',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Configuração financeira',
      },
      {
        label: 'Dimensões analíticas',
        path: '/contabilidade/dimensoes',
        icon: 'layers',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Configuração financeira',
      },
      {
        label: 'Chaves de repartição',
        path: '/contabilidade/chaves',
        icon: 'tree',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Configuração financeira',
      },
      {
        label: 'Modelos de demonstrações',
        path: '/contabilidade/modelos-demonstracoes',
        icon: 'template',
        permission: 'accounting.read',
        feature: 'accounting',
        section: 'Configuração financeira',
      },
      {
        label: 'Classes de activos',
        path: '/contabilidade/classes-activos',
        icon: 'layers',
        permission: 'fixed_assets.read',
        feature: 'accounting',
        section: 'Configuração financeira',
      },
      {
        label: 'Câmbios',
        path: '/empresa/exchange-rates',
        icon: 'coins',
        permission: 'settings.read',
        section: 'Configuração financeira',
      },
      {
        label: 'Contas bancárias',
        path: '/empresa/bank-accounts',
        icon: 'card',
        permission: 'bank_accounts.read',
        section: 'Configuração financeira',
      },
    ],
  },
  {
    label: 'Pessoas e Talento',
    icon: 'users',
    items: [
      {
        label: 'Colaboradores',
        path: '/rh/colaboradores',
        icon: 'users',
        permission: 'hr.read',
        feature: 'hr',
        anyScope: true,
        section: 'Pessoas',
      },
      {
        label: 'Férias e ausências',
        path: '/rh/ausencias',
        icon: 'calendar',
        feature: 'hr',
        section: 'Pessoas',
      },
      {
        label: 'Compensação',
        path: '/rh/compensacao',
        icon: 'coins',
        permission: 'hr.compensation.read',
        feature: 'hr',
        anyScope: true,
        section: 'Pessoas',
      },
      {
        label: 'Vagas',
        path: '/rh/vagas',
        icon: 'badge',
        permission: 'hr.recruitment.read',
        feature: 'hr',
        anyScope: true,
        section: 'Recrutamento',
      },
      {
        label: 'Candidatos',
        path: '/rh/candidatos',
        icon: 'user',
        permission: 'hr.recruitment.read',
        feature: 'hr',
        anyScope: true,
        section: 'Recrutamento',
      },
      {
        label: 'As minhas entrevistas',
        path: '/rh/entrevistas',
        icon: 'calendar',
        feature: 'hr',
        section: 'Recrutamento',
      },
      {
        label: 'Férias e ausências',
        path: '/rh/ausencias/configuracao',
        icon: 'settings',
        permission: 'hr.leave.settings',
        feature: 'hr',
        section: 'Configuração',
      },
      {
        label: 'Componentes de remuneração',
        path: '/rh/compensacao/componentes',
        icon: 'coins',
        permission: 'hr.compensation.settings',
        feature: 'hr',
        section: 'Configuração',
      },
      {
        label: 'Configuração de RH',
        path: '/rh/configuracao',
        icon: 'settings',
        permission: 'hr.settings',
        feature: 'hr',
        section: 'Configuração',
      },
    ],
  },
  {
    label: 'Administração e Plataforma',
    icon: 'settings',
    items: [
      {
        label: 'Entidades legais',
        path: '/organizacao/legal-entities',
        icon: 'building',
        permission: 'organization.read',
        feature: 'organization',
        section: 'Organização',
      },
      {
        label: 'Filiais',
        path: '/organizacao/branches',
        icon: 'branch',
        permission: 'organization.read',
        feature: 'organization',
        section: 'Organização',
      },
      {
        label: 'Departamentos',
        path: '/organizacao/departments',
        icon: 'tree',
        permission: 'organization.read',
        feature: 'organization',
        section: 'Organização',
      },
      {
        label: 'Cargos',
        path: '/organizacao/positions',
        icon: 'badge',
        permission: 'organization.read',
        feature: 'organization',
        section: 'Organização',
      },
      {
        label: 'Centros de custo',
        path: '/organizacao/cost-centers',
        icon: 'coins',
        permission: 'organization.read',
        feature: 'organization',
        section: 'Organização',
      },
      {
        label: 'Perfil da empresa',
        path: '/empresa/perfil',
        icon: 'building',
        permission: 'settings.read',
        section: 'Empresa',
      },
      {
        label: 'Configurações',
        path: '/empresa/configuracoes',
        icon: 'settings',
        permission: 'settings.read',
        section: 'Empresa',
      },
      {
        label: 'Séries documentais',
        path: '/empresa/document-series',
        icon: 'layers',
        permission: 'settings.read',
        section: 'Empresa',
      },
      {
        label: 'Calendários',
        path: '/empresa/calendars',
        icon: 'calendar',
        permission: 'settings.read',
        section: 'Empresa',
      },
      {
        label: 'Membros',
        path: '/membros',
        icon: 'users',
        permission: 'members.read',
        section: 'Acessos e subscrição',
      },
      {
        label: 'Perfis',
        path: '/perfis',
        icon: 'shield',
        permission: 'roles.read',
        section: 'Acessos e subscrição',
      },
      {
        label: 'Matriz de permissões',
        path: '/perfis/matriz',
        icon: 'grid',
        permission: 'roles.read',
        section: 'Acessos e subscrição',
      },
      {
        label: 'Workflows de aprovação',
        path: '/aprovacoes/workflows',
        icon: 'flow',
        permission: 'approvals.manage',
        feature: 'approvals',
        section: 'Acessos e subscrição',
      },
      {
        label: 'Subscrição',
        path: '/subscricao',
        icon: 'card',
        permission: 'subscription.read',
        section: 'Acessos e subscrição',
      },
    ],
  },
  {
    label: 'Integrações e Compliance',
    icon: 'shield',
    items: [
      {
        label: 'Auditoria',
        path: '/auditoria',
        icon: 'history',
        permission: 'audit.read',
        section: 'Compliance',
      },
    ],
  },
];

export const PLATFORM_NAVIGATION: NavGroup = {
  label: 'Plataforma',
  icon: 'globe',
  platform: true,
  items: [
    { label: 'Empresas', path: '/plataforma/empresas', icon: 'globe' },
    { label: 'Planos', path: '/plataforma/planos', icon: 'layers' },
  ],
};

/** Grupos visíveis para as permissões e funcionalidades dadas (grupos vazios desaparecem). */
export function visibleNavigation(
  can: (permission: string, anyScope?: boolean) => boolean,
  has: (feature: string) => boolean,
  withTenant: boolean,
  platformAdmin: boolean,
): NavGroup[] {
  const groups = withTenant
    ? NAVIGATION.map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => (!i.permission || can(i.permission, i.anyScope)) && (!i.feature || has(i.feature)),
        ),
      })).filter((g) => g.items.length > 0)
    : [];
  return platformAdmin ? [...groups, PLATFORM_NAVIGATION] : groups;
}

/** Todos os ecrãs visíveis, numa lista (paleta de comandos), com o domínio como contexto. */
export function flatNavigation(groups: NavGroup[]): (NavItem & { group: string })[] {
  return groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
}

/** Secções de um grupo, pela ordem em que aparecem (itens sem secção ficam numa secção sem título). */
export function sectionsOf(group: NavGroup): { title: string | null; items: NavItem[] }[] {
  const out: { title: string | null; items: NavItem[] }[] = [];
  for (const item of group.items) {
    const title = item.section ?? null;
    const last = out[out.length - 1];
    if (last && last.title === title) last.items.push(item);
    else out.push({ title, items: [item] });
  }
  return out;
}
