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
    label: 'Administração',
    items: [
      { label: 'Membros', path: '/membros', icon: 'users', permission: 'members.read' },
      { label: 'Perfis', path: '/perfis', icon: 'shield', permission: 'roles.read' },
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
