import { defineModule } from '../../../core/modules/define-module';

export const SALES_MODULES = [
  defineModule({
    code: 'sales.catalog',
    name: 'Catálogo e preços',
    description: 'Produtos, serviços e tabelas de preços.',
    group: 'sales',
    icon: 'tag',
  }),
  defineModule({
    code: 'sales.orders',
    name: 'Orçamentos e vendas',
    description: 'Orçamentos, encomendas e vendas.',
    group: 'sales',
    icon: 'card',
    dependencies: ['sales.catalog'],
    settings: [
      {
        key: 'quoteValidityDays',
        label: 'Validade dos orçamentos (dias)',
        type: 'number',
        defaultValue: 30,
      },
    ],
  }),
  defineModule({
    code: 'sales.billing',
    name: 'Contratos e faturação',
    description: 'Contratos recorrentes e emissão de faturas.',
    group: 'sales',
    icon: 'document',
    dependencies: ['sales.orders'],
  }),
] as const;
