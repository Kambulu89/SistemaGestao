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

const RFQ_PERMISSIONS = ['procurement.rfqs.read', 'procurement.rfqs.manage'];

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
