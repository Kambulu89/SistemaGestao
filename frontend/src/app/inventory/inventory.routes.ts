import type { Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/** Inventário (Prompt 08). A API decide as permissões; a navegação filtrada é só usabilidade. */
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
