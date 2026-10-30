import { inject } from '@angular/core';
import type { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { DynamicEntityRegistryService } from '../../core/dynamic/entity-registry.service';
import { requireEntityOperation } from '../../core/guards/entity.guard';
import { requirePermission } from '../../core/guards/permission.guard';
import { TENANT_PERMISSIONS } from '../../core/permissions/permission.model';
import { toRoute } from '../../module-routes';
import { DYNAMIC_CORE_ROUTES } from '../dynamic-core/dynamic-core.routes';

/**
 * Páginas de administração do tenant. As rotas dos módulos de negócio não estão aqui:
 * são geradas a partir dos manifestos (ver `module-routes.ts`).
 */
export const TENANT_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Painel',
    loadComponent: () => import('./dashboard/tenant-dashboard').then((m) => m.TenantDashboard),
  },
  {
    path: 'modules',
    pathMatch: 'full',
    title: 'Módulos',
    data: { breadcrumb: 'Módulos' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.modulesRead)],
    loadComponent: () => import('./modules/tenant-modules-page').then((m) => m.TenantModulesPage),
  },
  {
    path: 'plan',
    pathMatch: 'full',
    title: 'Plano',
    data: { breadcrumb: 'Plano' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.planRead)],
    loadComponent: () => import('./plan/tenant-plan-page').then((m) => m.TenantPlanPage),
  },
  {
    path: 'organization',
    pathMatch: 'full',
    title: 'Organização',
    data: { breadcrumb: 'Organização' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.organizationRead)],
    loadComponent: () => import('./organization/organization').then((m) => m.TenantOrganization),
  },
  // A minha conta: global ao utilizador, sem permissão de tenant (o servidor só devolve dados da própria conta).
  {
    path: 'profile',
    pathMatch: 'full',
    title: 'A minha conta',
    data: { breadcrumb: 'A minha conta' },
    loadComponent: () => import('./profile/profile-page').then((m) => m.ProfilePage),
  },
  {
    path: 'parties',
    pathMatch: 'full',
    title: 'Pessoas e entidades',
    data: { breadcrumb: 'Pessoas e entidades' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.partiesRead)],
    loadComponent: () => import('./party/parties-page').then((m) => m.PartiesPage),
  },
  {
    path: 'users',
    pathMatch: 'full',
    title: 'Utilizadores',
    data: { breadcrumb: 'Utilizadores' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.usersRead)],
    loadComponent: () => import('./users/users').then((m) => m.TenantUsers),
  },
  {
    path: 'permissions',
    pathMatch: 'full',
    title: 'Permissões',
    data: { breadcrumb: 'Permissões' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.accessRead)],
    loadComponent: () =>
      import('./permissions/tenant-permissions-page').then((m) => m.TenantPermissionsPage),
  },
  {
    path: 'settings',
    pathMatch: 'full',
    title: 'Configurações',
    data: { breadcrumb: 'Configurações' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.settingsRead)],
    loadComponent: () => import('./settings/settings').then((m) => m.TenantSettings),
  },
  // Caixa de aprovações (C14): tarefas por decidir, já tratadas e delegações.
  {
    path: 'approvals',
    pathMatch: 'full',
    title: 'Aprovações',
    data: { breadcrumb: 'Aprovações' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.approvalsDecide)],
    loadComponent: () =>
      import('../dynamic-core/workflows/approvals-page').then((m) => m.ApprovalsPage),
  },
  // Automações (C15): definição, simulação, activação e histórico de execuções.
  {
    path: 'automations',
    pathMatch: 'full',
    title: 'Automações',
    data: { breadcrumb: 'Automações' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.automationsRead)],
    loadComponent: () =>
      import('../dynamic-core/automations/automations-page').then((m) => m.AutomationsPage),
  },
  // Pesquisa global (S04): resultados revalidados no servidor com o acesso de quem pesquisa.
  {
    path: 'search',
    pathMatch: 'full',
    title: 'Pesquisa',
    data: { breadcrumb: 'Pesquisa' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.searchRead)],
    loadComponent: () => import('../dynamic/reporting/search-page').then((m) => m.SearchPage),
  },
  // Centro de notificações (S02): caixa pessoal, preferências e, para quem gere, entregas.
  {
    path: 'notifications',
    pathMatch: 'full',
    title: 'Notificações',
    data: { breadcrumb: 'Notificações' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.notificationsRead)],
    loadComponent: () =>
      import('./notifications/notifications-page').then((m) => m.NotificationsPage),
  },
  // Core Dinâmico (C10): definição de entidades e campos. Cada página tem a sua permissão.
  {
    path: 'entities',
    data: { breadcrumb: 'Entidades' },
    children: DYNAMIC_CORE_ROUTES.map(toRoute),
  },
  // Registos de entidades dinâmicas: as mesmas páginas servem qualquer entidade.
  {
    path: 'data/:entityKey',
    canActivate: [requireEntityOperation('read')],
    data: { breadcrumb: entityPluralName },
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Registos',
        loadComponent: () =>
          import('../dynamic-core/dynamic-records/records-list-page').then(
            (m) => m.RecordsListPage,
          ),
      },
      {
        path: 'new',
        title: 'Criar registo',
        data: { breadcrumb: 'Criar' },
        canActivate: [requireEntityOperation('create')],
        loadComponent: () =>
          import('../dynamic-core/dynamic-records/record-form-page').then((m) => m.RecordFormPage),
      },
      {
        path: ':id',
        pathMatch: 'full',
        title: 'Registo',
        data: { breadcrumb: 'Detalhe' },
        loadComponent: () =>
          import('../dynamic-core/dynamic-records/record-detail-page').then(
            (m) => m.RecordDetailPage,
          ),
      },
      {
        path: ':id/edit',
        title: 'Editar registo',
        data: { breadcrumb: 'Editar' },
        canActivate: [requireEntityOperation('update')],
        loadComponent: () =>
          import('../dynamic-core/dynamic-records/record-form-page').then((m) => m.RecordFormPage),
      },
    ],
  },
];

/** Migalha com o nome (plural) da entidade da rota. */
function entityPluralName(route: ActivatedRouteSnapshot): string {
  return (
    inject(DynamicEntityRegistryService).find(route.paramMap.get('entityKey') ?? '')?.names
      .plural ?? 'Dados'
  );
}
