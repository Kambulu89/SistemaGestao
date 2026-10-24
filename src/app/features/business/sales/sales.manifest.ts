import { defineModule } from '../../../core/modules/define-module';

export const SALES_MODULES = [
  defineModule({
    code: 'sales.catalog',
    name: 'Catálogo e preços',
    description: 'Produtos, serviços e tabelas de preços.',
    group: 'sales',
    icon: 'tag',
    // Módulo `catalog` do servidor (M03); as funcionalidades são `catalog.products` e `catalog.prices`.
    backendModule: 'catalog',
    permissions: [
      { key: 'catalog.read', name: 'Ver produtos e categorias' },
      { key: 'catalog.manage', name: 'Gerir produtos, variantes e categorias' },
      { key: 'price.read', name: 'Ver tabelas de preços e resolver preços' },
      { key: 'price.manage', name: 'Gerir tabelas de preços' },
    ],
    accessPermission: 'catalog.read',
    features: [
      {
        id: 'products',
        name: 'Produtos e variantes',
        description: 'Produtos, serviços, variantes e categorias.',
      },
      {
        id: 'prices',
        name: 'Tabelas de preços',
        description: 'Preços por organização, moeda, período e escalão.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Catálogo e preços',
        permission: 'catalog.read',
        loadComponent: () => import('./catalog/catalog-page').then((m) => m.CatalogPage),
      },
    ],
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
