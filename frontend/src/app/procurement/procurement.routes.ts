import type { Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/** Compras (Prompt 09). A API decide as permissões; a navegação filtrada é só usabilidade. */
const SUPPLIER_PERMISSIONS = [
  'procurement.suppliers.read',
  'procurement.suppliers.manage',
  'procurement.suppliers.approve',
];

const REQUISITION_PERMISSIONS = [
  'procurement.requisitions.request',
  'procurement.requisitions.approve',
  'procurement.requisitions.process',
];

const RFQ_PERMISSIONS = [
  'procurement.rfqs.read',
  'procurement.rfqs.manage',
  'procurement.rfqs.approve',
];

const ORDER_PERMISSIONS = [
  'procurement.orders.read',
  'procurement.orders.manage',
  'procurement.orders.approve',
];

const EVALUATION_PERMISSIONS = ['procurement.evaluations.read', 'procurement.evaluations.manage'];

const PAYABLE_PERMISSIONS = ['procurement.payables.read', 'procurement.payables.pay'];

const RETURN_PERMISSIONS = ['procurement.returns.read', 'procurement.returns.manage'];

const CREDIT_NOTE_PERMISSIONS = ['procurement.invoices.read', 'procurement.invoices.manage'];

const CONTRACT_PERMISSIONS = [
  'procurement.contracts.read',
  'procurement.contracts.manage',
  'procurement.contracts.approve',
];

const RECEIPT_PERMISSIONS = ['procurement.receipts.read', 'procurement.receipts.manage'];

const INVOICE_PERMISSIONS = [
  'procurement.invoices.read',
  'procurement.invoices.manage',
  'procurement.invoices.approve',
];

export const PROCUREMENT_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'fornecedores' },
  {
    path: 'fornecedores',
    title: 'Fornecedores',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: SUPPLIER_PERMISSIONS },
        loadComponent: () => import('./suppliers').then((m) => m.Suppliers),
      },
      {
        path: 'novo',
        title: 'Novo fornecedor',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.suppliers.manage' },
        loadComponent: () => import('./supplier-form').then((m) => m.SupplierFormPage),
      },
      {
        path: ':id',
        title: 'Fornecedor',
        canActivate: [accessGuard],
        data: { anyOf: SUPPLIER_PERMISSIONS },
        loadComponent: () => import('./supplier-detail').then((m) => m.SupplierDetailPage),
      },
      {
        path: ':id/editar',
        title: 'Editar fornecedor',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.suppliers.manage' },
        loadComponent: () => import('./supplier-form').then((m) => m.SupplierFormPage),
      },
    ],
  },
  {
    path: 'requisicoes',
    title: 'Requisições de compra',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: REQUISITION_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./requisitions').then((m) => m.PurchaseRequisitions),
      },
      {
        path: 'necessidades',
        title: 'Necessidades consolidadas',
        canActivate: [accessGuard],
        data: { permission: 'procurement.requisitions.process', anyScope: true },
        loadComponent: () => import('./requisition-demand').then((m) => m.RequisitionDemand),
      },
      {
        path: 'nova',
        title: 'Nova requisição',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.requisitions.request', anyScope: true },
        loadComponent: () => import('./requisition-form').then((m) => m.PurchaseRequisitionForm),
      },
      {
        path: ':id',
        title: 'Requisição',
        canActivate: [accessGuard],
        data: { anyOf: REQUISITION_PERMISSIONS, anyScope: true },
        loadComponent: () =>
          import('./requisition-detail').then((m) => m.PurchaseRequisitionDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar requisição',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.requisitions.request', anyScope: true },
        loadComponent: () => import('./requisition-form').then((m) => m.PurchaseRequisitionForm),
      },
    ],
  },
  {
    path: 'cotacoes',
    title: 'Pedidos de cotação',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: RFQ_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./rfqs').then((m) => m.Rfqs),
      },
      {
        path: 'nova',
        title: 'Novo pedido de cotação',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.rfqs.manage', anyScope: true },
        loadComponent: () => import('./rfq-form').then((m) => m.RfqForm),
      },
      {
        path: ':id',
        title: 'Pedido de cotação',
        canActivate: [accessGuard],
        data: { anyOf: RFQ_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./rfq-detail').then((m) => m.RfqDetail),
      },
      {
        path: ':id/adjudicacao',
        title: 'Mapa comparativo',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { anyOf: RFQ_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./rfq-award-form').then((m) => m.RfqAwardForm),
      },
      {
        path: ':id/editar',
        title: 'Editar pedido de cotação',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.rfqs.manage', anyScope: true },
        loadComponent: () => import('./rfq-form').then((m) => m.RfqForm),
      },
    ],
  },
  {
    path: 'ordens',
    title: 'Ordens de compra',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: ORDER_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./orders').then((m) => m.PurchaseOrders),
      },
      {
        path: 'nova',
        title: 'Nova ordem de compra',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.orders.manage', anyScope: true },
        loadComponent: () => import('./order-form').then((m) => m.PurchaseOrderForm),
      },
      {
        path: ':id',
        title: 'Ordem de compra',
        canActivate: [accessGuard],
        data: { anyOf: ORDER_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./order-detail').then((m) => m.PurchaseOrderDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar ordem de compra',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.orders.manage', anyScope: true },
        loadComponent: () => import('./order-form').then((m) => m.PurchaseOrderForm),
      },
    ],
  },
  {
    path: 'contratos',
    title: 'Contratos de fornecedor',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: CONTRACT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./contracts').then((m) => m.Contracts),
      },
      {
        path: 'novo',
        title: 'Novo contrato',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.contracts.manage', anyScope: true },
        loadComponent: () => import('./contract-form').then((m) => m.ContractForm),
      },
      {
        path: ':id',
        title: 'Contrato',
        canActivate: [accessGuard],
        data: { anyOf: CONTRACT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./contract-detail').then((m) => m.ContractDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar contrato',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.contracts.manage', anyScope: true },
        loadComponent: () => import('./contract-form').then((m) => m.ContractForm),
      },
      {
        path: ':id/adenda',
        title: 'Adenda ao contrato',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.contracts.manage', anyScope: true, mode: 'amend' },
        loadComponent: () => import('./contract-form').then((m) => m.ContractForm),
      },
    ],
  },
  {
    path: 'entregas-previstas',
    title: 'Entregas previstas',
    canActivate: [accessGuard],
    data: { anyOf: RECEIPT_PERMISSIONS, anyScope: true },
    loadComponent: () => import('./expected-deliveries').then((m) => m.ExpectedDeliveries),
  },
  {
    path: 'recepcoes',
    title: 'Recepções de compra',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: RECEIPT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./receipts').then((m) => m.Receipts),
      },
      {
        path: 'nova',
        title: 'Nova recepção',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.receipts.manage', anyScope: true },
        loadComponent: () => import('./receipt-form').then((m) => m.ReceiptForm),
      },
      {
        path: ':id',
        title: 'Recepção',
        canActivate: [accessGuard],
        data: { anyOf: RECEIPT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./receipt-detail').then((m) => m.ReceiptDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar recepção',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.receipts.manage', anyScope: true },
        loadComponent: () => import('./receipt-form').then((m) => m.ReceiptForm),
      },
    ],
  },
  {
    path: 'facturas',
    title: 'Facturas de fornecedor',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: INVOICE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./invoices').then((m) => m.Invoices),
      },
      {
        path: 'nova',
        title: 'Registar factura',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.invoices.manage', anyScope: true },
        loadComponent: () => import('./invoice-form').then((m) => m.InvoiceForm),
      },
      {
        path: ':id',
        title: 'Factura de fornecedor',
        canActivate: [accessGuard],
        data: { anyOf: INVOICE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./invoice-detail').then((m) => m.InvoiceDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar factura',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.invoices.manage', anyScope: true },
        loadComponent: () => import('./invoice-form').then((m) => m.InvoiceForm),
      },
    ],
  },
  {
    path: 'avaliacao',
    title: 'Avaliação de fornecedores',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: EVALUATION_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./supplier-evaluations').then((m) => m.SupplierEvaluations),
      },
      {
        path: ':id',
        title: 'Avaliação do fornecedor',
        canActivate: [accessGuard],
        data: { anyOf: EVALUATION_PERMISSIONS, anyScope: true },
        loadComponent: () =>
          import('./supplier-evaluation').then((m) => m.SupplierEvaluationDetail),
      },
    ],
  },
  {
    path: 'obrigacoes',
    title: 'Obrigações a pagar',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: PAYABLE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./payables').then((m) => m.Payables),
      },
      {
        path: ':id',
        title: 'Obrigação a pagar',
        canActivate: [accessGuard],
        data: { anyOf: PAYABLE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./payable-detail').then((m) => m.PayableDetail),
      },
    ],
  },
  {
    path: 'orcamento',
    title: 'Orçamento de compras',
    canActivate: [accessGuard],
    data: {
      anyOf: ['procurement.budgets.read', 'procurement.budgets.manage'],
      anyScope: true,
    },
    loadComponent: () => import('./budgets').then((m) => m.Budgets),
  },
  {
    path: 'devolucoes',
    title: 'Devoluções a fornecedor',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: RETURN_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./returns').then((m) => m.Returns),
      },
      {
        path: 'nova',
        title: 'Registar devolução',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.returns.manage', anyScope: true },
        loadComponent: () => import('./return-form').then((m) => m.ReturnForm),
      },
      {
        path: ':id',
        title: 'Devolução a fornecedor',
        canActivate: [accessGuard],
        data: { anyOf: RETURN_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./return-detail').then((m) => m.ReturnDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar devolução',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.returns.manage', anyScope: true },
        loadComponent: () => import('./return-form').then((m) => m.ReturnForm),
      },
    ],
  },
  {
    path: 'notas-credito',
    title: 'Notas de crédito de fornecedor',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: CREDIT_NOTE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./credit-notes').then((m) => m.CreditNotes),
      },
      {
        path: 'nova',
        title: 'Registar nota de crédito',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.invoices.manage', anyScope: true },
        loadComponent: () => import('./credit-note-form').then((m) => m.CreditNoteForm),
      },
      {
        path: ':id',
        title: 'Nota de crédito',
        canActivate: [accessGuard],
        data: { anyOf: CREDIT_NOTE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./credit-note-detail').then((m) => m.CreditNoteDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar nota de crédito',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'procurement.invoices.manage', anyScope: true },
        loadComponent: () => import('./credit-note-form').then((m) => m.CreditNoteForm),
      },
    ],
  },
  {
    path: 'adjudicacoes/:id',
    title: 'Adjudicação',
    canActivate: [accessGuard],
    data: { anyOf: RFQ_PERMISSIONS, anyScope: true },
    loadComponent: () => import('./rfq-award-detail').then((m) => m.RfqAwardDetail),
  },
  {
    path: 'configuracao/tolerancias',
    title: 'Tolerâncias da conferência',
    canActivate: [accessGuard],
    canDeactivate: [unsavedChangesGuard],
    data: { permission: 'procurement.settings' },
    loadComponent: () => import('./tolerances').then((m) => m.ToleranceSettings),
  },
  {
    path: 'configuracao/etapas',
    title: 'Etapas de aprovação das compras',
    canActivate: [accessGuard],
    data: { permission: 'procurement.settings' },
    loadComponent: () => import('./approval-levels').then((m) => m.ApprovalLevels),
  },
  {
    path: 'configuracao',
    title: 'Configuração das compras',
    canActivate: [accessGuard],
    data: { anyOf: [...SUPPLIER_PERMISSIONS, 'procurement.settings'] },
    loadComponent: () => import('./procurement-settings').then((m) => m.ProcurementSettings),
  },
];
