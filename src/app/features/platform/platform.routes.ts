import type { Routes } from '@angular/router';
import { requirePermission } from '../../core/guards/permission.guard';
import { PLATFORM_PERMISSIONS } from '../../core/permissions/permission.model';
import { MockTenantsGateway } from './tenants/mock-tenants.gateway';
import { TenantsGateway } from './tenants/tenants.gateway';

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
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.tenantsRead)],
    // Trocar `MockTenantsGateway` por um adapter HTTP quando existir API.
    providers: [{ provide: TenantsGateway, useClass: MockTenantsGateway }],
    loadComponent: () => import('./tenants/tenants').then((m) => m.Tenants),
  },
  {
    path: 'plans',
    title: 'Planos',
    data: { breadcrumb: 'Planos' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.plansRead)],
    loadComponent: () => import('./plans/plans').then((m) => m.Plans),
  },
  {
    path: 'subscriptions',
    title: 'Subscrições',
    data: { breadcrumb: 'Subscrições' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.subscriptionsRead)],
    loadComponent: () => import('./subscriptions/subscriptions').then((m) => m.Subscriptions),
  },
  {
    path: '**',
    title: 'Página não encontrada',
    loadComponent: () => import('../system/not-found/not-found').then((m) => m.NotFound),
  },
];
