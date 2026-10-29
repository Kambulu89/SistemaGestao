import { defineModule } from '../../../core/modules/define-module';

export const FINANCE_MODULES = [
  defineModule({
    code: 'finance.cash-banks',
    name: 'Caixa e bancos',
    description:
      'Caixas, contas bancárias, contas a receber e a pagar, pagamentos e facturas de fornecedor.',
    group: 'finance',
    icon: 'card',
    settings: [{ key: 'baseCurrency', label: 'Moeda base', type: 'text', defaultValue: 'EUR' }],
    // Módulo `finance` do servidor (M09): funcionalidades `finance.treasury|obligations|payments|supplier_invoices`.
    backendModule: 'finance',
    permissions: [
      { key: 'finance.read', name: 'Abrir a página de Tesouraria' },
      { key: 'treasury.read', name: 'Ver contas de tesouraria, saldos e extractos' },
      { key: 'treasury.manage', name: 'Criar e alterar contas de tesouraria' },
      { key: 'receivable.read', name: 'Ver contas a receber e a exposição de crédito' },
      { key: 'payable.read', name: 'Ver contas a pagar' },
      { key: 'payment.read', name: 'Ver pagamentos e recebimentos' },
      { key: 'payment.manage', name: 'Registar, submeter e apagar pagamentos em rascunho' },
      { key: 'payment.confirm', name: 'Confirmar, falhar e reverter pagamentos (move dinheiro)' },
      { key: 'supplier_invoice.read', name: 'Ver facturas de fornecedor' },
      {
        key: 'supplier_invoice.manage',
        name: 'Criar e alterar facturas de fornecedor em rascunho',
      },
      { key: 'supplier_invoice.validate', name: 'Validar e anular facturas de fornecedor' },
      {
        key: 'supplier_invoice.override',
        name: 'Validar uma factura com divergências, com justificação',
      },
    ],
    accessPermission: 'finance.read',
    features: [
      { id: 'treasury', name: 'Contas de tesouraria', description: 'Caixas, bancos e extractos.' },
      {
        id: 'obligations',
        name: 'Contas a receber e a pagar',
        description: 'Saldos derivados, créditos aplicados e exposição de crédito dos clientes.',
      },
      {
        id: 'payments',
        name: 'Pagamentos e recebimentos',
        description: 'Confirmação atómica, reversão e idempotência.',
      },
      {
        id: 'supplier_invoices',
        name: 'Facturas de fornecedor',
        description: 'Conferência a três vias e criação da conta a pagar.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Tesouraria',
        permission: 'finance.read',
        loadComponent: () => import('./treasury/treasury-page').then((m) => m.TreasuryPage),
      },
    ],
  }),
  defineModule({
    code: 'finance.receivables-payables',
    name: 'Contas a receber/pagar',
    description: 'Recebimentos e pagamentos pendentes.',
    group: 'finance',
    icon: 'card',
    dependencies: ['finance.cash-banks'],
    // As contas a receber e a pagar vivem na página «Tesouraria» do módulo anterior, que tem o mesmo acesso.
    routes: [
      {
        path: '',
        title: 'Contas a receber/pagar',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
  }),
  defineModule({
    code: 'finance.payments-budget',
    name: 'Pagamentos e orçamento',
    description: 'Execução de pagamentos e controlo orçamental.',
    group: 'finance',
    icon: 'card',
    dependencies: ['finance.receivables-payables'],
    // Os pagamentos vivem na página «Tesouraria»; o controlo orçamental ainda não existe.
    routes: [
      {
        path: '',
        title: 'Pagamentos e orçamento',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
  }),
] as const;
