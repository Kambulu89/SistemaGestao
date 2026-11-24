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

const INVOICE_PERMISSIONS = [
  'sales.invoices.read',
  'sales.invoices.manage',
  'sales.invoices.issue',
];

const RECEIPT_PERMISSIONS = [
  'sales.receipts.read',
  'sales.receipts.manage',
  'sales.receipts.confirm',
];

const NOTE_PERMISSIONS = [
  'sales.notes.read',
  'sales.notes.manage',
  'sales.notes.issue',
  'sales.receipts.manage',
  'sales.receipts.confirm',
];

const FISCAL_PERMISSIONS = ['sales.fiscal.read', 'sales.fiscal.manage', 'sales.fiscal.confirm'];

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
  {
    path: 'fiscal',
    title: 'Fiscal',
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'impostos' },
      {
        path: 'impostos',
        title: 'Impostos e retenções',
        canActivate: [accessGuard],
        data: { anyOf: FISCAL_PERMISSIONS },
        loadComponent: () => import('./tax-codes').then((m) => m.TaxCodes),
      },
      {
        path: 'impostos/:id',
        title: 'Imposto',
        canActivate: [accessGuard],
        data: { anyOf: FISCAL_PERMISSIONS },
        loadComponent: () => import('./tax-code-detail').then((m) => m.TaxCodeDetail),
      },
      {
        path: 'isencoes',
        title: 'Motivos de isenção',
        canActivate: [accessGuard],
        data: { anyOf: FISCAL_PERMISSIONS },
        loadComponent: () => import('./tax-exemptions').then((m) => m.TaxExemptions),
      },
      {
        path: 'series',
        title: 'Séries fiscais',
        canActivate: [accessGuard],
        data: { anyOf: FISCAL_PERMISSIONS },
        loadComponent: () => import('./fiscal-series').then((m) => m.FiscalSeriesPage),
      },
      {
        path: 'simulacao',
        title: 'Simulação fiscal',
        canActivate: [accessGuard],
        data: { anyOf: FISCAL_PERMISSIONS },
        loadComponent: () => import('./tax-simulator').then((m) => m.TaxSimulator),
      },
      {
        path: 'integracao',
        title: 'Integração fiscal',
        canActivate: [accessGuard],
        data: { anyOf: ['sales.fiscal.read', 'sales.fiscal.manage'], anyScope: true },
        loadComponent: () => import('./fiscal-integration').then((m) => m.FiscalIntegrationPage),
      },
      {
        path: 'submissoes/:id',
        title: 'Comunicação fiscal',
        canActivate: [accessGuard],
        data: { anyOf: ['sales.fiscal.read', 'sales.fiscal.manage'], anyScope: true },
        loadComponent: () => import('./fiscal-submission').then((m) => m.FiscalSubmissionPage),
      },
    ],
  },
  {
    path: 'facturas',
    title: 'Facturas de venda',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: INVOICE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./invoices').then((m) => m.Invoices),
      },
      {
        path: 'nova',
        title: 'Nova factura',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.invoices.manage', anyScope: true },
        loadComponent: () => import('./invoice-form').then((m) => m.InvoiceFormPage),
      },
      {
        path: ':id',
        title: 'Factura',
        canActivate: [accessGuard],
        data: { anyOf: INVOICE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./invoice-detail').then((m) => m.InvoiceDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar factura',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.invoices.manage', anyScope: true },
        loadComponent: () => import('./invoice-form').then((m) => m.InvoiceFormPage),
      },
    ],
  },
  {
    path: 'recebimentos',
    title: 'Recebimentos',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: RECEIPT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./receipts').then((m) => m.Receipts),
      },
      {
        path: 'novo',
        title: 'Registar recebimento',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.receipts.manage', anyScope: true },
        loadComponent: () => import('./receipt-form').then((m) => m.ReceiptFormPage),
      },
      {
        path: ':id',
        title: 'Recebimento',
        canActivate: [accessGuard],
        data: { anyOf: RECEIPT_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./receipt-detail').then((m) => m.ReceiptDetail),
      },
    ],
  },
  {
    path: 'notas',
    title: 'Notas de crédito e débito',
    children: [
      {
        path: '',
        canActivate: [accessGuard],
        data: { anyOf: NOTE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./notes').then((m) => m.Notes),
      },
      {
        path: 'nova',
        title: 'Nova nota',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.notes.manage', anyScope: true },
        loadComponent: () => import('./note-form').then((m) => m.NoteFormPage),
      },
      {
        path: ':id',
        title: 'Nota',
        canActivate: [accessGuard],
        data: { anyOf: NOTE_PERMISSIONS, anyScope: true },
        loadComponent: () => import('./note-detail').then((m) => m.NoteDetail),
      },
      {
        path: ':id/editar',
        title: 'Editar nota',
        canActivate: [accessGuard],
        canDeactivate: [unsavedChangesGuard],
        data: { permission: 'sales.notes.manage', anyScope: true },
        loadComponent: () => import('./note-form').then((m) => m.NoteFormPage),
      },
    ],
  },
];
