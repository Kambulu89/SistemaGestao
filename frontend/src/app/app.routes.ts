import type { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { accessGuard, authGuard, guestGuard, platformGuard, tenantGuard } from './core/guards';
import { unsavedChangesGuard } from './core/unsaved';
import { ORG_KINDS } from './admin/org-kinds';
import { REF_KINDS } from './settings/reference-kinds';

const page = (permission?: string, feature?: string) => ({
  canActivate: [accessGuard],
  data: { permission, feature },
});
const isNew = (r: ActivatedRouteSnapshot) => r.paramMap.get('id') === 'novo';

/**
 * Cada rota tem `title` (separador do browser e trilho de navegação). Os ecrãs de detalhe trocam o último elemento do
 * trilho pelo nome do registo (`Breadcrumbs.setCurrent`).
 */
export const routes: Routes = [
  {
    path: 'entrar',
    title: 'Entrar',
    canActivate: [guestGuard],
    loadComponent: () => import('./public/login').then((m) => m.Login),
  },
  {
    path: 'recuperar',
    title: 'Recuperar palavra-passe',
    loadComponent: () => import('./public/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    path: 'redefinir-palavra-passe',
    title: 'Nova palavra-passe',
    loadComponent: () => import('./public/reset-password').then((m) => m.ResetPassword),
  },
  {
    path: 'aceitar-convite',
    title: 'Aceitar convite',
    loadComponent: () => import('./public/accept-invitation').then((m) => m.AcceptInvitation),
  },
  {
    path: 'empresas',
    title: 'Escolher empresa',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/tenant-select').then((m) => m.TenantSelect),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      {
        path: 'perfil',
        title: 'A minha conta',
        loadComponent: () => import('./pages/profile').then((m) => m.Profile),
      },
      {
        path: 'sem-acesso',
        title: 'Sem acesso',
        loadComponent: () => import('./pages/no-access').then((m) => m.NoAccess),
      },
      {
        path: 'plataforma',
        title: 'Plataforma',
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
            title: 'Painel',
            loadComponent: () => import('./pages/dashboard').then((m) => m.Dashboard),
          },
          {
            path: 'notificacoes',
            title: 'Notificações',
            loadComponent: () => import('./pages/notifications').then((m) => m.Notifications),
          },
          {
            path: 'organizacao/:kind',
            title: (r: ActivatedRouteSnapshot) =>
              ORG_KINDS[r.paramMap.get('kind') ?? '']?.title ?? 'Organização',
            ...page('organization.read', 'organization'),
            children: [
              {
                path: '',
                loadComponent: () =>
                  import('./admin/organization-list').then((m) => m.OrganizationList),
              },
              {
                path: ':id',
                title: (r: ActivatedRouteSnapshot) => (isNew(r) ? 'Novo registo' : 'Detalhe'),
                canDeactivate: [unsavedChangesGuard],
                loadComponent: () =>
                  import('./admin/organization-form').then((m) => m.OrganizationForm),
              },
            ],
          },
          {
            path: 'membros',
            title: 'Membros',
            ...page('members.read'),
            children: [
              { path: '', loadComponent: () => import('./admin/members').then((m) => m.Members) },
              {
                path: ':id',
                title: 'Membro',
                loadComponent: () => import('./admin/member-detail').then((m) => m.MemberDetail),
              },
            ],
          },
          {
            path: 'perfis',
            title: 'Perfis',
            ...page('roles.read'),
            children: [
              { path: '', loadComponent: () => import('./admin/roles').then((m) => m.Roles) },
              {
                path: 'matriz',
                title: 'Matriz de permissões',
                loadComponent: () =>
                  import('./admin/permission-matrix').then((m) => m.PermissionMatrix),
              },
              {
                path: ':id',
                title: (r: ActivatedRouteSnapshot) => (isNew(r) ? 'Novo perfil' : 'Perfil'),
                canDeactivate: [unsavedChangesGuard],
                loadComponent: () => import('./admin/role-form').then((m) => m.RoleForm),
              },
            ],
          },
          {
            path: 'empresa/perfil',
            title: 'Perfil da empresa',
            ...page('settings.read'),
            canDeactivate: [unsavedChangesGuard],
            loadComponent: () =>
              import('./settings/company-profile').then((m) => m.CompanyProfilePage),
          },
          {
            path: 'empresa/configuracoes',
            title: 'Configurações',
            ...page('settings.read'),
            canDeactivate: [unsavedChangesGuard],
            loadComponent: () =>
              import('./settings/company-settings').then((m) => m.CompanySettingsPage),
          },
          ...Object.values(REF_KINDS).map((k) => ({
            path: `empresa/${k.segment}`,
            title: k.title,
            ...page(k.readPermission),
            data: { permission: k.readPermission, kind: k.segment },
            children: [
              {
                path: '',
                loadComponent: () =>
                  import('./settings/reference-list').then((m) => m.ReferenceList),
              },
              {
                path: ':id',
                title: (r: ActivatedRouteSnapshot) => (isNew(r) ? 'Novo registo' : 'Detalhe'),
                canDeactivate: [unsavedChangesGuard],
                loadComponent: () =>
                  import('./settings/reference-form').then((m) => m.ReferenceForm),
              },
            ],
          })),
          {
            path: 'subscricao',
            title: 'Subscrição',
            ...page('subscription.read'),
            loadComponent: () => import('./admin/subscription').then((m) => m.TenantSubscription),
          },
          {
            path: 'auditoria',
            title: 'Auditoria',
            ...page('audit.read'),
            loadComponent: () => import('./admin/audit').then((m) => m.Audit),
          },
          {
            path: 'rh',
            title: 'Recursos humanos',
            canActivate: [accessGuard],
            data: { permission: 'hr.read', feature: 'hr', anyScope: true },
            loadChildren: () => import('./hr/hr.routes').then((m) => m.HR_ROUTES),
          },
          {
            path: 'contabilidade',
            title: 'Contabilidade',
            ...page('accounting.read', 'accounting'),
            loadChildren: () =>
              import('./accounting/accounting.routes').then((m) => m.ACCOUNTING_ROUTES),
          },
          {
            path: 'aprovacoes',
            title: 'Aprovações',
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
