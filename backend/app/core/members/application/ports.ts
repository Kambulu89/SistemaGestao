import type { TenantScope } from '#core/tenancy/index'
import type { Invitation, InvitationStatus } from '#core/members/domain/invitation'

export interface UserSummary {
  id: string
  email: string
  displayName: string
}

/** Leitura de contas (identidade global), fornecida pelo módulo de autenticação. */
export interface UserDirectory {
  findByEmail(normalizedEmail: string): Promise<UserSummary | null>
  findByIds(ids: readonly string[]): Promise<UserSummary[]>
}

export interface InvitationMessage {
  to: string
  token: string
  expiresAt: Date
}

/** Entrega do convite (email). O fornecedor real é uma decisão de produto pendente (D-021). */
export interface InvitationMailer {
  send(message: InvitationMessage): Promise<void>
}

/** Estado do tenant (plano de controlo), fornecido pela plataforma. */
export interface TenantGate {
  isOperational(tenantId: string): Promise<boolean>
}

/** Limite de membros do tenant, vindo do plano contratado (`null` = ilimitado; 0 = sem direitos activos). */
export interface MemberQuota {
  limit(tenantId: string): Promise<number | null>
}

export interface InvitationStore {
  /** `null` se já existir um convite pendente para o email. */
  insert(
    scope: TenantScope,
    input: {
      email: string
      tokenHash: string
      invitedByMembershipId: string | null
      expiresAt: Date
      roleIds: string[]
      unitIds: string[]
    }
  ): Promise<Invitation | null>
  /** Passa a `EXPIRED` os convites pendentes já fora de prazo para o email (libertam o lugar de "pendente"). */
  expirePending(scope: TenantScope, email: string, now: Date): Promise<void>
  list(scope: TenantScope): Promise<Invitation[]>
  findById(scope: TenantScope, id: string): Promise<Invitation | null>
  findByHash(scope: TenantScope, tokenHash: string): Promise<Invitation | null>
  setStatus(
    scope: TenantScope,
    invitation: Invitation,
    status: Extract<InvitationStatus, 'ACCEPTED' | 'REVOKED'>,
    now: Date
  ): Promise<void>
}

export interface PreferenceStore {
  list(scope: TenantScope, membershipId: string): Promise<Record<string, unknown>>
  upsert(scope: TenantScope, membershipId: string, key: string, value: unknown): Promise<void>
  remove(scope: TenantScope, membershipId: string, key: string): Promise<boolean>
}
