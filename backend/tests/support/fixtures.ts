import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'

export const PASSWORD = 'frase-de-teste-bem-longa'
let counter = 0

/** Fixtures pela conta dona (BYPASSRLS): preparam dados de vários tenants sem passar pela API. */
const owner = () => db.connection('owner')

export async function createUser(overrides: { email?: string; status?: string } = {}) {
  const email = overrides.email ?? `u${process.pid}-${Date.now()}-${counter++}@teste.invalid`
  const result = await owner().rawQuery(
    `insert into users (email, full_name, password_hash, status) values (?, ?, ?, ?) returning id, email`,
    [email, 'Pessoa de Teste', await hash.make(PASSWORD), overrides.status ?? 'ACTIVE']
  )
  return result.rows[0] as { id: string; email: string }
}

export async function createTenant(code = `T${counter++}${Date.now() % 100000}`) {
  const result = await owner().rawQuery(
    `insert into tenants (code, name, slug, country_code, default_currency) values (?, ?, ?, 'AO', 'AOA') returning id, code`,
    [code, `Empresa ${code}`, code.toLowerCase()]
  )
  return result.rows[0] as { id: string; code: string }
}

export async function addMembership(tenantId: string, userId: string, status = 'ACTIVE') {
  const result = await owner().rawQuery(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at) values (?, ?, ?, now()) returning id`,
    [tenantId, userId, status]
  )
  return (result.rows[0] as { id: string }).id
}

export async function cleanDatabase() {
  await owner().rawQuery(
    'truncate inventory_integration_events, inventory_accounting_events, inventory_valuation_accounts, stock_valuation_entries, stock_cost_adjustments, stock_cost_layers, stock_cost_pools, stock_serial_movements, stock_serials, stock_lot_events, stock_count_postings, stock_count_entries, stock_count_lines, stock_counts, stock_requisition_event_lines, stock_requisition_events, stock_requisition_lines, stock_requisitions, stock_transfer_event_lines, stock_transfer_events, stock_transfer_lines, stock_transfers, stock_document_confirmation_lines, stock_document_confirmations, stock_document_lines, stock_documents, stock_balances, stock_movements, stock_postings, stock_lots, warehouse_access, warehouse_locations, warehouses, product_kit_components, product_uom_conversions, product_variants, products, brands, product_categories, uoms, termination_tasks, termination_settlement_lines, employee_terminations, disciplinary_events, disciplinary_cases, employee_certificates, employee_competencies, training_enrollments, training_sessions, training_course_competencies, training_courses, competencies, payroll_postings, payroll_obligation_payments, payroll_obligations, payroll_rule_test_cases, payroll_result_lines, payroll_results, payroll_run_inputs, payroll_runs, payroll_periods, payroll_irt_brackets, payroll_rule_sets, employee_loan_installments, employee_loans, employee_pay_items, compensation_proposal_lines, compensation_proposals, pay_component_incidences, pay_components, leave_ledger, leave_requests, leave_policies, leave_types, employment_assignments, employment_contract_events, employment_contract_amendments, employment_contracts, onboarding_tasks, job_offers, job_evaluations, job_interviews, job_applications, candidates, job_requisitions, hr_settings, employees, member_preferences, fiscal_year_closings, close_tasks, statement_notes, statement_template_mappings, statement_template_lines, statement_templates, account_reconciliation_lines, account_reconciliations, fx_revaluation_lines, fx_revaluations, provision_movements, provisions, adjustment_occurrences, adjustment_schedule_lines, adjustment_schedules, fixed_asset_movements, fixed_asset_depreciations, fixed_assets, fixed_asset_classes, journal_line_allocation_values, journal_line_allocations, allocation_key_line_values, allocation_key_lines, allocation_keys, analytic_dimension_values, analytic_dimensions, posting_events, posting_rule_lines, posting_rules, journal_lines, journal_entries, journals, fiscal_periods, fiscal_years, accounts, account_charts, bank_accounts, calendar_holidays, calendars, document_series, exchange_rates, tenant_settings, tenant_profiles, attachments, approval_delegations, approval_decisions, approval_requests, approval_workflow_steps, approval_workflows, notifications, audit_events, tenant_entitlement_overrides, subscription_events, subscriptions, plan_features, plans, cost_centers, positions, departments, branches, legal_entities, membership_roles, role_permissions, roles, one_time_tokens, tenant_memberships, auth_sessions, rate_limit_counters, users, tenants restart identity cascade'
  )
}

/** Faz login e devolve os cabeçalhos (cookie de sessão e CSRF) para os pedidos seguintes. */
export async function login(client: any, email: string, password = PASSWORD) {
  const response = await client.post('/api/v1/auth/login').json({ email, password })
  const cookies = (response.headers()['set-cookie'] as string[]).map((c) => c.split(';')[0])
  const xsrf = cookies.find((c) => c.startsWith('XSRF-TOKEN='))!.split('=')[1]
  return { response, cookie: cookies.join('; '), xsrf }
}

/** Tenant com administrador (fluxo real de `tenant:create`). */
export async function tenantWithAdmin(
  code = `T${counter++}${Date.now() % 100000}`,
  withSubscription = true
) {
  const { createTenantWithAdmin } = await import('#modules/members/application/tenant_bootstrap')
  const admin = await createUser()
  const tenant = await createTenantWithAdmin({
    code,
    name: `Empresa ${code}`,
    countryCode: 'AO',
    defaultCurrency: 'AOA',
    adminEmail: admin.email,
  })
  if (withSubscription) await subscribe(tenant.id, await unlimitedPlan())
  return { tenant, admin }
}

/** Plano de teste com todas as funcionalidades e sem limites (criado uma vez por limpeza da base). */
export async function unlimitedPlan() {
  const { FEATURES, PlatformSubscriptionService } = await import('#modules/subscription/index')
  const service = new PlatformSubscriptionService()
  const existing = (await service.listPlans()).find((p) => p.code === 'TESTE_TUDO')
  if (existing) return existing.id
  const plan = await service.createPlan({
    code: 'TESTE_TUDO',
    name: 'Plano de teste (tudo)',
    features: FEATURES.map((f) => ({ featureCode: f.code })),
  })
  await service.setPlanStatus(plan.id, 'ACTIVE')
  return plan.id
}

export async function subscribe(tenantId: string, planId: string, trial = false) {
  const { PlatformSubscriptionService } = await import('#modules/subscription/index')
  return new PlatformSubscriptionService().start(tenantId, { planId, trial }, null)
}

export interface Session {
  cookie: string
  xsrf: string
  tenantId: string
}

/** Cliente autenticado numa empresa: aplica cookie, CSRF e X-Tenant-Id. */
export function as(client: any, s: Session) {
  const wrap = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string) =>
    client[method](url)
      .header('cookie', s.cookie)
      .header('x-xsrf-token', s.xsrf)
      .header('x-tenant-id', s.tenantId)
  return {
    get: (url: string) => wrap('get', url),
    post: (url: string, body: object = {}) => wrap('post', url).json(body),
    put: (url: string, body: object = {}) => wrap('put', url).json(body),
    patch: (url: string, body: object = {}) => wrap('patch', url).json(body),
    delete: (url: string) => wrap('delete', url),
  }
}

export async function signIn(
  client: any,
  email: string,
  tenantId: string,
  password = PASSWORD
): Promise<Session> {
  const { cookie, xsrf } = await login(client, email, password)
  return { cookie, xsrf, tenantId }
}

/** Último token enviado para um email (caixa de desenvolvimento), extraído da ligação. */
export async function lastTokenFor(email: string, purpose: 'INVITATION' | 'PASSWORD_RESET') {
  const { devMailboxMessages } = await import('#modules/identity/index')
  const message = [...devMailboxMessages()]
    .reverse()
    .find((m) => m.to === email && m.purpose === purpose)
  return message ? new URL(message.link, 'http://x').searchParams.get('token')! : null
}

/** Convida, aceita e entra: devolve a sessão de um membro com os perfis dados. */
export async function memberWithRoles(client: any, admin: Session, roleIds: string[]) {
  const email = `m${process.pid}-${Date.now()}-${counter++}@teste.invalid`
  const invited = await as(client, admin).post('/api/v1/members/invitations', {
    email,
    fullName: 'Membro de Teste',
    roles: roleIds.map((roleId) => ({ roleId })),
  })
  if (invited.status() !== 201) throw new Error(`convite falhou: ${JSON.stringify(invited.body())}`)
  const token = await lastTokenFor(email, 'INVITATION')
  const accepted = await client
    .post('/api/v1/auth/invitations/accept')
    .json({ token, password: PASSWORD })
  if (accepted.status() !== 200)
    throw new Error(`aceitação falhou: ${JSON.stringify(accepted.body())}`)
  return {
    session: await signIn(client, email, admin.tenantId),
    memberId: invited.body().data.member.id as string,
    email,
  }
}

export async function createRole(
  client: any,
  admin: Session,
  code: string,
  permissionCodes: string[]
) {
  const response = await as(client, admin).post('/api/v1/roles', {
    code,
    name: `Perfil ${code}`,
    permissionCodes,
  })
  if (response.status() !== 201)
    throw new Error(`perfil falhou: ${JSON.stringify(response.body())}`)
  return response.body().data as { id: string; version: number }
}
