import { defineModule } from '../../../core/modules/define-module';

export const ACCOUNTING_MODULES = [
  defineModule({
    code: 'accounting.general-ledger',
    name: 'Contabilidade geral',
    description: 'Plano de contas, exercícios, diários, lançamentos, razão e balancete.',
    group: 'accounting',
    icon: 'document',
    lifecycle: 'beta',
    // Módulo `accounting` do servidor (ERP E1, D-062): funcionalidades `accounting.ledger` e `accounting.posting_rules`.
    backendModule: 'accounting',
    features: [
      {
        id: 'ledger',
        name: 'Plano de contas, exercícios e lançamentos',
        description:
          'Partidas dobradas garantidas na base de dados, lançados imutáveis, reversão, razão e balancete.',
      },
      {
        id: 'posting_rules',
        name: 'Regras de contabilização',
        description:
          'Contas e diários por evento dos outros módulos, para a contabilização automática.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Contabilidade',
        permission: 'accounting.general-ledger.read',
        loadComponent: () => import('./accounting-page').then((m) => m.AccountingPage),
      },
    ],
  }),
] as const;
