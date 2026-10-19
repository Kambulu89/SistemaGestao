import { defineModule } from '../../../core/modules/define-module';

export const FINANCE_MODULES = [
  defineModule({
    code: 'finance.cash-banks',
    name: 'Caixa e bancos',
    description: 'Caixas, contas bancárias e conciliação.',
    group: 'finance',
    icon: 'card',
    settings: [{ key: 'baseCurrency', label: 'Moeda base', type: 'text', defaultValue: 'EUR' }],
  }),
  defineModule({
    code: 'finance.receivables-payables',
    name: 'Contas a receber/pagar',
    description: 'Recebimentos e pagamentos pendentes.',
    group: 'finance',
    icon: 'card',
    dependencies: ['finance.cash-banks'],
  }),
  defineModule({
    code: 'finance.payments-budget',
    name: 'Pagamentos e orçamento',
    description: 'Execução de pagamentos e controlo orçamental.',
    group: 'finance',
    icon: 'card',
    dependencies: ['finance.receivables-payables'],
  }),
] as const;
