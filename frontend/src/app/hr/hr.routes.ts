import type { Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/**
 * Recursos humanos (Prompt 07). Cada área tem a sua permissão (em qualquer âmbito: a API filtra pelo âmbito do membro);
 * as entrevistas do próprio só exigem a funcionalidade.
 */
const recruitment = { permission: 'hr.recruitment.read', anyScope: true };

export const HR_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'colaboradores' },
  {
    path: 'colaboradores',
    title: 'Colaboradores',
    canActivate: [accessGuard],
    data: { permission: 'hr.read', anyScope: true },
    children: [
      { path: '', loadComponent: () => import('./employees').then((m) => m.Employees) },
      {
        path: ':id',
        title: (r) => (r.paramMap.get('id') === 'novo' ? 'Novo colaborador' : 'Colaborador'),
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./employee-form').then((m) => m.EmployeeForm),
      },
    ],
  },
  {
    path: 'vagas',
    title: 'Vagas',
    canActivate: [accessGuard],
    data: recruitment,
    children: [
      { path: '', loadComponent: () => import('./requisitions').then((m) => m.Requisitions) },
      {
        path: ':id',
        title: (r) => (r.paramMap.get('id') === 'nova' ? 'Nova vaga' : 'Vaga'),
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./requisition-form').then((m) => m.RequisitionForm),
      },
    ],
  },
  {
    path: 'candidatos',
    title: 'Candidatos',
    canActivate: [accessGuard],
    data: recruitment,
    children: [
      { path: '', loadComponent: () => import('./candidates').then((m) => m.Candidates) },
      {
        path: ':id',
        title: (r) => (r.paramMap.get('id') === 'novo' ? 'Novo candidato' : 'Candidato'),
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./candidate-form').then((m) => m.CandidateForm),
      },
    ],
  },
  {
    path: 'candidaturas/:id',
    title: 'Candidatura',
    canActivate: [accessGuard],
    data: recruitment,
    loadComponent: () => import('./application-detail').then((m) => m.ApplicationDetail),
  },
  {
    path: 'entrevistas',
    title: 'As minhas entrevistas',
    loadComponent: () => import('./my-interviews').then((m) => m.MyInterviews),
  },
  {
    path: 'configuracao',
    title: 'Configuração de RH',
    canActivate: [accessGuard],
    data: { permission: 'hr.settings' },
    loadComponent: () => import('./hr-settings').then((m) => m.HrSettingsPage),
  },
];
