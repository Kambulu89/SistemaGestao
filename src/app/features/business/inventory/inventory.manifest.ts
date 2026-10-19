import { defineModule } from '../../../core/modules/define-module';

export const INVENTORY_MODULES = [
  defineModule({
    code: 'inventory.warehouses',
    name: 'Armazéns e stock',
    description: 'Armazéns, localizações e níveis de stock.',
    group: 'inventory',
    icon: 'archive',
    dependencies: ['sales.catalog'],
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
