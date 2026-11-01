import { defineModule } from '../../../core/modules/define-module';

export const REPORTING_MODULES = [
  defineModule({
    code: 'reporting.dashboards',
    name: 'Dashboards e KPI',
    description: 'Indicadores e painéis configuráveis.',
    group: 'reporting',
    icon: 'chart',
    lifecycle: 'beta',
    // Módulo `reporting` do servidor (S04): funcionalidades `reporting.reports|dashboards|exports|search`.
    backendModule: 'reporting',
    features: [
      {
        id: 'reports',
        name: 'Relatórios',
        description: 'Consultas declarativas sobre datasets autorizados, publicadas e imutáveis.',
      },
      {
        id: 'dashboards',
        name: 'Painéis e KPI',
        description: 'Widgets com indicadores, tabelas e gráficos, com filtros globais.',
      },
      {
        id: 'exports',
        name: 'Exportações',
        description: 'Exportações assíncronas em CSV com os direitos revalidados.',
      },
      {
        id: 'search',
        name: 'Pesquisa global',
        description: 'Pesquisa sobre um índice derivado, revalidada por quem pesquisa.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Relatórios e painéis',
        permission: 'reporting.dashboards.read',
        loadComponent: () => import('./reporting-page').then((m) => m.ReportingPage),
      },
    ],
  }),
  defineModule({
    code: 'reporting.reports',
    name: 'Relatórios e exportação',
    description: 'Relatórios configuráveis e exportação de dados.',
    group: 'reporting',
    icon: 'chart',
    dependencies: ['reporting.dashboards'],
    backendModule: 'reporting',
    // Os relatórios e as exportações vivem na página do módulo anterior, que tem o mesmo acesso.
    routes: [
      {
        path: '',
        title: 'Relatórios e exportação',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
  }),
] as const;
