import type { Routes } from '@angular/router';
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
    loadComponent: () => import('./modules/tenant-modules-page').then((m) => m.TenantModulesPage),
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
];
