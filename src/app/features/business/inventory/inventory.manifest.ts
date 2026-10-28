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
