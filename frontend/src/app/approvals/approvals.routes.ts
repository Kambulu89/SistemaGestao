import { Routes } from '@angular/router';
import { accessGuard } from '../core/guards';

export const APPROVAL_ROUTES: Routes = [
  { path: '', loadComponent: () => import('./approvals-home').then((m) => m.ApprovalsHome) },
  {
    path: 'novo',
    canActivate: [accessGuard],
    data: { permission: 'approvals.request' },
    loadComponent: () => import('./new-request').then((m) => m.NewRequest),
  },
  {
    path: 'pedidos/:id',
    loadComponent: () => import('./request-detail').then((m) => m.RequestDetailPage),
  },
  { path: 'delegacoes', loadComponent: () => import('./delegations').then((m) => m.Delegations) },
  {
    path: 'workflows',
    canActivate: [accessGuard],
    data: { permission: 'approvals.manage' },
    loadComponent: () => import('./workflows').then((m) => m.Workflows),
  },
  {
    path: 'workflows/:id',
    canActivate: [accessGuard],
    data: { permission: 'approvals.manage' },
    loadComponent: () => import('./workflow-form').then((m) => m.WorkflowForm),
  },
];
