import { defineModule } from '../../../core/modules/define-module';

export const PROCUREMENT_MODULES = [
  defineModule({
    code: 'procurement.suppliers',
    name: 'Fornecedores e requisições',
    description: 'Fornecedores, requisições, encomendas a fornecedor e recepções de mercadoria.',
    group: 'procurement',
    icon: 'truck',
    // Módulo `procurement` do servidor (M06): funcionalidades `procurement.suppliers|requisitions|orders|receipts`.
    backendModule: 'procurement',
    permissions: [
      { key: 'procurement.read', name: 'Abrir a página de compras' },
      { key: 'supplier.read', name: 'Ver fornecedores' },
      { key: 'supplier.manage', name: 'Criar e alterar fornecedores' },
      { key: 'requisition.read', name: 'Ver requisições de compra' },
      { key: 'requisition.manage', name: 'Criar, alterar e submeter requisições' },
      { key: 'requisition.approve', name: 'Aprovar e rejeitar requisições (nunca as próprias)' },
      { key: 'purchase.read', name: 'Ver encomendas a fornecedor' },
      {
        key: 'purchase.manage',
        name: 'Criar e alterar encomendas em rascunho e converter requisições',
      },
      { key: 'purchase.confirm', name: 'Confirmar e cancelar encomendas a fornecedor' },
      { key: 'receipt.read', name: 'Ver recepções de mercadoria' },
      { key: 'receipt.manage', name: 'Criar e alterar recepções em rascunho' },
      { key: 'receipt.post', name: 'Lançar (entrada de stock) e reverter recepções' },
    ],
    accessPermission: 'procurement.read',
    features: [
      { id: 'suppliers', name: 'Fornecedores', description: 'Condições de compra sobre a Party.' },
      {
        id: 'requisitions',
        name: 'Requisições de compra',
        description: 'Pedido interno, aprovação por outra pessoa e conversão em encomenda.',
      },
      {
        id: 'orders',
        name: 'Encomendas a fornecedor',
        description: 'Encomendas com custos e impostos exactos.',
      },
      {
        id: 'receipts',
        name: 'Recepções de mercadoria',
        description: 'Entrada de stock ao custo da encomenda, com reversão.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Compras',
        permission: 'procurement.read',
        loadComponent: () => import('./purchasing/purchasing-page').then((m) => m.PurchasingPage),
      },
    ],
  }),
  // Capacidade do catálogo oficial (46): as cotações ainda não existem. As encomendas a fornecedor e as recepções vivem
  // na página «Compras» do módulo anterior (mesmo módulo `procurement` do servidor).
  defineModule({
    code: 'procurement.orders',
    name: 'Cotações e ordens de compra',
    description: 'Pedidos de cotação e ordens de compra.',
    group: 'procurement',
    icon: 'truck',
    dependencies: ['procurement.suppliers'],
  }),
] as const;
