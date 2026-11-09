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
    path: 'contratos/:id',
    title: 'Contrato',
    canActivate: [accessGuard],
    data: { permission: 'hr.contracts.read', anyScope: true },
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./contract-detail').then((m) => m.ContractDetail),
  },
  {
    path: 'ausencias',
    title: 'Férias e ausências',
    children: [
      { path: '', loadComponent: () => import('./leave-requests').then((m) => m.LeaveRequests) },
      {
        path: 'configuracao',
        title: 'Configuração de férias e ausências',
        canActivate: [accessGuard],
        data: { permission: 'hr.leave.settings' },
        loadComponent: () => import('./leave-settings').then((m) => m.LeaveSettings),
      },
      {
        path: ':id',
        title: 'Pedido de ausência',
        loadComponent: () => import('./leave-request-detail').then((m) => m.LeaveRequestDetail),
      },
    ],
  },
  {
    path: 'processamento',
    title: 'Processamento salarial',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'hr.payroll.read', anyScope: true },
        loadComponent: () => import('./payroll-runs').then((m) => m.PayrollRuns),
      },
      {
        path: 'regras',
        title: 'Regras de IRT e INSS',
        canActivate: [accessGuard],
        data: { permission: 'hr.payroll.settings' },
        loadComponent: () => import('./payroll-rules').then((m) => m.PayrollRules),
      },
      {
        path: ':id',
        title: 'Lote de processamento',
        loadComponent: () => import('./payroll-run').then((m) => m.PayrollRunPage),
      },
    ],
  },
  {
    path: 'emprestimos',
    title: 'Adiantamentos e empréstimos',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'hr.loans.read', anyScope: true },
        loadComponent: () => import('./loans').then((m) => m.Loans),
      },
      {
        path: ':id',
        title: 'Adiantamento ou empréstimo',
        loadComponent: () => import('./loan-detail').then((m) => m.LoanDetail),
      },
    ],
  },
  {
    path: 'compensacao',
    title: 'Compensação',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'hr.compensation.read', anyScope: true },
        loadComponent: () =>
          import('./compensation-proposals').then((m) => m.CompensationProposals),
      },
      {
        path: 'componentes',
        title: 'Componentes de remuneração',
        canActivate: [accessGuard],
        data: { permission: 'hr.compensation.settings' },
        loadComponent: () => import('./pay-components').then((m) => m.PayComponents),
      },
      {
        path: ':id',
        title: 'Proposta de compensação',
        loadComponent: () => import('./compensation-proposal').then((m) => m.CompensationProposal),
      },
    ],
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
