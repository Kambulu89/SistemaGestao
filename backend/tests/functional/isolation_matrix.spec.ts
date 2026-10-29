import { readFileSync } from 'node:fs'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { parse } from 'yaml'
import { iamServices } from '#core/permissions/index'
import { PLATFORM_TABLES } from '#core/tenancy/domain/platform_tables'
import { ChangeTenantStatus, LucidTenantStore } from '#platform/tenants/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, login, newActor, type Actor } from '#tests/support/api_fixture'
import {
  SHARED,
  buildWorld,
  crossTenantUser,
  grantAdmin,
  type World,
} from '#tests/support/matrix_fixture'

/**
 * MATRIZ DE ISOLAMENTO (fatia 1.9). Dois tenants com os MESMOS códigos, nomes e identificações, cada um
 * com todas as entidades de tenant. Nada do que um tenant faz, vê ou referencia pode atingir o outro:
 * API (ids alheios, referências cruzadas, varrimento de todas as rotas), base de dados (RLS, FKs
 * compostas) e Redis. A cobertura é automática: se aparecer uma rota de tenant no OpenAPI ou uma
 * tabela com `tenant_id` sem dados no cenário, esta suite falha.
 */

const UUID0 = '00000000-0000-4000-8000-000000000000'
const WRITES = new Set(['post', 'put', 'patch', 'delete'])

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

function call(
  client: any,
  method: Method,
  url: string,
  options: { actor?: Actor; tenantId?: string; csrf?: string; body?: unknown } = {}
) {
  const request = client[method](`/api/v1${url}`)
  if (options.actor) request.header('cookie', options.actor.cookie)
  if (options.tenantId) request.header('x-tenant-id', options.tenantId)
  if (WRITES.has(method)) {
    const csrf = options.csrf ?? options.actor?.csrf
    if (csrf) request.header('x-csrf-token', csrf)
    request.json(options.body ?? {})
  }
  return request as Promise<import('@japa/api-client').ApiResponse>
}

let cached: { a: World; b: World } | undefined

/** Constrói (uma vez) os dois tenants do cenário; o cliente HTTP só existe dentro de um teste. */
async function worlds(client: any): Promise<{ a: World; b: World }> {
  if (!cached) {
    await iamServices().syncCatalog.execute()
    await resetAuthState()
    const a = await buildWorld(client, 'A')
    const b = await buildWorld(client, 'B')
    cached = { a, b }
  }
  return cached
}

async function snapshot(world: World) {
  const get = async (url: string) => (await world.http.get(url)).body().data
  return {
    roles: await get('/api/v1/roles'),
    assignments: await get('/api/v1/role-assignments'),
    policies: await get('/api/v1/access-policies'),
    organizations: await get('/api/v1/organizations'),
    units: await get('/api/v1/organization-units'),
    costCenters: await get('/api/v1/cost-centers'),
    scopes: await get('/api/v1/membership-scopes'),
    members: await get('/api/v1/memberships'),
    invitations: await get('/api/v1/invitations'),
    parties: await get('/api/v1/parties'),
    party: await get(`/api/v1/parties/${world.ids.personParty}`),
    orgParty: await get(`/api/v1/parties/${world.ids.organizationParty}`),
    team: await get(`/api/v1/organization-units/${world.ids.unitRoot}/members`),
    preferences: await get('/api/v1/me/preferences'),
    entities: await get('/api/v1/entity-definitions'),
    entity: await get(`/api/v1/entity-definitions/${world.ids.entity}`),
    rules: await get('/api/v1/rules'),
    evaluations: await get(`/api/v1/rules/${world.ids.rule}/evaluations`),
    forms: await get('/api/v1/forms'),
    publishedForms: await get(`/api/v1/dynamic/${SHARED.entityCode}/forms`),
    machines: await get('/api/v1/state-machines'),
    stateHistory: await get(
      `/api/v1/dynamic/${SHARED.entityCode}/records/${world.ids.stateRecord}/state-history`
    ),
    workflows: await get('/api/v1/workflows'),
    instances: await get('/api/v1/workflow-instances'),
    inbox: await get('/api/v1/approval-tasks'),
    delegations: await get('/api/v1/approval-delegations'),
    automations: await get('/api/v1/automations'),
    automationRuns: await get('/api/v1/automation-runs'),
    categories: await get('/api/v1/product-categories'),
    products: await get('/api/v1/products'),
    variants: await get(`/api/v1/products/${world.ids.product}/variants`),
    priceLists: await get('/api/v1/price-lists'),
    priceList: await get(`/api/v1/price-lists/${world.ids.priceList}`),
    customers: await get('/api/v1/customers'),
    customer: await get(`/api/v1/customers/${world.ids.customer}`),
    segments: await get('/api/v1/customer-segments'),
    interactions: await get('/api/v1/interactions'),
    quotes: await get('/api/v1/quotes'),
    quote: await get(`/api/v1/quotes/${world.ids.quote}`),
    salesOrders: await get('/api/v1/sales-orders'),
    salesOrder: await get(`/api/v1/sales-orders/${world.ids.order}`),
    shipments: await get('/api/v1/shipments'),
    shipment: await get(`/api/v1/shipments/${world.ids.shipment}`),
    suppliers: await get('/api/v1/suppliers'),
    supplier: await get(`/api/v1/suppliers/${world.ids.supplier}`),
    requisitions: await get('/api/v1/purchase-requisitions'),
    requisition: await get(`/api/v1/purchase-requisitions/${world.ids.requisition}`),
    purchases: await get('/api/v1/purchase-orders'),
    purchase: await get(`/api/v1/purchase-orders/${world.ids.purchase}`),
    receipts: await get('/api/v1/goods-receipts'),
    receipt: await get(`/api/v1/goods-receipts/${world.ids.goodsReceipt}`),
    treasuryAccounts: await get('/api/v1/treasury-accounts'),
    treasuryAccount: await get(`/api/v1/treasury-accounts/${world.ids.treasuryAccount}`),
    entries: await get(`/api/v1/treasury-accounts/${world.ids.treasuryAccount}/entries`),
    reconLines: await get(`/api/v1/reconciliations/lines?accountId=${world.ids.bankAccount}`),
    reconLine: await get(`/api/v1/reconciliations/lines/${world.ids.statementLine}`),
    reconEntries: await get(`/api/v1/reconciliations/entries?accountId=${world.ids.bankAccount}`),
    reconBatches: await get(`/api/v1/reconciliations/batches?accountId=${world.ids.bankAccount}`),
    reconSummary: await get(`/api/v1/reconciliations/summary?accountId=${world.ids.bankAccount}`),
    stages: await get('/api/v1/pipeline-stages'),
    leads: await get('/api/v1/leads'),
    lead: await get(`/api/v1/leads/${world.ids.lead}`),
    opportunities: await get('/api/v1/opportunities'),
    opportunity: await get(`/api/v1/opportunities/${world.ids.opportunity}`),
    opportunityMetrics: await get('/api/v1/opportunities/metrics'),
    campaigns: await get('/api/v1/campaigns'),
    campaign: await get(`/api/v1/campaigns/${world.ids.campaign}`),
    campaignMembers: await get(`/api/v1/campaigns/${world.ids.campaign}/members`),
    exclusions: await get('/api/v1/marketing-exclusions'),
    notifications: await get('/api/v1/notifications'),
    notificationDeliveries: await get('/api/v1/notification-deliveries'),
    notificationPreferences: await get('/api/v1/notification-preferences'),
    receivables: await get('/api/v1/receivables'),
    receivable: await get(`/api/v1/receivables/${world.ids.receivable}`),
    payables: await get('/api/v1/payables'),
    payable: await get(`/api/v1/payables/${world.ids.payable}`),
    customerCredit: await get(`/api/v1/customers/${world.ids.customer}/credit`),
    payments: await get('/api/v1/payments'),
    payment: await get(`/api/v1/payments/${world.ids.payment}`),
    supplierInvoices: await get('/api/v1/supplier-invoices'),
    supplierInvoice: await get(`/api/v1/supplier-invoices/${world.ids.supplierInvoice}`),
    transfers: await get('/api/v1/stock-transfers'),
    transfer: await get(`/api/v1/stock-transfers/${world.ids.transfer}`),
    counts: await get('/api/v1/stock-counts'),
    count: await get(`/api/v1/stock-counts/${world.ids.count}`),
    returns: await get('/api/v1/goods-returns'),
    goodsReturn: await get(`/api/v1/goods-returns/${world.ids.goodsReturn}`),
    contracts: await get('/api/v1/contracts'),
    contract: await get(`/api/v1/contracts/${world.ids.contract}`),
    invoices: await get('/api/v1/invoices'),
    invoice: await get(`/api/v1/invoices/${world.ids.invoice}`),
    creditNotes: await get('/api/v1/credit-notes'),
    creditNote: await get(`/api/v1/credit-notes/${world.ids.creditNote}`),
    billable: await get(`/api/v1/sales-orders/${world.ids.order}/billable`),
    warehouses: await get('/api/v1/warehouses'),
    warehouse: await get(`/api/v1/warehouses/${world.ids.warehouse}`),
    balances: await get('/api/v1/stock-balances'),
    movements: await get('/api/v1/stock-movements'),
    lots: await get('/api/v1/lots'),
    reservations: await get('/api/v1/stock-reservations'),
    records: await get(`/api/v1/dynamic/${SHARED.entityCode}/records`),
  }
}

const idsOf = (value: unknown): string[] => {
  const found: string[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'id' && typeof child === 'string') found.push(child)
        else walk(child)
      }
    }
  }
  walk(value)
  return found
}

/** Pedidos de `me` sobre as entidades de `other`: todos têm de ser 404 (nunca 200, nunca 403). */
function foreignIdCases(me: World, other: World): [Method, string, unknown?][] {
  const o = other.ids
  const m = other.admin.membershipId
  const stale = { expectedVersion: 1 }
  return [
    ['get', `/roles/${o.role}`],
    ['patch', `/roles/${o.role}`, { ...stale, name: 'x' }],
    ['delete', `/roles/${o.role}`],
    ['delete', `/role-assignments/${o.assignment}`],
    ['patch', `/access-policies/${o.policy}`, { ...stale, name: 'x' }],
    ['get', `/organizations/${o.organization}`],
    ['patch', `/organizations/${o.organization}`, { ...stale, tradeName: 'x' }],
    ['get', `/organization-units/${o.unitRoot}`],
    ['patch', `/organization-units/${o.unitRoot}`, { ...stale, name: 'x' }],
    ['get', `/organization-units/${o.unitRoot}/members`],
    [
      'post',
      `/organization-units/${o.unitRoot}/members`,
      { membershipId: me.admin.membershipId, startsOn: '2026-01-01' },
    ],
    ['delete', `/team-members/${o.teamMember}`],
    ['patch', `/cost-centers/${o.costCenter}`, { ...stale, name: 'x' }],
    ['delete', `/membership-scopes/${o.scope}`],
    ['get', `/memberships/${m}`],
    ['patch', `/memberships/${m}`, { ...stale, status: 'SUSPENDED' }],
    ['put', `/memberships/${m}/person`, { partyId: null }],
    ['post', `/invitations/${o.invitation}/revoke`],
    ['patch', `/tax-rates/${o.taxRate}`, { ...stale, name: 'x' }],
    ['patch', `/units/${o.unit}`, { ...stale, name: 'x' }],
    ['patch', `/sequences/${o.sequence}`, { ...stale, padding: 8 }],
    ['get', `/rules/${o.rule}`],
    ['get', `/rules/${o.rule}/evaluations`],
    ['patch', `/rules/${o.rule}`, { ...stale, name: 'x' }],
    ['post', `/rules/${o.rule}/revisions`],
    ['post', `/rules/${o.rule}/simulate`, { values: {} }],
    ['post', `/rules/${o.rule}/publish`, stale],
    ['post', `/rules/${o.rule}/disable`, stale],
    ['get', `/forms/${o.form}`],
    ['patch', `/forms/${o.form}`, { ...stale, name: 'x' }],
    ['post', `/forms/${o.form}/revisions`],
    ['post', `/forms/${o.form}/preview`],
    ['post', `/forms/${o.form}/publish`, stale],
    ['post', `/forms/${o.form}/retire`, stale],
    ['get', `/state-machines/${o.machine}`],
    ['patch', `/state-machines/${o.machine}`, { ...stale, name: 'x' }],
    ['post', `/state-machines/${o.machine}/revisions`],
    ['post', `/state-machines/${o.machine}/preview`],
    ['post', `/state-machines/${o.machine}/publish`, stale],
    ['post', `/state-machines/${o.machine}/retire`, stale],
    ['get', `/dynamic/${SHARED.entityCode}/records/${o.stateRecord}/available-actions`],
    ['get', `/dynamic/${SHARED.entityCode}/records/${o.stateRecord}/state-history`],
    ['post', `/dynamic/${SHARED.entityCode}/records/${o.stateRecord}/transitions/enviar`, stale],
    ['get', `/workflows/${o.workflow}`],
    ['patch', `/workflows/${o.workflow}`, { ...stale, name: 'x' }],
    ['post', `/workflows/${o.workflow}/revisions`],
    ['post', `/workflows/${o.workflow}/preview`],
    ['post', `/workflows/${o.workflow}/publish`, stale],
    ['post', `/workflows/${o.workflow}/retire`, stale],
    ['get', `/workflow-instances/${o.instance}`],
    ['post', `/workflow-instances/${o.instance}/cancel`],
    ['get', `/approval-tasks/${o.task}`],
    ['post', `/approval-tasks/${o.task}/claim`],
    ['post', `/approval-tasks/${o.task}/approve`],
    ['post', `/approval-tasks/${o.task}/reject`, { reason: 'x' }],
    ['post', `/approval-tasks/${o.task}/return`, { reason: 'x' }],
    ['post', `/approval-delegations/${o.delegation}/revoke`, stale],
    ['get', `/automations/${o.automation}`],
    ['patch', `/automations/${o.automation}`, { ...stale, name: 'x' }],
    ['post', `/automations/${o.automation}/activate`, stale],
    ['post', `/automations/${o.automation}/pause`, stale],
    ['post', `/automations/${o.automation}/simulate`, {}],
    ['get', `/automation-runs/${o.run}`],
    ['post', `/automation-runs/${o.run}/retry`, stale],
    ['patch', `/product-categories/${o.category}`, { ...stale, name: 'x' }],
    ['get', `/products/${o.product}`],
    ['patch', `/products/${o.product}`, { ...stale, name: 'x' }],
    ['get', `/products/${o.product}/variants`],
    ['post', `/products/${o.product}/variants`, { sku: 'ALHEIO-1' }],
    ['get', `/variants/${o.variant}`],
    ['patch', `/variants/${o.variant}`, { ...stale, barcode: null }],
    ['get', `/price-lists/${o.priceList}`],
    ['patch', `/price-lists/${o.priceList}`, { ...stale, name: 'x' }],
    [
      'post',
      `/price-lists/${o.priceList}/items`,
      { variantId: me.ids.variant, unitPrice: '1.0000', minQuantity: '5' },
    ],
    ['patch', `/price-list-items/${o.priceItem}`, { ...stale, unitPrice: '1.0000' }],
    ['delete', `/price-list-items/${o.priceItem}`],
    ['get', `/customers/${o.customer}`],
    ['patch', `/customers/${o.customer}`, { ...stale, paymentTermDays: 1 }],
    ['post', `/customers/${o.customer}/block`, { ...stale, reason: 'x' }],
    ['post', `/customers/${o.customer}/unblock`, stale],
    ['patch', `/customer-segments/${o.segment}`, { ...stale, name: 'x' }],
    ['get', `/interactions/${o.interaction}`],
    ['patch', `/interactions/${o.interaction}`, { ...stale, subject: 'x' }],
    ['get', `/quotes/${o.quote}`],
    ['patch', `/quotes/${o.quote}`, { ...stale, notes: 'x' }],
    ['post', `/quotes/${o.quote}/lines`, { variantId: me.ids.variant, quantity: '1' }],
    ['patch', `/quotes/${o.quote}/lines/${o.quoteLine}`, { quantity: '3' }],
    ['patch', `/quotes/${me.ids.quote}/lines/${o.quoteLine}`, { quantity: '3' }],
    ['delete', `/quotes/${o.quote}/lines/${o.quoteLine}`],
    ['post', `/quotes/${o.quote}/send`, {}],
    ['post', `/quotes/${o.quote}/reject`, {}],
    ['post', `/quotes/${o.quote}/accept`, {}],
    ['get', `/sales-orders/${o.order}`],
    ['patch', `/sales-orders/${o.order}`, { ...stale, orderDate: '2026-01-01' }],
    ['post', `/sales-orders/${o.order}/lines`, { variantId: me.ids.variant, quantity: '1' }],
    ['patch', `/sales-orders/${o.order}/lines/${o.orderLine}`, { quantity: '3' }],
    ['patch', `/sales-orders/${me.ids.order}/lines/${o.orderLine}`, { quantity: '3' }],
    ['delete', `/sales-orders/${o.order}/lines/${o.orderLine}`],
    ['post', `/sales-orders/${o.order}/confirm`, {}],
    ['post', `/sales-orders/${o.order}/cancel`, { reason: 'x' }],
    ['get', `/shipments/${o.shipment}`],
    ['patch', `/shipments/${o.shipment}`, { ...stale, notes: 'x' }],
    ['delete', `/shipments/${o.shipment}`],
    [
      'post',
      `/shipments/${o.shipment}/lines`,
      { orderLineId: me.ids.shipmentOrderLine, quantity: '1' },
    ],
    ['patch', `/shipments/${o.shipment}/lines/${o.shipmentLine}`, { quantity: '1' }],
    ['patch', `/shipments/${me.ids.shipment}/lines/${o.shipmentLine}`, { quantity: '1' }],
    ['delete', `/shipments/${o.shipment}/lines/${o.shipmentLine}`],
    ['post', `/shipments/${o.shipment}/post`, {}],
    ['post', `/shipments/${o.shipment}/reverse`, { reason: 'x' }],
    ['get', `/suppliers/${o.supplier}`],
    ['patch', `/suppliers/${o.supplier}`, { ...stale, paymentTermDays: 10 }],
    ['get', `/purchase-requisitions/${o.requisition}`],
    ['patch', `/purchase-requisitions/${o.requisition}`, { ...stale, notes: 'x' }],
    ['delete', `/purchase-requisitions/${o.requisition}`],
    [
      'post',
      `/purchase-requisitions/${o.requisition}/lines`,
      { variantId: me.ids.variant, quantity: '1' },
    ],
    ['delete', `/purchase-requisitions/${o.requisition}/lines/${o.requisitionLine}`],
    ['post', `/purchase-requisitions/${o.requisition}/submit`, {}],
    ['post', `/purchase-requisitions/${o.requisition}/approve`, {}],
    ['post', `/purchase-requisitions/${o.requisition}/reject`, { reason: 'x' }],
    [
      'post',
      `/purchase-requisitions/${o.requisition}/convert`,
      { supplierId: me.ids.supplier, lines: [] },
    ],
    ['get', `/purchase-orders/${o.purchase}`],
    ['patch', `/purchase-orders/${o.purchase}`, { ...stale, notes: 'x' }],
    ['delete', `/purchase-orders/${o.purchase}`],
    [
      'post',
      `/purchase-orders/${o.purchase}/lines`,
      { variantId: me.ids.variant, quantity: '1', unitCost: '1' },
    ],
    ['delete', `/purchase-orders/${o.purchase}/lines/${o.purchaseLine}`],
    ['post', `/purchase-orders/${o.purchase}/confirm`, {}],
    ['post', `/purchase-orders/${o.purchase}/cancel`, { reason: 'x' }],
    ['get', `/goods-receipts/${o.goodsReceipt}`],
    ['patch', `/goods-receipts/${o.goodsReceipt}`, { ...stale, notes: 'x' }],
    ['delete', `/goods-receipts/${o.goodsReceipt}`],
    [
      'post',
      `/goods-receipts/${o.goodsReceipt}/lines`,
      { purchaseLineId: me.ids.orderedPurchaseLine, quantity: '1' },
    ],
    ['delete', `/goods-receipts/${o.goodsReceipt}/lines/${o.goodsReceiptLine}`],
    ['post', `/goods-receipts/${o.goodsReceipt}/post`, {}],
    ['post', `/goods-receipts/${o.goodsReceipt}/reverse`, { reason: 'x' }],
    ['get', `/treasury-accounts/${o.treasuryAccount}`],
    ['patch', `/treasury-accounts/${o.treasuryAccount}`, { ...stale, name: 'x' }],
    ['get', `/treasury-accounts/${o.treasuryAccount}/entries`],
    ['get', `/reconciliations/lines/${o.statementLine}`],
    ['get', `/reconciliations/lines/${o.statementLine}/suggestions`],
    ['delete', `/reconciliations/batches/${o.statementBatch}`],
    ['post', `/reconciliations/matches/${o.reconMatch}/undo`, { reason: 'x' }],
    ['get', `/reconciliations/lines?accountId=${o.bankAccount}`],
    ['get', `/reconciliations/entries?accountId=${o.bankAccount}`],
    ['get', `/reconciliations/batches?accountId=${o.bankAccount}`],
    ['get', `/reconciliations/summary?accountId=${o.bankAccount}`],
    [
      'post',
      '/reconciliations/imports',
      { accountId: o.bankAccount, lines: [{ occurredOn: '2026-01-01', amount: '1' }] },
    ],
    ['post', `/notifications/${o.notification}/read`, {}],
    ['post', `/notifications/${o.notification}/open`, {}],
    ['post', `/notification-deliveries/${o.delivery}/retry`, {}],
    ['get', `/leads/${o.lead}`],
    ['patch', `/leads/${o.lead}`, { ...stale, name: 'x' }],
    ['post', `/leads/${o.lead}/qualify`, {}],
    ['post', `/leads/${o.lead}/disqualify`, { reason: 'x' }],
    ['post', `/leads/${o.lead}/convert`, { organizationId: me.ids.organization }],
    ['patch', `/pipeline-stages/${o.stage}`, { ...stale, name: 'x' }],
    ['get', `/opportunities/${o.opportunity}`],
    ['patch', `/opportunities/${o.opportunity}`, { ...stale, name: 'x' }],
    [
      'post',
      `/opportunities/${o.opportunity}/move`,
      { stageId: me.ids.wonStage, winEvidence: 'x' },
    ],
    ['get', `/opportunities/${o.opportunity}/history`],
    ['get', `/opportunities/${o.opportunity}/activities`],
    ['post', `/opportunities/${o.opportunity}/activities`, { kind: 'NOTE', subject: 'x' }],
    ['post', `/opportunity-activities/${o.activity}/complete`, {}],
    ['get', `/campaigns/${o.campaign}`],
    ['patch', `/campaigns/${o.campaign}`, { ...stale, name: 'x' }],
    ['post', `/campaigns/${o.campaign}/status`, { status: 'ACTIVE' }],
    ['get', `/campaigns/${o.campaign}/members`],
    ['post', `/campaigns/${o.campaign}/members`, { leadIds: [me.ids.lead] }],
    ['delete', `/campaigns/${o.campaign}/members/${o.campaignMember}`],
    ['post', `/campaigns/${o.campaign}/members/${o.campaignMember}/respond`, {}],
    ['post', `/campaigns/${o.campaign}/members/${o.campaignMember}/opt-out`, {}],
    ['post', `/campaigns/${o.campaign}/send`, {}],
    ['delete', `/marketing-exclusions/${o.exclusion}`],
    ['get', `/receivables/${o.receivable}`],
    ['get', `/payables/${o.payable}`],
    ['get', `/customers/${o.customer}/credit`],
    ['get', `/payments/${o.payment}`],
    ['delete', `/payments/${o.payment}`],
    ['post', `/payments/${o.payment}/submit`, {}],
    ['post', `/payments/${o.payment}/confirm`, {}],
    ['post', `/payments/${o.payment}/fail`, { reason: 'x' }],
    ['post', `/payments/${o.payment}/reverse`, { reason: 'x' }],
    ['get', `/supplier-invoices/${o.supplierInvoice}`],
    ['patch', `/supplier-invoices/${o.supplierInvoice}`, { ...stale, notes: 'x' }],
    ['delete', `/supplier-invoices/${o.supplierInvoice}`],
    [
      'post',
      `/supplier-invoices/${o.supplierInvoice}/lines`,
      { description: 'x', quantity: '1', unitPrice: '1' },
    ],
    ['delete', `/supplier-invoices/${o.supplierInvoice}/lines/${o.supplierInvoiceLine}`],
    ['post', `/supplier-invoices/${o.supplierInvoice}/validate`, {}],
    ['post', `/supplier-invoices/${o.supplierInvoice}/void`, {}],
    ['get', `/stock-transfers/${o.transfer}`],
    ['patch', `/stock-transfers/${o.draftTransfer}`, { expectedVersion: 1, notes: 'x' }],
    ['delete', `/stock-transfers/${o.draftTransfer}`],
    [
      'post',
      `/stock-transfers/${o.draftTransfer}/lines`,
      { variantId: me.ids.variant, quantity: '1' },
    ],
    ['delete', `/stock-transfers/${o.draftTransfer}/lines/${o.draftTransferLine}`],
    ['post', `/stock-transfers/${o.draftTransfer}/dispatch`, {}],
    [
      'post',
      `/stock-transfers/${o.transfer}/receive`,
      { lines: [{ lineId: me.ids.transferLine, quantity: '1' }] },
    ],
    ['post', `/stock-transfers/${o.draftTransfer}/cancel`, { reason: 'x' }],
    ['get', `/stock-counts/${o.count}`],
    ['delete', `/stock-counts/${o.count}`],
    ['post', `/stock-counts/${o.count}/open`, {}],
    [
      'put',
      `/stock-counts/${o.count}/counts`,
      { lines: [{ lineId: me.ids.countLine, countedQty: '1' }] },
    ],
    [
      'post',
      `/stock-counts/${o.count}/lines`,
      { variantId: me.ids.variant, locationId: me.ids.location },
    ],
    ['post', `/stock-counts/${o.count}/review`, {}],
    ['post', `/stock-counts/${o.count}/reopen`, {}],
    ['post', `/stock-counts/${o.count}/post`, {}],
    ['post', `/stock-counts/${o.count}/cancel`, { reason: 'x' }],
    ['get', `/goods-returns/${o.goodsReturn}`],
    ['delete', `/goods-returns/${o.goodsReturn}`],
    [
      'post',
      `/goods-returns/${o.goodsReturn}/lines`,
      { sourceLineId: me.ids.returnSourceLine, quantity: '1' },
    ],
    ['delete', `/goods-returns/${o.goodsReturn}/lines/${o.returnLine}`],
    ['post', `/goods-returns/${o.goodsReturn}/approve`, {}],
    ['post', `/goods-returns/${o.goodsReturn}/post`, {}],
    ['get', `/contracts/${o.contract}`],
    ['patch', `/contracts/${o.contract}`, { ...stale, title: 'x' }],
    ['post', `/contracts/${o.contract}/activate`, {}],
    ['post', `/contracts/${o.contract}/terminate`, { reason: 'x' }],
    ['get', `/sales-orders/${o.order}/billable`],
    ['get', `/invoices/${o.invoice}`],
    ['patch', `/invoices/${o.invoice}`, { ...stale, notes: 'x' }],
    ['delete', `/invoices/${o.invoice}`],
    [
      'post',
      `/invoices/${o.invoice}/lines`,
      { description: 'x', quantity: '1', unitPrice: '1', taxRate: '14' },
    ],
    ['delete', `/invoices/${o.invoice}/lines/${o.invoiceLine}`],
    ['post', `/invoices/${o.invoice}/issue`, {}],
    ['get', `/credit-notes/${o.creditNote}`],
    ['patch', `/credit-notes/${o.creditNote}`, { reason: 'x' }],
    ['delete', `/credit-notes/${o.creditNote}`],
    [
      'post',
      `/credit-notes/${o.creditNote}/lines`,
      { invoiceLineId: o.invoiceLine, quantity: '1' },
    ],
    ['delete', `/credit-notes/${o.creditNote}/lines/${o.creditNoteLine}`],
    ['post', `/credit-notes/${o.creditNote}/issue`, {}],
    ['get', `/warehouses/${o.warehouse}`],
    ['patch', `/warehouses/${o.warehouse}`, { ...stale, name: 'x' }],
    ['post', `/warehouses/${o.warehouse}/locations`, { code: 'X', name: 'x' }],
    ['patch', `/stock-locations/${o.location}`, { ...stale, name: 'x' }],
    ['post', `/stock-movements/${o.movement}/reverse`, { reason: 'x' }],
    ['post', `/stock-reservations/${o.reservation}/release`, {}],
    ['get', `/entity-definitions/${o.entity}`],
    ['get', `/entity-definitions/${o.entity}/publish-preview`],
    ['delete', `/entity-definitions/${o.entity}`],
    ['patch', `/entity-definitions/${o.entity}`, { ...stale, name: 'x' }],
    ['put', `/entity-definitions/${o.entity}/draft`, { ...stale, fields: [] }],
    ['post', `/entity-definitions/${o.entity}/drafts`],
    ['delete', `/entity-definitions/${o.entity}/draft`],
    ['post', `/entity-definitions/${o.entity}/publish`, stale],
    ['post', `/entity-definitions/${o.entity}/archive`, stale],
    ['get', `/dynamic/${SHARED.entityCode}/records/${o.record}`],
    [
      'patch',
      `/dynamic/${SHARED.entityCode}/records/${o.record}`,
      { ...stale, data: { notas: 'x' } },
    ],
    ['post', `/dynamic/${SHARED.entityCode}/records/${o.record}/archive`, stale],
    ['get', `/parties/${o.personParty}`],
    ['patch', `/parties/${o.personParty}`, { ...stale, displayName: 'x' }],
    ['get', `/parties/${o.personParty}/possible-duplicates`],
    ['get', `/parties/${o.personParty}/relationships`],
    ['post', `/parties/${o.personParty}/contacts`, { type: 'EMAIL', value: 'x@exemplo.invalid' }],
    [
      'post',
      `/parties/${o.personParty}/addresses`,
      { type: 'OTHER', line1: 'x', city: 'y', countryCode: 'AO' },
    ],
    [
      'post',
      `/parties/${o.personParty}/relationships`,
      { targetPartyId: me.ids.organizationParty, relationshipType: 'X' },
    ],
    ['patch', `/contacts/${o.contact}`, { ...stale, label: 'x' }],
    ['delete', `/contacts/${o.contact}`],
    ['patch', `/addresses/${o.address}`, { ...stale, city: 'x' }],
    ['delete', `/addresses/${o.address}`],
    ['delete', `/party-relationships/${o.relationship}`],
  ]
}

test.group('matriz de isolamento', (group) => {
  group.each.timeout(120_000)
  group.teardown(async () => {
    await deleteTestTenants()
    await deleteTestUsers()
  })

  test('o cenário tem os mesmos códigos e identificações nos dois tenants', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    assert.notStrictEqual(a.tenant.id, b.tenant.id)
    for (const world of [a, b]) {
      const orgs = (await world.http.get('/api/v1/organizations')).body().data
      assert.strictEqual(orgs[0].code, SHARED.orgCode)
      const roles = (await world.http.get('/api/v1/roles')).body().data.map((r: any) => r.code)
      assert.include(roles, SHARED.roleCode)
      const person = (await world.http.get(`/api/v1/parties/${world.ids.personParty}`)).body().data
      assert.strictEqual(person.contacts[0].value, SHARED.personEmail)
    }
    // Cada tenant tem o seu: nenhum id se repete entre os dois.
    const [sa, sb] = [await snapshot(a), await snapshot(b)]
    const idsA = new Set(idsOf(sa))
    assert.isEmpty(idsOf(sb).filter((id) => idsA.has(id)))
  })

  test('ids do outro tenant dão sempre 404, nos dois sentidos, e nada muda', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const [beforeA, beforeB] = [await snapshot(a), await snapshot(b)]

    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const [method, url, body] of foreignIdCases(me, other)) {
        const response = await call(client, method, url, {
          actor: me.admin,
          tenantId: me.tenant.id,
          body,
        })
        assert.strictEqual(response.status(), 404, `${me.label} ${method.toUpperCase()} ${url}`)
        assert.strictEqual(response.body().error.code, 'NOT_FOUND')
      }
    }

    assert.deepEqual(await snapshot(a), beforeA)
    assert.deepEqual(await snapshot(b), beforeB)
  })

  test('as listagens só contêm dados do próprio tenant e têm a mesma dimensão nos dois', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const [sa, sb] = [await snapshot(a), await snapshot(b)]
    const idsA = new Set(idsOf(sa))
    const idsB = new Set(idsOf(sb))
    assert.isEmpty([...idsA].filter((id) => idsB.has(id)))
    for (const key of [
      'roles',
      'assignments',
      'policies',
      'organizations',
      'units',
      'costCenters',
      'scopes',
      'members',
      'invitations',
      'parties',
      'team',
      'entities',
      'records',
      'rules',
      'evaluations',
      'forms',
      'publishedForms',
      'machines',
      'stateHistory',
      'workflows',
      'instances',
      'inbox',
      'delegations',
      'automations',
      'automationRuns',
      'categories',
      'products',
      'variants',
      'priceLists',
      'customers',
      'segments',
      'interactions',
      'quotes',
      'salesOrders',
      'shipments',
      'suppliers',
      'requisitions',
      'purchases',
      'receipts',
      'transfers',
      'counts',
      'returns',
      'treasuryAccounts',
      'stages',
      'leads',
      'opportunities',
      'campaigns',
      'exclusions',
      'notifications',
      'notificationDeliveries',
      'reconLines',
      'reconEntries',
      'reconBatches',
      'receivables',
      'payables',
      'payments',
      'supplierInvoices',
      'contracts',
      'invoices',
      'creditNotes',
      'warehouses',
      'balances',
      'movements',
      'lots',
      'reservations',
    ] as const) {
      assert.lengthOf(sa[key], sb[key].length, key)
      assert.isAbove(sa[key].length, 0, key)
    }
    // As preferências são do membro e do tenant: o mesmo ui.theme tem valores diferentes.
    assert.strictEqual(sa.preferences['ui.theme'], 'dark')
    assert.strictEqual(sb.preferences['ui.theme'], 'light')
    // A pesquisa não atravessa tenants: o mesmo email existe nos dois mas cada um vê só o seu.
    for (const world of [a, b]) {
      const found = (await world.http.get(`/api/v1/parties?q=${SHARED.personEmail}`)).body().data
      assert.deepEqual(
        found.map((p: any) => p.id),
        [world.ids.personParty]
      )
    }
    // Duplicados não cruzam tenants (mesmo email, mesmo documento, mesmo NIF).
    for (const world of [a, b]) {
      assert.deepEqual(
        (
          await world.http.get(`/api/v1/parties/${world.ids.personParty}/possible-duplicates`)
        ).body().data,
        []
      )
      assert.deepEqual(
        (
          await world.http.get(`/api/v1/parties/${world.ids.organizationParty}/possible-duplicates`)
        ).body().data,
        []
      )
    }
  })

  test('referências cruzadas em corpos de pedido são rejeitadas (404 ou 422)', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const bi = b.ids
    const cases: [string, Method, string, Record<string, unknown>, number][] = [
      [
        'atribuir papel de B a membro de A',
        'post',
        '/role-assignments',
        { membershipId: a.member.membershipId, roleId: bi.role },
        404,
      ],
      [
        'atribuir papel de A a membro de B',
        'post',
        '/role-assignments',
        { membershipId: b.member.membershipId, roleId: a.ids.role },
        404,
      ],
      [
        'atribuir papel com unidade de B',
        'post',
        '/role-assignments',
        {
          membershipId: a.operator.membershipId,
          roleId: a.ids.role,
          organizationUnitId: bi.unitRoot,
        },
        404,
      ],
      [
        'unidade numa organização de B',
        'post',
        '/organization-units',
        { organizationId: bi.organization, code: 'X1', name: 'x' },
        404,
      ],
      [
        'unidade com pai de B',
        'post',
        '/organization-units',
        { organizationId: a.ids.organization, parentId: bi.unitRoot, code: 'X2', name: 'x' },
        422,
      ],
      [
        'unidade com gestor de B',
        'post',
        '/organization-units',
        {
          organizationId: a.ids.organization,
          managerMembershipId: b.admin.membershipId,
          code: 'X3',
          name: 'x',
        },
        422,
      ],
      [
        'centro de custo com pai de B',
        'post',
        '/cost-centers',
        { organizationId: a.ids.organization, parentId: bi.costCenter, code: 'X4', name: 'x' },
        422,
      ],
      [
        'centro de custo com responsável de B',
        'post',
        '/cost-centers',
        {
          organizationId: a.ids.organization,
          responsibleMembershipId: b.admin.membershipId,
          code: 'X5',
          name: 'x',
        },
        422,
      ],
      [
        'âmbito de membro de B',
        'post',
        '/membership-scopes',
        { membershipId: b.member.membershipId, organizationId: a.ids.organization },
        404,
      ],
      [
        'âmbito com organização de B',
        'post',
        '/membership-scopes',
        { membershipId: a.operator.membershipId, organizationId: bi.organization },
        404,
      ],
      [
        'âmbito com unidade de B',
        'post',
        '/membership-scopes',
        {
          membershipId: a.operator.membershipId,
          organizationId: a.ids.organization,
          organizationUnitId: bi.unitRoot,
        },
        422,
      ],
      [
        'equipa com membro de B',
        'post',
        `/organization-units/${a.ids.unitRoot}/members`,
        { membershipId: b.member.membershipId, startsOn: '2026-01-01' },
        404,
      ],
      [
        'relação para party de B',
        'post',
        `/parties/${a.ids.personParty}/relationships`,
        { targetPartyId: bi.organizationParty, relationshipType: 'X' },
        404,
      ],
      [
        'convite com papel de B',
        'post',
        '/invitations',
        { email: 'novo1@exemplo.invalid', roleIds: [bi.role] },
        422,
      ],
      [
        'convite com unidade de B',
        'post',
        '/invitations',
        { email: 'novo2@exemplo.invalid', unitIds: [bi.unitRoot] },
        422,
      ],
      [
        'organização por omissão de B',
        'put',
        '/me/default-organization',
        { organizationId: bi.organization },
        422,
      ],
      [
        'ligar membro de A a pessoa de B',
        'put',
        `/memberships/${a.operator.membershipId}/person`,
        { partyId: bi.personParty },
        404,
      ],
      [
        'ligar membro de B',
        'put',
        `/memberships/${b.operator.membershipId}/person`,
        { partyId: a.ids.personParty },
        404,
      ],
      [
        'registo dinâmico com condutor (membership) de B',
        'post',
        `/dynamic/${SHARED.entityCode}/records`,
        { data: { matricula: 'ZZ-99-ZZ', condutor: b.admin.membershipId } },
        422,
      ],
      ['expedição de uma encomenda de B', 'post', '/shipments', { orderId: bi.order }, 404],
      ['factura de uma encomenda de B', 'post', '/invoices', { orderId: bi.order }, 404],
      [
        'encomenda a um fornecedor de B',
        'post',
        '/purchase-orders',
        { supplierId: bi.supplier },
        422,
      ],
      [
        'fornecedor com a Party de B',
        'post',
        '/suppliers',
        { partyId: bi.organizationParty, organizationId: a.ids.organization, code: 'FOR-X' },
        422,
      ],
      [
        'requisição com a variante de B',
        'post',
        `/purchase-requisitions/${a.ids.requisition}/lines`,
        { variantId: bi.variant, quantity: '1' },
        422,
      ],
      [
        'transferência com o armazém de B',
        'post',
        '/stock-transfers',
        { sourceWarehouseId: a.ids.warehouse, destinationWarehouseId: bi.secondWarehouse },
        422,
      ],
      [
        'linha de transferência com a variante de B',
        'post',
        `/stock-transfers/${a.ids.draftTransfer}/lines`,
        { variantId: bi.variant, quantity: '1' },
        422,
      ],
      [
        'contagem com o armazém de B',
        'post',
        '/stock-counts',
        { warehouseId: bi.secondWarehouse },
        422,
      ],
      [
        'devolução de um documento de B',
        'post',
        '/goods-returns',
        {
          direction: 'SUPPLIER',
          sourceDocumentId: bi.goodsReceipt,
          warehouseId: a.ids.warehouse,
          reason: 'x',
        },
        422,
      ],
      [
        'conta de tesouraria com a organização de B',
        'post',
        '/treasury-accounts',
        { organizationId: bi.organization, code: 'CAIXA-X', name: 'x', type: 'CASH' },
        422,
      ],
      [
        'pagamento com a conta de B',
        'post',
        '/payments',
        {
          organizationId: a.ids.organization,
          direction: 'INBOUND',
          partyId: a.ids.organizationParty,
          treasuryAccountId: bi.treasuryAccount,
          amount: '1',
          allocations: [{ receivableId: a.ids.receivable, amount: '1' }],
        },
        422,
      ],
      [
        'pagamento a uma conta a receber de B',
        'post',
        '/payments',
        {
          organizationId: a.ids.organization,
          direction: 'INBOUND',
          partyId: a.ids.organizationParty,
          treasuryAccountId: a.ids.treasuryAccount,
          amount: '1',
          allocations: [{ receivableId: bi.receivable, amount: '1' }],
        },
        422,
      ],
      [
        'correspondência com a linha do extracto de B',
        'post',
        '/reconciliations/matches',
        { statementLineId: bi.statementLine, treasuryEntryId: a.ids.reconEntry },
        404,
      ],
      [
        'correspondência com o movimento de B',
        'post',
        '/reconciliations/matches',
        { statementLineId: a.ids.statementLine, treasuryEntryId: bi.reconEntry },
        404,
      ],
      [
        'extracto numa conta de B',
        'post',
        '/reconciliations/imports',
        { accountId: bi.bankAccount, lines: [{ occurredOn: '2026-01-01', amount: '1' }] },
        404,
      ],
      [
        'aviso manual a um membro de B',
        'post',
        '/notification-requests',
        {
          typeCode: 'system.message',
          recipientMembershipIds: [b.member.membershipId],
          title: 'x',
          body: 'y',
        },
        422,
      ],
      [
        'oportunidade com o cliente de B',
        'post',
        '/opportunities',
        { name: 'x', customerId: bi.customer },
        422,
      ],
      [
        'oportunidade com a lead de B',
        'post',
        '/opportunities',
        { name: 'x', leadId: bi.lead },
        422,
      ],
      [
        'mover para a etapa de B',
        'post',
        `/opportunities/${a.ids.opportunity}/move`,
        { stageId: bi.wonStage, winEvidence: 'x' },
        422,
      ],
      [
        'destinatário lead de B',
        'post',
        `/campaigns/${a.ids.campaign}/members`,
        { leadIds: [bi.lead] },
        422,
      ],
      [
        'conversão com a organização de B',
        'post',
        `/leads/${a.ids.lead}/convert`,
        { organizationId: bi.organization },
        422,
      ],
      [
        'factura de fornecedor com o fornecedor de B',
        'post',
        '/supplier-invoices',
        { supplierId: bi.supplier, externalNumber: 'FF-X' },
        422,
      ],
      [
        'recepção de uma encomenda de B',
        'post',
        '/goods-receipts',
        { purchaseOrderId: bi.orderedPurchase },
        404,
      ],
      [
        'recepção com o armazém de B',
        'post',
        '/goods-receipts',
        { purchaseOrderId: a.ids.orderedPurchase, warehouseId: bi.warehouse },
        422,
      ],
      [
        'linha de uma encomenda de B numa recepção de A',
        'post',
        `/goods-receipts/${a.ids.goodsReceipt}/lines`,
        { purchaseLineId: bi.orderedPurchaseLine, quantity: '1' },
        422,
      ],
      [
        'conversão de uma requisição de B',
        'post',
        `/purchase-requisitions/${bi.requisition}/convert`,
        { supplierId: a.ids.supplier, lines: [] },
        404,
      ],
      [
        'factura com o cliente de B',
        'post',
        '/invoices',
        { organizationId: a.ids.organization, customerId: bi.customer },
        422,
      ],
      [
        'contrato com a Party de B',
        'post',
        '/contracts',
        {
          organizationId: a.ids.organization,
          partyId: bi.organizationParty,
          title: 'x',
          startDate: '2026-01-01',
        },
        422,
      ],
      [
        'nota de crédito de uma factura de B',
        'post',
        '/credit-notes',
        { invoiceId: bi.issuedInvoice, reason: 'x' },
        404,
      ],
      [
        'linha de uma factura de B numa nota de A',
        'post',
        `/credit-notes/${a.ids.creditNote}/lines`,
        { invoiceLineId: bi.invoiceLine, quantity: '1' },
        422,
      ],
      [
        'linha de uma encomenda de B numa expedição de A',
        'post',
        `/shipments/${a.ids.shipment}/lines`,
        { orderLineId: bi.shipmentOrderLine, quantity: '1' },
        422,
      ],
      [
        'ajuste com o local de B',
        'post',
        '/stock-adjustments',
        { variantId: a.ids.variant, locationId: bi.location, quantityDelta: '1', reason: 'x' },
        422,
      ],
      [
        'ajuste com a variante de B',
        'post',
        '/stock-adjustments',
        { variantId: bi.variant, locationId: a.ids.location, quantityDelta: '1', reason: 'x' },
        422,
      ],
      [
        'reserva com o lote de B',
        'post',
        '/stock-reservations',
        {
          variantId: bi.variant,
          locationId: a.ids.location,
          lotId: bi.lot,
          quantity: '1',
          sourceType: 'MANUAL',
          sourceId: '00000000-0000-4000-8000-0000000000bb',
        },
        422,
      ],
      [
        'armazém numa organização de B',
        'post',
        '/warehouses',
        { organizationId: bi.organization, code: 'X', name: 'x' },
        422,
      ],
      ['lote para a variante de B', 'post', '/lots', { variantId: bi.variant, code: 'LX' }, 422],
      [
        'simular membro de B',
        'post',
        '/authorization/simulate',
        { membershipId: b.admin.membershipId, permission: 'iam.read' },
        404,
      ],
    ]
    for (const [label, method, url, body, expected] of cases) {
      const response = await call(client, method, `${url}`, {
        actor: a.admin,
        tenantId: a.tenant.id,
        body,
      })
      assert.strictEqual(response.status(), expected, label)
    }
  })

  test('um tenantId no corpo ou no URL nunca decide o tenant', async ({ client, assert }) => {
    const { a, b } = await worlds(client)
    const created = await call(client, 'post', '/organizations', {
      actor: a.admin,
      tenantId: a.tenant.id,
      body: {
        code: 'EXTRA-A',
        legalName: 'Extra',
        countryCode: 'AO',
        baseCurrency: 'AOA',
        tenantId: b.tenant.id,
        tenant_id: b.tenant.id,
      },
    })
    created.assertStatus(201)
    const id = created.body().data.id
    assert.notProperty(created.body().data, 'tenantId')
    assert.isOk((await a.http.get(`/api/v1/organizations/${id}`)).body().data)
    ;(await b.http.get(`/api/v1/organizations/${id}`)).assertStatus(404)
    assert.notInclude(
      (await b.http.get('/api/v1/organizations')).body().data.map((o: any) => o.code),
      'EXTRA-A'
    )
    // Limpeza: não há DELETE de organizações; remove-se a linha de teste para não afectar as outras verificações.
    await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [a.tenant.id])
      await trx.from('organizations').where('id', id).delete()
    })

    // Selectores contraditórios ou inválidos nunca são resolvidos "pelo que der".
    const both = await client
      .get('/api/v1/context')
      .header('cookie', a.admin.cookie)
      .header('x-tenant-id', a.tenant.id)
      .header('x-tenant-code', b.tenant.code)
    both.assertStatus(400)
    ;(
      await client
        .get('/api/v1/context')
        .header('cookie', a.admin.cookie)
        .header('x-tenant-code', b.tenant.code)
    ).assertStatus(403)
  })

  test('varrimento: TODAS as rotas de tenant do OpenAPI recusam sessão, selector e tenant errados', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const spec = parse(readFileSync('openapi/openapi.yaml', 'utf8')) as {
      paths: Record<string, Record<string, { parameters?: Record<string, unknown>[] }>>
    }
    const operations: { method: Method; path: string }[] = []
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const takesTenant = (op.parameters ?? []).some(
          (p) => p.$ref === '#/components/parameters/TenantId' || p.name === 'X-Tenant-Id'
        )
        if (takesTenant) operations.push({ method: method as Method, path })
      }
    }
    // Operações que NÃO são de tenant (públicas, sessão ou conta). Qualquer outra tem de declarar o
    // selector de tenant, senão escapava ao varrimento: acrescentar uma rota de tenant sem selector falha aqui.
    const NON_TENANT = new Set([
      'get /health',
      'get /ready',
      'post /auth/login',
      'post /auth/forgot-password',
      'post /auth/reset-password',
      'post /auth/verify-email',
      'post /auth/logout',
      'get /me',
      'get /me/sessions',
      'delete /me/sessions/{id}',
      'post /me/password',
      'get /me/security-events',
      'get /me/tenants',
      'post /invitations/accept',
      // Administração da plataforma: sem selector de tenant (política própria `platform.*`; testada em platform.spec.ts)
      'get /platform/me',
      'get /platform/tenants',
      'post /platform/tenants',
      'get /platform/tenants/{id}',
      'post /platform/tenants/{id}/suspend',
      'post /platform/tenants/{id}/resume',
      'get /platform/plans',
      'post /platform/plans',
      'post /platform/plans/{code}/revisions/{revision}/publish',
      'post /platform/plans/{code}/revisions/{revision}/retire',
      'get /platform/tenants/{id}/subscription',
      'post /platform/tenants/{id}/subscription',
      'put /platform/tenants/{id}/subscription/plan',
      'put /platform/tenants/{id}/subscription/status',
    ])
    const declared = new Set(operations.map((o) => `${o.method} ${o.path}`))
    const undeclared = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops)
        .map((method) => `${method} ${path}`)
        .filter((key) => !NON_TENANT.has(key) && !declared.has(key))
    )
    assert.isEmpty(undeclared, `rotas sem selector de tenant no OpenAPI: ${undeclared.join(', ')}`)
    assert.isAbove(operations.length, 50)

    const url = (path: string) =>
      path.replace('{id}', UUID0).replace('{key}', 'ui.theme').replace('{entityCode}', 'vehicle')
    const noPermissionNeeded = (path: string) =>
      path === '/context' ||
      path === '/context/features' ||
      path === '/settings/effective' ||
      path.startsWith('/me/')

    for (const { method, path } of operations) {
      const label = `${method.toUpperCase()} ${path}`
      const u = url(path)

      const anonymous = await call(client, method, u, { tenantId: a.tenant.id })
      assert.strictEqual(anonymous.status(), 401, `${label} sem sessão`)

      const noSelector = await call(client, method, u, { actor: a.admin })
      assert.strictEqual(noSelector.status(), 400, `${label} sem selector`)
      assert.strictEqual(noSelector.body().error.code, 'TENANT_SELECTOR_REQUIRED')

      const wrongTenant = await call(client, method, u, { actor: a.admin, tenantId: b.tenant.id })
      assert.strictEqual(wrongTenant.status(), 403, `${label} tenant alheio`)
      assert.strictEqual(wrongTenant.body().error.code, 'TENANT_ACCESS_DENIED')

      const missing = await call(client, method, u, { actor: a.admin, tenantId: UUID0 })
      assert.strictEqual(
        missing.body().error.code,
        'TENANT_ACCESS_DENIED',
        `${label} tenant inexistente`
      )

      if (WRITES.has(method)) {
        const csrf = await call(client, method, u, {
          actor: a.admin,
          tenantId: a.tenant.id,
          csrf: 'falso',
        })
        assert.strictEqual(csrf.body().error.code, 'CSRF_TOKEN_INVALID', `${label} CSRF`)
      }

      const operator = await call(client, method, u, { actor: a.operator, tenantId: a.tenant.id })
      if (noPermissionNeeded(path)) {
        assert.notInclude([401, 403], operator.status(), `${label} sem permissão extra`)
      } else {
        assert.strictEqual(operator.status(), 403, `${label} sem papel`)
        assert.strictEqual(operator.body().error.code, 'PERMISSION_DENIED')
      }
    }
  })

  test('um membro com papel limitado só faz o que o papel permite', async ({ client, assert }) => {
    const { a } = await worlds(client)
    // `member` tem só party.read.
    const asMember = api(client, a.tenant, a.member)
    ;(await asMember.get('/api/v1/parties')).assertStatus(200)
    for (const [method, url] of [
      ['post', '/people'],
      ['patch', `/parties/${a.ids.personParty}`],
      ['get', '/roles'],
      ['post', '/roles'],
      ['get', '/organizations'],
      ['get', '/memberships'],
      ['get', '/invitations'],
      ['post', '/authorization/simulate'],
    ] as const) {
      const response = await call(client, method, url, {
        actor: a.member,
        tenantId: a.tenant.id,
        body: {},
      })
      assert.strictEqual(response.status(), 403, `${method} ${url}`)
    }
    const permissions = (await asMember.get('/api/v1/context'))
      .body()
      .data.permissions.map((p: any) => p.code)
    assert.deepEqual(permissions, ['party.read'])
  })

  test('trocar de tenant não reutiliza permissões nem papéis do anterior', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const user = await crossTenantUser(a.tenant, b.tenant)
    await grantAdmin(a.tenant, user.membershipA)
    const session = await login(client, user.email)
    const actor: Actor = {
      email: user.email,
      userId: user.user.id,
      membershipId: user.membershipA,
      ...session,
    }

    for (let i = 0; i < 3; i++) {
      const inA = await api(client, a.tenant, actor).get('/api/v1/context')
      assert.include(
        inA.body().data.permissions.map((p: any) => p.code),
        'iam.manage'
      )
      assert.strictEqual(inA.body().data.tenant.id, a.tenant.id)

      const inB = await api(client, b.tenant, { ...actor, membershipId: user.membershipB }).get(
        '/api/v1/context'
      )
      inB.assertStatus(200)
      assert.strictEqual(inB.body().data.tenant.id, b.tenant.id)
      assert.deepEqual(inB.body().data.permissions, [], 'em B não tem nada de A')
      assert.strictEqual(inB.body().data.membership.id, user.membershipB)

      const rolesInB = await api(client, b.tenant, actor).get('/api/v1/roles')
      assert.strictEqual(rolesInB.status(), 403)
      assert.strictEqual(rolesInB.body().error.code, 'PERMISSION_DENIED')
      ;(await api(client, a.tenant, actor).get('/api/v1/roles')).assertStatus(200)
    }
  })

  test('pedidos intercalados dos dois tenants nunca se misturam', async ({ client, assert }) => {
    const { a, b } = await worlds(client)
    const jobs = Array.from({ length: 24 }, (_, i) => {
      const world = i % 2 === 0 ? a : b
      return world.http
        .get('/api/v1/organizations')
        .then((r) => ({ label: world.label, ids: idsOf(r.body().data) }))
    })
    for (const result of await Promise.all(jobs)) {
      const world = result.label === 'A' ? a : b
      const other = result.label === 'A' ? b : a
      assert.include(result.ids, world.ids.organization)
      assert.notInclude(result.ids, other.ids.organization)
    }
  })

  test('um tenant suspenso bloqueia todas as rotas; uma membership suspensa também', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const small = await createActiveTenant()
    const admin = await newActor(client, small, true)
    ;(await api(client, small, admin).get('/api/v1/roles')).assertStatus(200)

    await new ChangeTenantStatus(new LucidTenantStore()).execute(small.code, 'SUSPENDED')
    for (const [method, url] of [
      ['get', '/context'],
      ['get', '/roles'],
      ['get', '/parties'],
      ['get', '/organizations'],
      ['post', '/people'],
      ['get', '/memberships'],
    ] as const) {
      const response = await call(client, method, url, {
        actor: admin,
        tenantId: small.id,
        body: {},
      })
      assert.strictEqual(response.status(), 403, url)
      assert.strictEqual(response.body().error.code, 'TENANT_NOT_ACTIVE', url)
    }
    // Quem não é membro do tenant suspenso vê o mesmo que num tenant inexistente.
    const outsider = await call(client, 'get', '/roles', { actor: a.admin, tenantId: small.id })
    assert.strictEqual(outsider.body().error.code, 'TENANT_ACCESS_DENIED')
  })

  test('base de dados: toda a tabela de tenant está coberta pelo cenário e isolada por RLS', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const owner = db.connection('owner')
    const tables = (
      await owner.rawQuery(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
          order by c.table_name`
      )
    ).rows
      .map((r: { table_name: string }) => r.table_name)
      // `tenant_domains` tem `tenant_id` mas é global (plano de controlo): consta de PLATFORM_TABLES.
      .filter((t: string) => !PLATFORM_TABLES.has(`public.${t}`)) as string[]
    assert.isAbove(tables.length, 15)

    const asTenant = <T>(
      connection: string,
      tenantId: string | null,
      fn: (trx: any) => Promise<T>
    ) =>
      db.connection(connection).transaction(async (trx) => {
        if (tenantId) await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenantId])
        return fn(trx)
      }) as Promise<T>
    const count = async (trx: any, sql: string): Promise<number> => {
      const result = await trx.rawQuery(sql)
      return result.rows[0].n as number
    }

    for (const table of tables) {
      const ownerA = await asTenant('owner', a.tenant.id, (trx) =>
        count(trx, `select count(*)::int as n from ${table} where tenant_id = '${a.tenant.id}'`)
      )
      const ownerB = await asTenant('owner', b.tenant.id, (trx) =>
        count(trx, `select count(*)::int as n from ${table} where tenant_id = '${b.tenant.id}'`)
      )
      assert.isAbove(ownerA, 0, `${table}: o cenário não tem dados de A (estenda matrix_fixture)`)
      assert.isAbove(ownerB, 0, `${table}: o cenário não tem dados de B (estenda matrix_fixture)`)

      // Sem contexto: nada. Com contexto de A: só A, e tudo o que é de A.
      assert.strictEqual(
        await asTenant('runtime', null, (trx) =>
          count(trx, `select count(*)::int as n from ${table}`)
        ),
        0,
        `${table} sem contexto`
      )
      const seenByA = await asTenant('runtime', a.tenant.id, (trx) =>
        count(trx, `select count(*)::int as n from ${table}`)
      )
      assert.strictEqual(seenByA, ownerA, `${table}: A vê exactamente os seus`)
      assert.strictEqual(
        await asTenant('runtime', a.tenant.id, (trx) =>
          count(trx, `select count(*)::int as n from ${table} where tenant_id <> '${a.tenant.id}'`)
        ),
        0,
        `${table}: A não vê linhas de B`
      )

      if (
        table === 'rule_evaluations' ||
        table === 'state_history' ||
        table === 'stock_movements' ||
        table === 'transfer_receipts' ||
        table === 'transfer_receipt_lines'
      ) {
        // Registo de avaliações: só acrescenta (trigger de imutabilidade); RLS continua a filtrar a leitura.
        for (const sql of [
          `delete from ${table} where tenant_id = '${a.tenant.id}'`,
          `update ${table} set tenant_id = '${b.tenant.id}' where tenant_id = '${a.tenant.id}'`,
        ]) {
          const denied = await capture(() =>
            asTenant('runtime', a.tenant.id, (t) => t.rawQuery(sql))
          )
          assert.match(denied.message, /imut|permission denied/, `${table}: ${sql.split(' ')[0]}`)
        }
        continue
      }

      if (table === 'audit_logs') {
        // Imutável: a conta de runtime nem sequer tem privilégios de escrita (mais forte do que a RLS).
        for (const sql of [
          `delete from ${table} where tenant_id = '${a.tenant.id}'`,
          `update ${table} set reason = 'x' where tenant_id = '${a.tenant.id}'`,
          `insert into ${table} (tenant_id, action, resource_type, actor_type) values ('${a.tenant.id}', 'X', 'x', 'USER')`,
        ]) {
          const denied = await capture(() =>
            asTenant('runtime', a.tenant.id, (t) => t.rawQuery(sql))
          )
          assert.match(denied.message, /permission denied/, `${table}: ${sql.split(' ')[0]}`)
        }
        continue
      }

      // Não consegue apagar nem mudar linhas de B, nem passar as suas para B (WITH CHECK).
      const deleted = await asTenant('runtime', a.tenant.id, (trx) =>
        count(
          trx,
          `with d as (delete from ${table} where tenant_id = '${b.tenant.id}' returning 1) select count(*)::int as n from d`
        )
      )
      assert.strictEqual(deleted, 0, `${table}: delete cruzado`)
      const moved = await capture(() =>
        asTenant('runtime', a.tenant.id, (trx) =>
          trx.rawQuery(
            `update ${table} set tenant_id = '${b.tenant.id}' where tenant_id = '${a.tenant.id}'`
          )
        )
      )
      // Versões publicadas e campos são imutáveis (trigger BEFORE UPDATE, que dispara antes do WITH CHECK da RLS).
      const immutable = [
        'entity_schema_versions',
        'field_definitions',
        'rule_definitions',
        'form_definitions',
        'state_machines',
        'workflow_definitions',
        'suppliers',
        'purchase_requisitions',
        'purchase_orders',
        'goods_receipts',
        'stock_transfers',
        'transfer_lines',
        'stock_counts',
        'count_lines',
        'goods_returns',
        'return_lines',
        'treasury_accounts',
        'receivables',
        'payables',
        'payments',
        'supplier_invoices',
        'treasury_entries',
        'credit_applications',
        'bank_statement_lines',
        'reconciliation_matches',
        'opportunity_stage_history',
        'contracts',
        'invoices',
        'invoice_lines',
        'credit_notes',
        'credit_note_lines',
      ].includes(table)
      assert.match(
        moved.message,
        immutable
          ? /row-level security|PUBLISHED_VERSION_IMMUTABLE|PUBLISHED_RULE_IMMUTABLE|PUBLISHED_FORM_IMMUTABLE|PUBLISHED_STATE_MACHINE_IMMUTABLE|PUBLISHED_WORKFLOW_IMMUTABLE|WORKFLOW_TERMINAL_IMMUTABLE|CONTRACT_IMMUTABLE|INVOICE_IMMUTABLE|INVOICE_LINES_IMMUTABLE|CREDIT_NOTE_IMMUTABLE|CREDIT_NOTE_LINES_IMMUTABLE|REQUISITION_IMMUTABLE|PURCHASE_ORDER_IMMUTABLE|GOODS_RECEIPT_IMMUTABLE|REQUISITION_LINES_IMMUTABLE|PURCHASE_LINES_IMMUTABLE|GOODS_RECEIPT_LINES_IMMUTABLE|STOCK_TRANSFER_IMMUTABLE|TRANSFER_LINES_IMMUTABLE|STOCK_COUNT_IMMUTABLE|COUNT_LINES_IMMUTABLE|GOODS_RETURN_IMMUTABLE|RETURN_LINES_IMMUTABLE|OBLIGATION_IMMUTABLE|PAYMENT_IMMUTABLE|SUPPLIER_INVOICE_IMMUTABLE|FINANCE_APPEND_ONLY|STATEMENT_LINE_IMMUTABLE|MATCH_IMMUTABLE|CRM_APPEND_ONLY/
          : /row-level security/,
        `${table}: mover linhas para B`
      )
    }
  })

  test('base de dados: uma linha de um tenant nunca referencia outro (FKs compostas)', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    // O id da pessoa de B lê-se com o contexto de B (para A a RLS esconderia a linha e o teste seria vazio).
    const personIdOfB = await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [b.tenant.id])
      const row = await trx.from('people').where('party_id', b.ids.personParty).first()
      return row.id as string
    })
    const attempt = (sql: string, params: unknown[]) =>
      capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [a.tenant.id])
          await trx.rawQuery(sql, params as never)
        })
      )
    const cases: [string, string, unknown[]][] = [
      [
        'atribuição de A a papel de B',
        `insert into role_assignments (tenant_id, membership_id, role_id) values (?, ?, ?)`,
        [a.tenant.id, a.operator.membershipId, b.ids.role],
      ],
      [
        'atribuição de A a membro de B',
        `insert into role_assignments (tenant_id, membership_id, role_id) values (?, ?, ?)`,
        [a.tenant.id, b.operator.membershipId, a.ids.role],
      ],
      [
        'contacto de A em party de B',
        `insert into contacts (tenant_id, party_id, type, value, value_key) values (?, ?, 'EMAIL', 'x@y.zz', 'x@y.zz')`,
        [a.tenant.id, b.ids.personParty],
      ],
      [
        'unidade de A com organização de B',
        `insert into organization_units (tenant_id, organization_id, code, name) values (?, ?, 'ZZ', 'zz')`,
        [a.tenant.id, b.ids.organization],
      ],
      [
        'equipa de A em unidade de B',
        `insert into team_members (tenant_id, unit_id, membership_id, starts_on) values (?, ?, ?, '2026-01-01')`,
        [a.tenant.id, b.ids.unitRoot, a.operator.membershipId],
      ],
      [
        'relação de A para party de B',
        `insert into party_relationships (tenant_id, source_party_id, target_party_id, relationship_type) values (?, ?, ?, 'X')`,
        [a.tenant.id, a.ids.personParty, b.ids.organizationParty],
      ],
      [
        'membership de A ligada a pessoa de B',
        `update tenant_memberships set person_id = ? where id = ?`,
        [personIdOfB, a.operator.membershipId],
      ],
    ]
    for (const [label, sql, params] of cases) {
      const error = await attempt(sql, params).catch((e) => {
        throw new Error(`${label}: ${e.message}`)
      })
      assert.match(
        error.message,
        /violates (foreign key|row-level security)|null value|not-null/i,
        label
      )
    }
  })

  test('Redis: nenhuma chave guarda dados de tenant sem prefixo de tenant', async ({
    client,
    assert,
  }) => {
    await worlds(client)
    const keys = await redis.keys('*')
    // Prefixos permitidos hoje: contadores de rate limit (por IP/conta, sem dados de negócio) e a caixa
    // de desenvolvimento. Qualquer cache, fila ou canal novo tem de usar `tenant:{id}:` e ser listado aqui.
    const allowed = /^(ratelimit:|dev:mailbox$|tenant:[0-9a-f-]{36}:)/
    const unexpected = keys.filter((k) => !allowed.test(k))
    assert.isEmpty(unexpected, `chaves fora do padrão: ${unexpected.join(', ')}`)
    assert.isFalse(
      keys.some((k) => k.includes(SHARED.personEmail)),
      'nenhum email de cadastro em chaves'
    )
  })
})
