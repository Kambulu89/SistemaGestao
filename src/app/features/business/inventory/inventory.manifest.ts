import { defineModule } from '../../../core/modules/define-module';

export const INVENTORY_MODULES = [
  defineModule({
    code: 'inventory.warehouses',
    name: 'Armazéns e stock',
    description: 'Armazéns, localizações e níveis de stock.',
    group: 'inventory',
    icon: 'archive',
    dependencies: ['sales.catalog'],
    // Módulo `inventory` do servidor (M07): funcionalidades `inventory.warehouses` e `inventory.stock`.
    backendModule: 'inventory',
    permissions: [
      { key: 'inventory.read', name: 'Ver stock, movimentos, lotes e reservas' },
      { key: 'inventory.adjust', name: 'Ajustar stock, reverter movimentos e criar lotes' },
      { key: 'inventory.reserve', name: 'Criar e libertar reservas de stock' },
      { key: 'warehouse.manage', name: 'Gerir armazéns e locais' },
      { key: 'transfer.read', name: 'Ver transferências entre armazéns' },
      { key: 'transfer.manage', name: 'Criar e alterar transferências em rascunho' },
      { key: 'transfer.dispatch', name: 'Expedir transferências' },
      { key: 'transfer.receive', name: 'Receber transferências em trânsito' },
      { key: 'count.read', name: 'Ver contagens físicas' },
      { key: 'count.manage', name: 'Criar, abrir, contar e rever contagens' },
      { key: 'count.post', name: 'Lançar os ajustes de uma contagem' },
      { key: 'return.read', name: 'Ver devoluções' },
      { key: 'return.manage', name: 'Criar e alterar devoluções em rascunho' },
      { key: 'return.post', name: 'Aprovar e lançar devoluções' },
    ],
    accessPermission: 'inventory.read',
    features: [
      {
        id: 'warehouses',
        name: 'Armazéns e locais',
        description: 'Armazéns, locais e o armazém de vendas.',
      },
      {
        id: 'stock',
        name: 'Stock, movimentos, lotes e reservas',
        description: 'Saldos, livro de movimentos, ajustes, lotes e reservas.',
      },
      {
        id: 'transfers',
        name: 'Transferências entre armazéns',
        description: 'Expedir, pôr em trânsito e receber no destino.',
      },
      {
        id: 'counts',
        name: 'Contagens físicas',
        description: 'Congelar locais, contar, rever e lançar ajustes.',
      },
      {
        id: 'returns',
        name: 'Devoluções',
        description: 'Devoluções de clientes e a fornecedores, derivadas do livro de movimentos.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Armazéns e stock',
        permission: 'inventory.read',
        loadComponent: () => import('./stock/inventory-page').then((m) => m.InventoryPage),
      },
    ],
  }),
  defineModule({
    code: 'inventory.movements',
    name: 'Movimentações e transferências',
    description: 'Entradas, saídas e transferências entre armazéns.',
    group: 'inventory',
    icon: 'archive',
    dependencies: ['inventory.warehouses'],
  }),
  defineModule({
    code: 'inventory.stocktaking',
    name: 'Inventários físicos',
    description: 'Contagens e acertos de inventário.',
    group: 'inventory',
    icon: 'clipboard',
    dependencies: ['inventory.warehouses'],
  }),
] as const;
