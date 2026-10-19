import { defineModule } from '../../../core/modules/define-module';

export const PROCUREMENT_MODULES = [
  defineModule({
    code: 'procurement.suppliers',
    name: 'Fornecedores e requisições',
    description: 'Fornecedores e pedidos internos de compra.',
    group: 'procurement',
    icon: 'truck',
  }),
  defineModule({
    code: 'procurement.orders',
    name: 'Cotações e ordens de compra',
    description: 'Pedidos de cotação e ordens de compra.',
    group: 'procurement',
    icon: 'truck',
    dependencies: ['procurement.suppliers'],
  }),
] as const;
