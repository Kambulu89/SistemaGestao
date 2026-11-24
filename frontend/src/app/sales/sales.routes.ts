import type { Route, Routes } from '@angular/router';
import { accessGuard } from '../core/guards';
import { unsavedChangesGuard } from '../core/unsaved';

/** Vendas e facturação (Prompt 10). A API decide as permissões; a navegação filtrada é só usabilidade. */
const CUSTOMER_PERMISSIONS = [
  'sales.customers.read',
  'sales.customers.manage',
  'sales.customers.credit',
];

const QUOTE_PERMISSIONS = ['sales.quotes.read', 'sales.quotes.manage', 'sales.quotes.approve'];

const ORDER_PERMISSIONS = [
  'sales.orders.read',
  'sales.orders.manage',
  'sales.orders.approve',
  'sales.orders.fulfil',
];

const PRICE_PERMISSIONS = ['sales.prices.read', 'sales.prices.manage', 'sales.prices.approve'];

type Load = NonNullable<Route['loadComponent']>;

const crud = (
  path: string,
  title: string,
  list: Load,
  form: Load,
  detail: Load,
  newTitle: string,
): Route => ({
  path,
  title,
  children: [
    {
      path: '',
      canActivate: [accessGuard],
      data: { anyOf: PRICE_PERMISSIONS },
      loadComponent: list,
    },
    {
      path: 'novo',
      title: newTitle,
      canActivate: [accessGuard],
      canDeactivate: [unsavedChangesGuard],
      data: { permission: 'sales.prices.manage' },
      loadComponent: form,
    },
    {
      path: ':id',
      canActivate: [accessGuard],
      data: { anyOf: PRICE_PERMISSIONS },
      loadComponent: detail,
    },
    {
      path: ':id/editar',
      title: 'Editar',
      canActivate: [accessGuard],
      canDeactivate: [unsavedChangesGuard],
      data: { permission: 'sales.prices.manage' },
      loadComponent: form,
    },
  ],
});

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
  crud(
    'precos',
    'Tabelas de preços',
    () => import('./price-lists').then((m) => m.PriceLists),
    () => import('./price-list-form').then((m) => m.PriceListFormPage),
    () => import('./price-list-detail').then((m) => m.PriceListDetail),
    'Nova tabela de preços',
  ),
  crud(
    'descontos',
    'Regras de desconto',
    () => import('./discount-rules').then((m) => m.DiscountRules),
    () => import('./discount-rule-form').then((m) => m.DiscountRuleFormPage),
    () => import('./discount-rule-detail').then((m) => m.DiscountRuleDetail),
    'Nova regra de desconto',
  ),
  {
    path: 'limites-desconto',
    title: 'Limites de desconto',
    canActivate: [accessGuard],
    data: { anyOf: PRICE_PERMISSIONS },
    loadComponent: () => import('./discount-limits').then((m) => m.DiscountLimits),
  },
  {
    path: 'consulta-precos',
    title: 'Consulta de preços',
    canActivate: [accessGuard],
    data: { anyOf: PRICE_PERMISSIONS },
    loadComponent: () => import('./price-check').then((m) => m.PriceCheck),
  },
  {
    path: 'orcamentos',
    title: 'Orçamentos',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: QUOTE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./quotes').then((m) => m.Quotes),
      },
      {
        path: 'novo',
        title: 'Novo orçamento',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.quotes.manage', anyScope: true },
        loadComponent: () => import('./quote-form').then((m) => m.QuoteFormPage),
      },
      {
        path: ':id',
        title: 'Orçamento',
        canActivate: [accessGuard],
        data: { anyOf: QUOTE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./quote-detail').then((m) => m.QuoteDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar orçamento',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.quotes.manage', anyScope: true },
        loadComponent: () => import('./quote-form').then((m) => m.QuoteFormPage),
      },
    ],
  },
  {
    path: 'encomendas',
    title: 'Encomendas de venda',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: ORDER_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./orders').then((m) => m.Orders),
      },
      {
        path: 'nova',
        title: 'Nova encomenda',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.orders.manage', anyScope: true },
        loadComponent: () => import('./order-form').then((m) => m.OrderFormPage),
      },
      {
        path: ':id',
        title: 'Encomenda',
        canActivate: [accessGuard],
        data: { anyOf: ORDER_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./order-detail').then((m) => m.OrderDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar encomenda',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.orders.manage', anyScope: true },
        loadComponent: () => import('./order-form').then((m) => m.OrderFormPage),
      },
    ],
  },
];
