import type { Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/** Inventário (Prompt 08). A API decide as permissões; a navegação filtrada é só usabilidade. */
const REQUISITION_PERMISSIONS = [
  'inventory.requisitions.request',
  'inventory.requisitions.approve',
  'inventory.requisitions.fulfil',
];

const VALUATION_PERMISSIONS = ['inventory.valuation.read', 'inventory.valuation.manage'];
const INTEGRATION_PERMISSIONS = [
  'inventory.valuation.read',
  'inventory.accounting.manage',
  'inventory.integrations.post',
];
const COUNT_PERMISSIONS = ['inventory.counts.manage', 'inventory.counts.approve'];

export const INVENTORY_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'produtos' },
  {
    path: 'produtos',
    title: 'Produtos e serviços',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read' },
        loadComponent: () => import('./products').then((m) => m.Products),
      },
      {
        path: 'novo',
        title: 'Novo produto',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.products.manage' },
        loadComponent: () => import('./product-form').then((m) => m.ProductFormPage),
      },
      {
        path: ':id',
        title: 'Produto',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.read' },
        loadComponent: () => import('./product-form').then((m) => m.ProductFormPage),
      },
    ],
  },
  {
    path: 'armazens',
    title: 'Armazéns',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./warehouses').then((m) => m.Warehouses),
      },
      {
        path: 'novo',
        title: 'Novo armazém',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.warehouses.manage', anyScope: true },
        loadComponent: () => import('./warehouse-form').then((m) => m.WarehouseFormPage),
      },
      {
        path: ':id',
        title: 'Armazém',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./warehouse-form').then((m) => m.WarehouseFormPage),
      },
    ],
  },
  {
    path: 'documentos',
    title: 'Entradas e saídas',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./stock-documents').then((m) => m.StockDocuments),
      },
      {
        path: 'novo',
        title: 'Novo documento',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.documents.manage', anyScope: true },
        loadComponent: () => import('./stock-document-form').then((m) => m.StockDocumentFormPage),
      },
      {
        path: ':id',
        title: 'Documento de stock',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./stock-document-form').then((m) => m.StockDocumentFormPage),
      },
    ],
  },
  {
    path: 'transferencias',
    title: 'Transferências',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./transfers').then((m) => m.Transfers),
      },
      {
        path: 'nova',
        title: 'Nova transferência',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.transfers.manage', anyScope: true },
        loadComponent: () => import('./transfer-form').then((m) => m.TransferFormPage),
      },
      {
        path: ':id',
        title: 'Transferência',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./transfer-form').then((m) => m.TransferFormPage),
      },
    ],
  },
  {
    path: 'requisicoes',
    title: 'Requisições internas',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: REQUISITION_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./requisitions').then((m) => m.Requisitions),
      },
      {
        path: 'nova',
        title: 'Nova requisição',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.requisitions.request', anyScope: true },
        loadComponent: () => import('./requisition-form').then((m) => m.RequisitionFormPage),
      },
      {
        path: ':id',
        title: 'Requisição',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { anyOf: REQUISITION_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./requisition-form').then((m) => m.RequisitionFormPage),
      },
    ],
  },
  {
    path: 'contagens',
    title: 'Contagens e ajustes',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: COUNT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./counts').then((m) => m.Counts),
      },
      {
        path: 'nova',
        title: 'Nova contagem',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'inventory.counts.manage', anyScope: true },
        loadComponent: () => import('./count-form').then((m) => m.CountFormPage),
      },
      {
        path: ':id',
        title: 'Contagem',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { anyOf: COUNT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./count-form').then((m) => m.CountFormPage),
      },
    ],
  },
  {
    path: 'lotes',
    title: 'Lotes',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./lots').then((m) => m.Lots),
      },
      {
        path: ':id',
        title: 'Lote',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./lot-detail').then((m) => m.LotDetailPage),
      },
    ],
  },
  {
    path: 'series',
    title: 'Números de série',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./serials').then((m) => m.Serials),
      },
      {
        path: ':id',
        title: 'Série',
        canActivate: [accessGuard],
        data: { permission: 'inventory.read', anyScope: true },
        loadComponent: () => import('./serial-detail').then((m) => m.SerialDetailPage),
      },
    ],
  },
  {
    path: 'valorizacao',
    title: 'Valorização',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: VALUATION_PERMISSIONS },
        loadComponent: () => import('./valuation').then((m) => m.Valuation),
      },
      {
        path: 'reconciliacao',
        title: 'Reconciliação',
        canActivate: [accessGuard],
        data: { anyOf: VALUATION_PERMISSIONS },
        loadComponent: () =>
          import('./valuation-reconciliation').then((m) => m.ValuationReconciliation),
      },
      {
        path: ':legalEntityId/:productId',
        title: 'Valorização do produto',
        canActivate: [accessGuard],
        data: { anyOf: VALUATION_PERMISSIONS },
        loadComponent: () => import('./valuation-detail').then((m) => m.ValuationDetailPage),
      },
    ],
  },
  {
    path: 'relatorios',
    title: 'Alertas e relatórios',
    canActivate: [accessGuard],
    data: { permission: 'inventory.read', anyScope: true },
    loadComponent: () => import('./reports').then((m) => m.InventoryReports),
  },
  {
    path: 'integracoes',
    title: 'Integrações e contabilização',
    canActivate: [accessGuard],
    data: { anyOf: INTEGRATION_PERMISSIONS },
    loadComponent: () => import('./integrations').then((m) => m.Integrations),
  },
  {
    path: 'reservas',
    title: 'Reservas activas',
    canActivate: [accessGuard],
    data: { permission: 'inventory.read', anyScope: true },
    loadComponent: () => import('./reservations').then((m) => m.Reservations),
  },
  {
    path: 'stock',
    title: 'Stock',
    canActivate: [accessGuard],
    data: { permission: 'inventory.read', anyScope: true },
    loadComponent: () => import('./stock').then((m) => m.Stock),
  },
  {
    path: 'movimentos',
    title: 'Movimentos de stock',
    canActivate: [accessGuard],
    data: { permission: 'inventory.read', anyScope: true },
    loadComponent: () => import('./stock-movements').then((m) => m.StockMovements),
  },
  {
    path: 'configuracao',
    title: 'Configuração do catálogo',
    canActivate: [accessGuard],
    data: { permission: 'inventory.read' },
    loadComponent: () => import('./catalog-settings').then((m) => m.CatalogSettings),
  },
];
