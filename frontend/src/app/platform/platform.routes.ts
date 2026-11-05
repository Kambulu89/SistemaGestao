import { Routes } from '@angular/router';

/** Administração da plataforma (sem empresa em contexto). O acesso é verificado pelo servidor (`is_platform_admin`). */
export const PLATFORM_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'empresas' },
  { path: 'empresas', loadComponent: () => import('./tenants').then((m) => m.PlatformTenants) },
  {
    path: 'empresas/:id',
    loadComponent: () => import('./tenant-detail').then((m) => m.PlatformTenantDetail),
  },
  { path: 'planos', loadComponent: () => import('./plans').then((m) => m.PlatformPlans) },
  {
    path: 'planos/:id',
    loadComponent: () => import('./plan-form').then((m) => m.PlatformPlanForm),
  },
];
