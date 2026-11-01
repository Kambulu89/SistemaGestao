import type { Routes } from '@angular/router';
import { requirePermission } from '../../core/guards/permission.guard';
import { PLATFORM_PERMISSIONS } from '../../core/permissions/permission.model';
export const PLATFORM_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Plataforma',
    loadComponent: () => import('./dashboard/platform-dashboard').then((m) => m.PlatformDashboard),
  },
  {
    path: 'tenants',
    title: 'Tenants',
    data: { breadcrumb: 'Tenants' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.tenantsManage)],
    loadComponent: () => import('./tenants/tenants').then((m) => m.Tenants),
  },
  {
    path: 'catalog',
    title: 'Catálogo de módulos',
    data: { breadcrumb: 'Catálogo de módulos' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.modulesRead)],
    loadComponent: () => import('./catalog/module-catalog-page').then((m) => m.ModuleCatalogPage),
  },
  {
    path: 'plans',
    title: 'Planos',
    data: { breadcrumb: 'Planos' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.billingManage)],
    loadComponent: () => import('./plans/plans').then((m) => m.Plans),
  },
  {
    path: 'subscriptions',
    title: 'Subscrições',
    data: { breadcrumb: 'Subscrições' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.billingManage)],
    loadComponent: () => import('./subscriptions/subscriptions').then((m) => m.Subscriptions),
  },
  {
    path: '**',
    title: 'Página não encontrada',
    loadComponent: () => import('../system/not-found/not-found').then((m) => m.NotFound),
  },
];
