import type { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/** Contabilidade (Prompt 06): leitura com `accounting.read`; cada acção é verificada pelo servidor. */
export const ACCOUNTING_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'lancamentos' },
  {
    path: 'planos',
    title: 'Planos de contas',
    children: [
      { path: '', loadComponent: () => import('./charts').then((m) => m.Charts) },
      {
        path: ':id',
        title: 'Plano de contas',
        loadComponent: () => import('./chart-detail').then((m) => m.ChartDetail),
      },
    ],
  },
  {
    path: 'exercicios',
    title: 'Exercícios',
    children: [
      { path: '', loadComponent: () => import('./fiscal-years').then((m) => m.FiscalYears) },
      {
        path: ':id',
        title: 'Exercício',
        loadComponent: () => import('./fiscal-year-detail').then((m) => m.FiscalYearDetail),
      },
    ],
  },
  {
    path: 'regras',
    title: 'Regras de contabilização',
    children: [
      { path: '', loadComponent: () => import('./posting-rules').then((m) => m.PostingRules) },
      {
        path: ':id',
        title: (r: ActivatedRouteSnapshot) =>
          r.paramMap.get('id') === 'novo' ? 'Nova regra' : 'Regra',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./posting-rule-form').then((m) => m.PostingRuleForm),
      },
    ],
  },
  {
    path: 'eventos',
    title: 'Eventos contabilísticos',
    loadComponent: () => import('./posting-events').then((m) => m.PostingEvents),
  },
  {
    path: 'diarios',
    title: 'Diários',
    loadComponent: () => import('./journals').then((m) => m.Journals),
  },
  {
    path: 'lancamentos',
    title: 'Lançamentos',
    children: [
      { path: '', loadComponent: () => import('./entries').then((m) => m.Entries) },
      {
        path: ':id',
        title: (r: ActivatedRouteSnapshot) =>
          r.paramMap.get('id') === 'novo' ? 'Novo lançamento' : 'Lançamento',
        canActivate: [accessGuard],
        data: { permission: 'accounting.read' },
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./entry-form').then((m) => m.EntryForm),
      },
    ],
  },
];
