/** Item de navegação: só aparece se o membro tiver a permissão e a empresa tiver a funcionalidade. */
export interface NavItem {
  label: string;
  path: string;
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
      { label: 'Painel', path: '/painel' },
      { label: 'Notificações', path: '/notificacoes' },
      { label: 'Aprovações', path: '/aprovacoes', feature: 'approvals' },
    ],
  },
  {
    label: 'Organização',
    items: [
      {
        label: 'Entidades legais',
        path: '/organizacao/legal-entities',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Filiais',
        path: '/organizacao/branches',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Departamentos',
        path: '/organizacao/departments',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Cargos',
        path: '/organizacao/positions',
        permission: 'organization.read',
        feature: 'organization',
      },
      {
        label: 'Centros de custo',
        path: '/organizacao/cost-centers',
        permission: 'organization.read',
        feature: 'organization',
      },
    ],
  },
  {
    label: 'Administração',
    items: [
      { label: 'Membros', path: '/membros', permission: 'members.read' },
      { label: 'Perfis', path: '/perfis', permission: 'roles.read' },
      {
        label: 'Workflows de aprovação',
        path: '/aprovacoes/workflows',
        permission: 'approvals.manage',
        feature: 'approvals',
      },
      { label: 'Subscrição', path: '/subscricao', permission: 'subscription.read' },
      { label: 'Auditoria', path: '/auditoria', permission: 'audit.read' },
    ],
  },
];

export const PLATFORM_NAVIGATION: NavGroup = {
  label: 'Plataforma',
  platform: true,
  items: [
    { label: 'Empresas', path: '/plataforma/empresas' },
    { label: 'Planos', path: '/plataforma/planos' },
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
