import type {
  PlatformGrant,
  PlatformPermission,
  ProvisioningStep,
} from '#platform/administration/domain/platform'

export interface GrantStore {
  /** `null` se já existir uma concessão em aberto para o par utilizador/permissão. */
  insert(input: {
    userId: string
    permission: PlatformPermission
    reason: string
    expiresAt: Date | null
  }): Promise<PlatformGrant | null>
  revoke(userId: string, permission: PlatformPermission, now: Date): Promise<boolean>
  forUser(userId: string): Promise<PlatformGrant[]>
  list(): Promise<PlatformGrant[]>
}

export interface TenantSummary {
  id: string
  code: string
  name: string
  status: string
  plan: { code: string; revision: number; status: string } | null
}

export interface ProvisioningState {
  tenant: TenantSummary
  /** Passos já concluídos. */
  done: ProvisioningStep[]
  organizations: number
  pendingInvitations: number
}

/** Operações de I/O do provisionamento, implementadas sobre as APIs públicas dos outros módulos. */
export interface ProvisioningGateway {
  findTenant(code: string): Promise<{ id: string; code: string; status: string } | null>
  /** `false` se o código já existia (criação concorrente). */
  createTenant(input: { code: string; name: string }): Promise<boolean>
  assignPlan(input: {
    tenantId: string
    planCode: string
    revision?: number
    trialDays?: number
  }): Promise<void>
  ensureAdminRole(tenantId: string): Promise<{ roleId: string }>
  ensureInitialOrganization(tenantId: string, name: string): Promise<void>
  /** Idempotente: um convite pendente ou um membro já existente contam como feito. */
  inviteAdmin(tenantId: string, email: string, roleId: string): Promise<void>
  activate(code: string): Promise<void>
  state(tenantId: string): Promise<ProvisioningState>
  summarize(tenantId: string): Promise<TenantSummary | null>
  listTenants(): Promise<TenantSummary[]>
  /** Suspende/reactiva por código. */
  changeStatus(code: string, to: 'SUSPENDED' | 'ACTIVE'): Promise<void>
}

export interface Clock {
  now(): Date
}
