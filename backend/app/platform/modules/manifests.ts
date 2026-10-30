import type { TenantContext } from '#core/tenancy/index'
import type { ModuleManifest } from '#platform/modules/domain/module'

/**
 * Manifestos **entregues por código** (C03). Cada módulo de negócio acrescenta aqui o seu manifesto quando
 * existir no backend; nunca se regista um módulo que ainda não foi implementado. O tenant não define
 * manifestos nem SQL: só activa o que o registo contém.
 */
export const CODE_MANIFESTS: readonly ModuleManifest[] = [
  {
    code: 'core',
    name: 'Núcleo da plataforma',
    kind: 'FOUNDATION',
    releaseVersion: '0.3.0',
    minCoreVersion: '0.3.0',
    dependencies: [],
    features: [],
  },
  {
    code: 'catalog',
    name: 'Catálogo e preços',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [{ code: 'core', constraint: '*', optional: false }],
    features: [
      { code: 'catalog.products', name: 'Produtos, variantes e categorias', defaultEnabled: true },
      { code: 'catalog.prices', name: 'Tabelas de preços', defaultEnabled: true },
    ],
  },
  {
    code: 'customers',
    name: 'Clientes',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [{ code: 'core', constraint: '*', optional: false }],
    features: [
      { code: 'customers.accounts', name: 'Clientes e segmentos', defaultEnabled: true },
      { code: 'customers.interactions', name: 'Interacções comerciais', defaultEnabled: true },
    ],
  },
  {
    code: 'reporting',
    name: 'Relatórios, painéis e pesquisa',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [{ code: 'core', constraint: '*', optional: false }],
    features: [
      { code: 'reporting.reports', name: 'Relatórios sobre datasets', defaultEnabled: true },
      { code: 'reporting.dashboards', name: 'Painéis com widgets', defaultEnabled: true },
      { code: 'reporting.exports', name: 'Exportações assíncronas (CSV)', defaultEnabled: true },
      { code: 'reporting.search', name: 'Pesquisa global', defaultEnabled: true },
    ],
  },
  {
    code: 'documents',
    name: 'Documentos, anexos e modelos',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [{ code: 'core', constraint: '*', optional: false }],
    features: [
      {
        code: 'documents.library',
        name: 'Biblioteca de documentos, versões e anexos',
        defaultEnabled: true,
      },
      {
        code: 'documents.templates',
        name: 'Modelos de documento e geração de PDF',
        defaultEnabled: true,
      },
    ],
  },
  {
    code: 'notifications',
    name: 'Notificações e comunicação',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [{ code: 'core', constraint: '*', optional: false }],
    features: [
      {
        code: 'notifications.center',
        name: 'Centro de notificações e preferências',
        defaultEnabled: true,
      },
      {
        code: 'notifications.delivery',
        name: 'Entregas por canal e administração',
        defaultEnabled: true,
      },
    ],
  },
  {
    code: 'prospecting',
    name: 'Prospecção e CRM',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'customers', constraint: '*', optional: false },
    ],
    features: [
      { code: 'prospecting.leads', name: 'Leads', defaultEnabled: true },
      { code: 'prospecting.opportunities', name: 'Pipeline e oportunidades', defaultEnabled: true },
      { code: 'prospecting.campaigns', name: 'Campanhas', defaultEnabled: true },
    ],
  },
  {
    code: 'orders',
    name: 'Propostas e encomendas',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'catalog', constraint: '*', optional: false },
      { code: 'customers', constraint: '*', optional: false },
    ],
    features: [
      { code: 'orders.quotes', name: 'Propostas comerciais', defaultEnabled: true },
      { code: 'orders.orders', name: 'Encomendas de venda', defaultEnabled: true },
      { code: 'orders.shipments', name: 'Expedições', defaultEnabled: true },
    ],
  },
  {
    code: 'invoicing',
    name: 'Facturação e contratos',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'customers', constraint: '*', optional: false },
      { code: 'orders', constraint: '*', optional: true },
    ],
    features: [
      { code: 'invoicing.contracts', name: 'Contratos', defaultEnabled: true },
      { code: 'invoicing.invoices', name: 'Facturas e notas de crédito', defaultEnabled: true },
    ],
  },
  {
    code: 'procurement',
    name: 'Compras',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'catalog', constraint: '*', optional: false },
      { code: 'inventory', constraint: '*', optional: true },
    ],
    features: [
      { code: 'procurement.suppliers', name: 'Fornecedores', defaultEnabled: true },
      { code: 'procurement.requisitions', name: 'Requisições de compra', defaultEnabled: true },
      { code: 'procurement.orders', name: 'Encomendas a fornecedor', defaultEnabled: true },
      { code: 'procurement.receipts', name: 'Recepções de mercadoria', defaultEnabled: true },
    ],
  },
  {
    code: 'finance',
    name: 'Tesouraria, contas a receber e a pagar',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'customers', constraint: '*', optional: true },
      { code: 'orders', constraint: '*', optional: true },
      { code: 'invoicing', constraint: '*', optional: true },
      { code: 'procurement', constraint: '*', optional: true },
    ],
    features: [
      { code: 'finance.treasury', name: 'Contas de tesouraria', defaultEnabled: true },
      {
        code: 'finance.obligations',
        name: 'Contas a receber e a pagar',
        defaultEnabled: true,
      },
      { code: 'finance.payments', name: 'Pagamentos e recebimentos', defaultEnabled: true },
      { code: 'finance.reconciliation', name: 'Conciliação bancária', defaultEnabled: true },
      {
        code: 'finance.supplier_invoices',
        name: 'Facturas de fornecedor',
        defaultEnabled: true,
      },
    ],
  },
  {
    code: 'inventory',
    name: 'Inventário',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'catalog', constraint: '*', optional: false },
    ],
    features: [
      { code: 'inventory.warehouses', name: 'Armazéns e locais', defaultEnabled: true },
      {
        code: 'inventory.stock',
        name: 'Stock, movimentos, lotes e reservas',
        defaultEnabled: true,
      },
      { code: 'inventory.transfers', name: 'Transferências entre armazéns', defaultEnabled: true },
      { code: 'inventory.counts', name: 'Contagens físicas', defaultEnabled: true },
      { code: 'inventory.returns', name: 'Devoluções', defaultEnabled: true },
    ],
  },
]

/** Activadores por módulo (sementes e configuração inicial do tenant). Idempotentes; vazio até haver módulos. */
export const MODULE_ACTIVATORS: Readonly<
  Record<string, (context: TenantContext) => Promise<void>>
> = {}
