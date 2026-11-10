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
    path: 'configuracao',
    title: 'Configuração do catálogo',
    canActivate: [accessGuard],
    data: { permission: 'inventory.read' },
    loadComponent: () => import('./catalog-settings').then((m) => m.CatalogSettings),
  },
];
