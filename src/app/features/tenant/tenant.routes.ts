import { inject } from '@angular/core';
import type { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { DynamicEntityRegistryService } from '../../core/dynamic/entity-registry.service';
import { requireEntityOperation } from '../../core/guards/entity.guard';
import { requirePermission } from '../../core/guards/permission.guard';
import { TENANT_PERMISSIONS } from '../../core/permissions/permission.model';

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
