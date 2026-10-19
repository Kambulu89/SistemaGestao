import { defineModule } from '../../../core/modules/define-module';

export const REPORTING_MODULES = [
  defineModule({
    code: 'reporting.dashboards',
    name: 'Dashboards e KPI',
    description: 'Indicadores e painéis configuráveis.',
    group: 'reporting',
    icon: 'chart',
  }),
  defineModule({
    code: 'reporting.reports',
    name: 'Relatórios e exportação',
    description: 'Relatórios configuráveis e exportação de dados.',
    group: 'reporting',
    icon: 'chart',
    dependencies: ['reporting.dashboards'],
  }),
] as const;
