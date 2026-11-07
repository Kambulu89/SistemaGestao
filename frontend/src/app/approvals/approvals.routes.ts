import type { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

export const APPROVAL_ROUTES: Routes = [
  { path: '', loadComponent: () => import('./approvals-home').then((m) => m.ApprovalsHome) },
  {
    path: 'novo',
    title: 'Novo pedido',
    canActivate: [accessGuard],
    data: { permission: 'approvals.request' },
    loadComponent: () => import('./new-request').then((m) => m.NewRequest),
  },
  {
    path: 'pedidos/:id',
    title: 'Pedido',
    loadComponent: () => import('./request-detail').then((m) => m.RequestDetailPage),
  },
  {
    path: 'delegacoes',
    title: 'Delegações',
    loadComponent: () => import('./delegations').then((m) => m.Delegations),
  },
  {
    path: 'workflows',
    title: 'Workflows',
    canActivate: [accessGuard],
    data: { permission: 'approvals.manage' },
    children: [
      { path: '', loadComponent: () => import('./workflows').then((m) => m.Workflows) },
      {
        path: ':id',
        title: (r: ActivatedRouteSnapshot) =>
          r.paramMap.get('id') === 'novo' ? 'Novo workflow' : 'Workflow',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./workflow-form').then((m) => m.WorkflowForm),
      },
    ],
  },
];
