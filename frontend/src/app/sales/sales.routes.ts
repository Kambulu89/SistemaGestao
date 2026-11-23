import type { Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/** Vendas e facturação (Prompt 10). A API decide as permissões; a navegação filtrada é só usabilidade. */
const CUSTOMER_PERMISSIONS = [
  'sales.customers.read',
  'sales.customers.manage',
  'sales.customers.credit',
];

export const SALES_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'clientes' },
  {
    path: 'clientes',
    title: 'Clientes',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: CUSTOMER_PERMISSIONS },
        loadComponent: () => import('./customers').then((m) => m.Customers),
      },
      {
        path: 'novo',
        title: 'Novo cliente',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.customers.manage' },
        loadComponent: () => import('./customer-form').then((m) => m.CustomerFormPage),
      },
      {
        path: ':id',
        title: 'Cliente',
        canActivate: [accessGuard],
        data: { anyOf: CUSTOMER_PERMISSIONS },
        loadComponent: () => import('./customer-detail').then((m) => m.CustomerDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar cliente',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.customers.manage' },
        loadComponent: () => import('./customer-form').then((m) => m.CustomerFormPage),
      },
    ],
  },
  {
    path: 'segmentos',
    title: 'Segmentos de clientes',
    canActivate: [accessGuard],
    data: { anyOf: [...CUSTOMER_PERMISSIONS, 'sales.settings'] },
    loadComponent: () => import('./segments').then((m) => m.CustomerSegments),
  },
];
