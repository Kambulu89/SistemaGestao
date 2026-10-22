import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/guards/auth.guard';
import { homeRedirectGuard } from './core/guards/home-redirect.guard';
import { platformGuard } from './core/guards/platform.guard';
import { tenantGuard } from './core/guards/tenant.guard';
import { ALL_MODULE_MANIFESTS } from './module-catalog';
import { buildModuleRoutes } from './module-routes';

const authLayout = () => import('./layouts/auth-layout/auth-layout').then((m) => m.AuthLayout);
const notFound = () => import('./features/system/not-found/not-found').then((m) => m.NotFound);

export const routes: Routes = [
  // "/" decide para onde enviar o utilizador (login, plataforma ou último tenant).
  { path: '', pathMatch: 'full', canActivate: [homeRedirectGuard], children: [] },

  {
    path: 'auth',
    loadComponent: authLayout,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'login' },
      {
        path: 'login',
        title: 'Entrar',
        canActivate: [guestGuard],
        loadComponent: () => import('./features/auth/login/login').then((m) => m.Login),
      },
      {
        path: 'forgot-password',
        title: 'Recuperar palavra-passe',
        canActivate: [guestGuard],
        loadComponent: () =>
          import('./features/auth/forgot-password/forgot-password').then((m) => m.ForgotPassword),
      },
      {
        path: 'reset-password',
        title: 'Nova palavra-passe',
        canActivate: [guestGuard],
        loadComponent: () =>
          import('./features/auth/reset-password/reset-password').then((m) => m.ResetPassword),
      },
      {
        path: 'accept-invitation',
        title: 'Convite',
        canActivate: [authGuard],
        loadComponent: () =>
          import('./features/auth/accept-invitation/accept-invitation').then(
            (m) => m.AcceptInvitation,
          ),
      },
      {
        path: 'no-access',
        title: 'Sem acesso',
        loadComponent: () =>
          import('./features/system/no-access/no-access').then((m) => m.NoAccess),
      },
    ],
  },

  {
    path: 'platform',
    canActivate: [authGuard, platformGuard],
    loadComponent: () =>
      import('./layouts/platform-layout/platform-layout').then((m) => m.PlatformLayout),
    loadChildren: () =>
      import('./features/platform/platform.routes').then((m) => m.PLATFORM_ROUTES),
  },

  {
    path: 't/:tenantSlug',
    canActivate: [authGuard, tenantGuard],
    runGuardsAndResolvers: 'paramsChange',
    loadComponent: () =>
      import('./layouts/tenant-layout/tenant-layout').then((m) => m.TenantLayout),
    // Páginas de administração + rotas lazy dos módulos geradas a partir dos manifestos.
    loadChildren: () =>
      import('./features/tenant/tenant.routes').then((m) => [
        ...m.TENANT_ROUTES,
        ...buildModuleRoutes(ALL_MODULE_MANIFESTS),
        { path: '**', title: 'Página não encontrada', loadComponent: notFound },
      ]),
  },

  {
    path: '**',
    loadComponent: authLayout,
    children: [{ path: '', title: 'Página não encontrada', loadComponent: notFound }],
  },
];
