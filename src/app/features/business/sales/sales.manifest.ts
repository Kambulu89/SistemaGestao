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
    dependencies: ['sales.catalog', 'crm.customers'],
    // Módulo `orders` do servidor (M04): funcionalidades `orders.quotes` e `orders.orders`.
    backendModule: 'orders',
    accessPermission: 'sales.orders.read',
    features: [
      {
        id: 'quotes',
        name: 'Propostas comerciais',
        description: 'Propostas com preços e impostos congelados.',
      },
      {
        id: 'orders',
        name: 'Encomendas de venda',
        description: 'Encomendas, confirmação e cancelamento.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Propostas e encomendas',
        permission: 'sales.orders.read',
        loadComponent: () => import('./orders/orders-page').then((m) => m.OrdersPage),
      },
    ],
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
    description: 'Contratos, facturas e notas de crédito.',
    group: 'sales',
    icon: 'document',
    dependencies: ['sales.orders'],
    // Módulo `invoicing` do servidor (M05): funcionalidades `invoicing.contracts` e `invoicing.invoices`.
    backendModule: 'invoicing',
    permissions: [
      { key: 'sales.billing.read', name: 'Abrir a página de facturação e contratos' },
      { key: 'invoice.read', name: 'Ver facturas e notas de crédito' },
      { key: 'invoice.manage', name: 'Criar e alterar facturas em rascunho' },
      { key: 'invoice.issue', name: 'Emitir facturas' },
      { key: 'credit_note.manage', name: 'Criar e alterar notas de crédito em rascunho' },
      { key: 'credit_note.issue', name: 'Emitir notas de crédito' },
      { key: 'contract.read', name: 'Ver contratos' },
      { key: 'contract.manage', name: 'Criar, alterar, activar e terminar contratos' },
    ],
    accessPermission: 'sales.billing.read',
    features: [
      {
        id: 'contracts',
        name: 'Contratos',
        description: 'Contratos de venda, compra e serviço, com vigência e aviso de renovação.',
      },
      {
        id: 'invoices',
        name: 'Facturas e notas de crédito',
        description:
          'Facturação a partir de encomendas ou linhas livres; correcção por notas de crédito.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Facturação e contratos',
        permission: 'sales.billing.read',
        loadComponent: () => import('./billing/billing-page').then((m) => m.BillingPage),
      },
    ],
  }),
] as const;
