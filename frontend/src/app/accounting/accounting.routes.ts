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
    path: 'abertura',
    title: 'Saldos de abertura',
    canActivate: [accessGuard],
    data: { permission: 'accounting.create' },
    loadComponent: () => import('./opening-balances').then((m) => m.OpeningBalances),
  },
  {
    path: 'balancete',
    title: 'Balancete',
    canActivate: [accessGuard],
    data: { permission: 'accounting.reports' },
    loadComponent: () => import('./trial-balance').then((m) => m.TrialBalancePage),
  },
  {
    path: 'razao',
    title: 'Razão',
    canActivate: [accessGuard],
    data: { permission: 'accounting.reports' },
    loadComponent: () => import('./ledger').then((m) => m.LedgerPage),
  },
  {
    path: 'dimensoes',
    title: 'Dimensões analíticas',
    loadComponent: () => import('./dimensions').then((m) => m.Dimensions),
  },
  {
    path: 'chaves',
    title: 'Chaves de repartição',
    loadComponent: () => import('./allocation-keys').then((m) => m.AllocationKeys),
  },
  {
    path: 'analitica',
    title: 'Analítica',
    canActivate: [accessGuard],
    data: { permission: 'accounting.analytics' },
    loadComponent: () => import('./analytics-report').then((m) => m.AnalyticsReportPage),
  },
  {
    path: 'fecho',
    title: 'Fecho',
    loadComponent: () => import('./closing').then((m) => m.ClosingPage),
  },
  {
    path: 'demonstracoes',
    title: 'Demonstrações financeiras',
    canActivate: [accessGuard],
    data: { permission: 'accounting.reports' },
    loadComponent: () => import('./statements').then((m) => m.StatementsPage),
  },
  {
    path: 'modelos-demonstracoes',
    title: 'Modelos de demonstrações',
    loadComponent: () => import('./statement-templates').then((m) => m.StatementTemplates),
  },
  {
    path: 'regularizacoes',
    title: 'Regularizações',
    loadComponent: () => import('./adjustment-schedules').then((m) => m.AdjustmentSchedules),
  },
  {
    path: 'provisoes',
    title: 'Provisões',
    loadComponent: () => import('./provisions').then((m) => m.Provisions),
  },
  {
    path: 'diferencas-cambiais',
    title: 'Diferenças cambiais',
    canActivate: [accessGuard],
    data: { permission: 'accounting.adjustments' },
    loadComponent: () => import('./fx-revaluation').then((m) => m.FxRevaluationPage),
  },
  {
    path: 'reconciliacao',
    title: 'Reconciliação de contas',
    loadComponent: () => import('./reconciliation').then((m) => m.ReconciliationPage),
  },
  {
    path: 'activos',
    title: 'Activos fixos',
    canActivate: [accessGuard],
    data: { permission: 'fixed_assets.read' },
    children: [
      { path: '', loadComponent: () => import('./assets').then((m) => m.Assets) },
      {
        path: ':id',
        title: (r: ActivatedRouteSnapshot) =>
          r.paramMap.get('id') === 'novo' ? 'Novo activo' : 'Activo fixo',
        loadComponent: () => import('./asset-detail').then((m) => m.AssetDetail),
      },
    ],
  },
  {
    path: 'classes-activos',
    title: 'Classes de activos',
    canActivate: [accessGuard],
    data: { permission: 'fixed_assets.read' },
    loadComponent: () => import('./asset-classes').then((m) => m.AssetClasses),
  },
  {
    path: 'depreciacoes',
    title: 'Depreciações',
    canActivate: [accessGuard],
    data: { permission: 'fixed_assets.read' },
    loadComponent: () => import('./depreciation').then((m) => m.DepreciationPage),
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
