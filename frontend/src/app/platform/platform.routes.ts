import type { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { unsavedChangesGuard } from '../core/unsaved';

/** Administração da plataforma (sem empresa em contexto). O acesso é verificado pelo servidor (`is_platform_admin`). */
export const PLATFORM_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'empresas' },
  {
    path: 'empresas',
    title: 'Empresas',
    children: [
      { path: '', loadComponent: () => import('./tenants').then((m) => m.PlatformTenants) },
      {
        path: ':id',
        title: 'Empresa',
        loadComponent: () => import('./tenant-detail').then((m) => m.PlatformTenantDetail),
      },
    ],
  },
  {
    path: 'planos',
    title: 'Planos',
    children: [
      { path: '', loadComponent: () => import('./plans').then((m) => m.PlatformPlans) },
      {
        path: ':id',
        title: (r: ActivatedRouteSnapshot) =>
          r.paramMap.get('id') === 'novo' ? 'Novo plano' : 'Plano',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./plan-form').then((m) => m.PlatformPlanForm),
      },
    ],
  },
];
