import { Routes } from '@angular/router';
import { accessGuard, authGuard, guestGuard, platformGuard, tenantGuard } from './core/guards';

const page = (permission?: string, feature?: string) => ({
  canActivate: [accessGuard],
  data: { permission, feature },
});

export const routes: Routes = [
  {
    path: 'entrar',
    canActivate: [guestGuard],
    loadComponent: () => import('./public/login').then((m) => m.Login),
  },
  {
    path: 'recuperar',
    loadComponent: () => import('./public/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    path: 'redefinir-palavra-passe',
    loadComponent: () => import('./public/reset-password').then((m) => m.ResetPassword),
  },
  {
    path: 'aceitar-convite',
    loadComponent: () => import('./public/accept-invitation').then((m) => m.AcceptInvitation),
  },
  {
    path: 'empresas',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/tenant-select').then((m) => m.TenantSelect),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: 'perfil', loadComponent: () => import('./pages/profile').then((m) => m.Profile) },
      {
        path: 'sem-acesso',
        loadComponent: () => import('./pages/no-access').then((m) => m.NoAccess),
      },
      {
        path: 'plataforma',
        canActivate: [platformGuard],
        loadChildren: () => import('./platform/platform.routes').then((m) => m.PLATFORM_ROUTES),
      },
      {
        path: '',
        canActivate: [tenantGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'painel' },
          {
            path: 'painel',
            loadComponent: () => import('./pages/dashboard').then((m) => m.Dashboard),
          },
          {
            path: 'notificacoes',
            loadComponent: () => import('./pages/notifications').then((m) => m.Notifications),
          },
          {
            path: 'organizacao/:kind',
            ...page('organization.read', 'organization'),
            loadComponent: () =>
              import('./admin/organization-list').then((m) => m.OrganizationList),
          },
          {
            path: 'organizacao/:kind/:id',
            ...page('organization.read', 'organization'),
            loadComponent: () =>
              import('./admin/organization-form').then((m) => m.OrganizationForm),
          },
          {
            path: 'membros',
            ...page('members.read'),
            loadComponent: () => import('./admin/members').then((m) => m.Members),
          },
          {
            path: 'membros/:id',
            ...page('members.read'),
            loadComponent: () => import('./admin/member-detail').then((m) => m.MemberDetail),
          },
          {
            path: 'perfis',
            ...page('roles.read'),
            loadComponent: () => import('./admin/roles').then((m) => m.Roles),
          },
          {
            path: 'perfis/:id',
            ...page('roles.read'),
            loadComponent: () => import('./admin/role-form').then((m) => m.RoleForm),
          },
          {
            path: 'subscricao',
            ...page('subscription.read'),
            loadComponent: () => import('./admin/subscription').then((m) => m.TenantSubscription),
          },
          {
            path: 'auditoria',
            ...page('audit.read'),
            loadComponent: () => import('./admin/audit').then((m) => m.Audit),
          },
          {
            path: 'aprovacoes',
            ...page(undefined, 'approvals'),
            loadChildren: () =>
              import('./approvals/approvals.routes').then((m) => m.APPROVAL_ROUTES),
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
