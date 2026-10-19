import type { Routes } from '@angular/router';
import { moduleGuard } from '../../core/guards/module.guard';
import { requirePermission } from '../../core/guards/permission.guard';
import { TENANT_PERMISSIONS } from '../../core/permissions/permission.model';

const modulePage = () =>
  import('./module-placeholder/module-placeholder').then((m) => m.ModulePlaceholder);

export const TENANT_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Painel',
    loadComponent: () => import('./dashboard/tenant-dashboard').then((m) => m.TenantDashboard),
  },
  {
    path: 'organization',
    title: 'Organização',
    data: { breadcrumb: 'Organização' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.organizationRead)],
    loadComponent: () => import('./organization/organization').then((m) => m.TenantOrganization),
  },
  {
    path: 'users',
    title: 'Utilizadores',
    data: { breadcrumb: 'Utilizadores' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.usersRead)],
    loadComponent: () => import('./users/users').then((m) => m.TenantUsers),
  },
  {
    path: 'settings',
    title: 'Configurações',
    data: { breadcrumb: 'Configurações' },
    canActivate: [requirePermission(TENANT_PERMISSIONS.settingsRead)],
    loadComponent: () => import('./settings/settings').then((m) => m.TenantSettings),
  },
  {
    path: 'modules/:moduleId',
    title: 'Módulo',
    data: { breadcrumb: 'Módulo' },
    canActivate: [moduleGuard],
    loadComponent: modulePage,
  },
  {
    path: 'modules/:moduleId/:section',
    title: 'Módulo',
    data: { breadcrumb: 'Módulo' },
    canActivate: [moduleGuard],
    loadComponent: modulePage,
  },
  {
    path: '**',
    title: 'Página não encontrada',
    loadComponent: () => import('../system/not-found/not-found').then((m) => m.NotFound),
  },
];
