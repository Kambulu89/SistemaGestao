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
}

/** Tabelas de tenant que não são auditadas, com o motivo (o teste de conformidade exige o resto). */
export const AUDIT_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  audit_logs: 'É a própria auditoria (imutável).',
  subscription_changes:
    'Histórico próprio e imutável da assinatura (C02), consultável em GET /tenant/subscription.',
  user_preferences:
    'Preferências pessoais de apresentação; sem efeito em acessos nem dados de negócio.',
}
