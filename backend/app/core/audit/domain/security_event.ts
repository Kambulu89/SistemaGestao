export const SECURITY_EVENT_TYPES = [
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'LOGIN_RATE_LIMITED',
  'LOGOUT',
  'REAUTHENTICATION_FAILED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED',
  'CSRF_REJECTED',
  'ORIGIN_REJECTED',
  'TENANT_ACCESS_DENIED',
  'PERMISSION_DENIED',
  'PLATFORM_ACCESS_DENIED',
  'PLATFORM_GRANT_CHANGED',
  'PLATFORM_ACTION',
  // Gerados pelos triggers da base (não pela aplicação):
  'USER_CREATED',
  'PASSWORD_CHANGED',
  'USER_STATUS_CHANGED',
  'TENANT_CREATED',
  'TENANT_STATUS_CHANGED',
] as const

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number]
export type Severity = 'INFO' | 'WARN' | 'HIGH'

export interface SecurityEventInput {
  type: SecurityEventType
  severity: Severity
  /** Só quando o evento pertence a um tenant (contexto explícito). */
  tenantId?: string | null
  userId?: string | null
  /** Sem segredos nem dados de negócio: é redigido antes de gravar. */
  metadata?: Record<string, unknown>
}

export interface SecurityEventView {
  id: string
  type: string
  severity: Severity
  tenantId: string | null
  userId: string | null
  metadata: Record<string, unknown>
  occurredAt: Date
}

/** Recurso auditado → permissão de leitura necessária para ver o seu histórico (nega por omissão). */
export const AUDIT_READ_PERMISSION: Readonly<Record<string, string>> = {
  tenant_memberships: 'member.read',
  invitations: 'member.read',
  roles: 'iam.read',
  role_permissions: 'iam.read',
  role_assignments: 'iam.read',
  access_policies: 'iam.read',
  membership_scopes: 'iam.read',
  organizations: 'organization.read',
  organization_units: 'organization.read',
  cost_centers: 'organization.read',
  team_members: 'organization.read',
  parties: 'party.read',
  people: 'party.read',
  organization_parties: 'party.read',
  contacts: 'party.read',
  addresses: 'party.read',
  party_relationships: 'party.read',
  tenant_domains: 'iam.read',
  subscriptions: 'subscription.read',
  tenant_modules: 'module.read',
  setting_values: 'settings.read',
  tax_rates: 'settings.read',
  units_of_measure: 'settings.read',
  sequences: 'settings.read',
  tenant_features: 'module.read',
  entity_definitions: 'entity.read',
  entity_schema_versions: 'entity.read',
  field_definitions: 'entity.read',
  dynamic_records: 'dynamic.read',
  dynamic_unique_values: 'dynamic.read',
  rule_definitions: 'rule.read',
  form_definitions: 'form.read',
  state_machines: 'state.read',
  record_states: 'dynamic.read',
  workflow_definitions: 'workflow.read',
  workflow_instances: 'workflow.read',
  workflow_tasks: 'workflow.read',
  approval_delegations: 'workflow.read',
  automations: 'automation.read',
  automation_runs: 'automation.read',
  product_categories: 'catalog.read',
  products: 'catalog.read',
  product_variants: 'catalog.read',
  customer_segments: 'customer.read',
  customers: 'customer.read',
  interactions: 'customer.read',
  sales_quotes: 'quote.read',
  sales_orders: 'order.read',
  sales_lines: 'order.read',
  price_lists: 'price.read',
  price_list_items: 'price.read',
  shipments: 'shipment.read',
  shipment_lines: 'shipment.read',
  contracts: 'contract.read',
  invoices: 'invoice.read',
  invoice_lines: 'invoice.read',
  credit_notes: 'invoice.read',
  credit_note_lines: 'invoice.read',
  suppliers: 'supplier.read',
  purchase_requisitions: 'requisition.read',
  requisition_lines: 'requisition.read',
  purchase_orders: 'purchase.read',
  purchase_lines: 'purchase.read',
  goods_receipts: 'receipt.read',
  goods_receipt_lines: 'receipt.read',
  treasury_accounts: 'treasury.read',
  treasury_entries: 'treasury.read',
  receivables: 'receivable.read',
  credit_applications: 'receivable.read',
  credit_reservations: 'receivable.read',
  payables: 'payable.read',
  payments: 'payment.read',
  payment_allocations: 'payment.read',
  supplier_invoices: 'supplier_invoice.read',
  supplier_invoice_lines: 'supplier_invoice.read',
  warehouses: 'inventory.read',
  stock_locations: 'inventory.read',
  lots: 'inventory.read',
  stock_balances: 'inventory.read',
  stock_movements: 'inventory.read',
  stock_costs: 'inventory.read',
  stock_reservations: 'inventory.read',
}

/** Tabelas de tenant que não são auditadas, com o motivo (o teste de conformidade exige o resto). */
export const AUDIT_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  audit_logs: 'É a própria auditoria (imutável).',
  subscription_changes:
    'Histórico próprio e imutável da assinatura (C02), consultável em GET /tenant/subscription.',
  rule_evaluations:
    'Registo próprio e só de acrescentar das avaliações de regras (C12), consultável em GET /rules/{id}/evaluations.',
  state_history:
    'Histórico próprio e só de acrescentar das transições de estado (C13), consultável em GET /dynamic/{entity}/records/{id}/state-history.',
  outbox_deliveries:
    'Inbox técnica do consumo do outbox (um evento por consumidor); só regista que o evento foi entregue.',
  outbox_events:
    'Fila técnica do outbox transaccional: o evento é escrito com a alteração que o originou (já auditada) e só muda de estado ao ser publicado.',
  user_preferences:
    'Preferências pessoais de apresentação; sem efeito em acessos nem dados de negócio.',
}
