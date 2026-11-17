import type { Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/** Compras (Prompt 09). A API decide as permissões; a navegação filtrada é só usabilidade. */
const SUPPLIER_PERMISSIONS = [
  'procurement.suppliers.read',
  'procurement.suppliers.manage',
  'procurement.suppliers.approve',
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
    path: 'configuracao',
    title: 'Configuração das compras',
    canActivate: [accessGuard],
    data: { anyOf: [...SUPPLIER_PERMISSIONS, 'procurement.settings'] },
    loadComponent: () => import('./procurement-settings').then((m) => m.ProcurementSettings),
  },
];
