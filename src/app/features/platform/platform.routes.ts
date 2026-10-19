import type { Routes } from '@angular/router';
import { requirePermission } from '../../core/guards/permission.guard';
import { PLATFORM_PERMISSIONS } from '../../core/permissions/permission.model';
import { BillingGateway } from './billing/billing.gateway';
import { MockBillingGateway } from './billing/mock-billing.gateway';
import { MockTenantsGateway } from './tenants/mock-tenants.gateway';
import { TenantsGateway } from './tenants/tenants.gateway';

// Trocar os adapters mock por adapters HTTP quando existir API.
const billingProviders = [{ provide: BillingGateway, useClass: MockBillingGateway }];

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
    providers: [{ provide: TenantsGateway, useClass: MockTenantsGateway }],
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
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.plansRead)],
    providers: billingProviders,
    loadComponent: () => import('./plans/plans').then((m) => m.Plans),
  },
  {
    path: 'subscriptions',
    title: 'Subscrições',
    data: { breadcrumb: 'Subscrições' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.subscriptionsRead)],
    providers: billingProviders,
    loadComponent: () => import('./subscriptions/subscriptions').then((m) => m.Subscriptions),
  },
  {
    path: 'settings',
    title: 'Configurações da plataforma',
    data: { breadcrumb: 'Configurações' },
    canActivate: [requirePermission(PLATFORM_PERMISSIONS.settingsRead)],
    loadComponent: () => import('./settings/platform-settings').then((m) => m.PlatformSettings),
  },
  {
    path: '**',
    title: 'Página não encontrada',
    loadComponent: () => import('../system/not-found/not-found').then((m) => m.NotFound),
  },
];
