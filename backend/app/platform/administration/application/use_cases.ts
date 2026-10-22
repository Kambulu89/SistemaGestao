import { DateTime } from 'luxon'
import { ApiError } from '#core/http/api_error'
import {
  grantActive,
  isPlatformPermission,
  type PlatformGrant,
  type PlatformPermission,
  PROVISIONING_STEPS,
} from '#platform/administration/domain/platform'
import type {
  Clock,
  GrantStore,
  ProvisioningGateway,
  ProvisioningState,
  TenantSummary,
} from '#platform/administration/application/ports'

const systemClock: Clock = { now: () => new Date() }

const invalid = (path: string, code: string, message: string) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [{ path, code, message }])

// --- concessões ---------------------------------------------------------------------------------

export class AuthorizePlatform {
  constructor(
    private readonly grants: GrantStore,
    private readonly clock: Clock = systemClock
  ) {}

  /** Nega por omissão: sem concessão em vigor para a permissão pedida, não há acesso. */
  async has(userId: string, permission: PlatformPermission): Promise<boolean> {
    const now = this.clock.now()
    const grants = await this.grants.forUser(userId)
    return grants.some((g) => g.permission === permission && grantActive(g, now))
  }
}

export class GrantPlatformPermission {
  constructor(
    private readonly grants: GrantStore,
    private readonly clock: Clock = systemClock
  ) {}

  async execute(input: {
    userId: string
    permission: string
    reason: string
    expiresInDays?: number
  }): Promise<PlatformGrant> {
    if (!isPlatformPermission(input.permission)) {
      throw invalid('permission', 'UNKNOWN_PERMISSION', 'Permissão de plataforma desconhecida.')
    }
    if (!input.reason.trim()) {
      throw invalid('reason', 'REASON_REQUIRED', 'Indique o motivo da concessão.')
    }
    if (
      input.expiresInDays !== undefined &&
      !(
        Number.isInteger(input.expiresInDays) &&
        input.expiresInDays >= 1 &&
        input.expiresInDays <= 365
      )
    ) {
      throw invalid('expiresInDays', 'INVALID_EXPIRY', 'O prazo é de 1 a 365 dias.')
    }
    const expiresAt =
      input.expiresInDays === undefined
        ? null
        : DateTime.fromJSDate(this.clock.now()).plus({ days: input.expiresInDays }).toJSDate()
    const created = await this.grants.insert({
      userId: input.userId,
      permission: input.permission,
      reason: input.reason.trim().slice(0, 500),
      expiresAt,
    })
    if (!created) {
      throw ApiError.conflict('GRANT_EXISTS', 'O utilizador já tem esta permissão de plataforma.')
    }
    return created
  }
}

export class RevokePlatformPermission {
  constructor(
    private readonly grants: GrantStore,
    private readonly clock: Clock = systemClock
  ) {}

  async execute(userId: string, permission: string): Promise<void> {
    if (!isPlatformPermission(permission)) {
      throw invalid('permission', 'UNKNOWN_PERMISSION', 'Permissão de plataforma desconhecida.')
    }
    if (!(await this.grants.revoke(userId, permission, this.clock.now()))) {
      throw ApiError.notFound('Não há concessão em aberto para esta permissão.')
    }
  }
}

export class ListPlatformGrants {
  constructor(private readonly grants: GrantStore) {}
  execute() {
    return this.grants.list()
  }
}

// --- provisionamento e ciclo de vida ------------------------------------------------------------

export interface ProvisionInput {
  code: string
  name: string
  adminEmail: string
  planCode: string
  planRevision?: number
  trialDays?: number
}

export interface ProvisionResult extends ProvisioningState {
  created: boolean
}

/**
 * Provisiona um tenant: cria-o em PROVISIONING, atribui o plano, garante o papel de administrador e a
 * organização inicial, convida o administrador (o convite segue por email; nenhuma palavra-passe é
 * pedida) e só então o activa. Cada passo é idempotente: repetir o pedido, ou retomá-lo depois de uma
 * falha, não duplica a organização nem o convite. Uma falha deixa o tenant em PROVISIONING.
 */
export class ProvisionTenant {
  constructor(private readonly gateway: ProvisioningGateway) {}

  async execute(input: ProvisionInput): Promise<ProvisionResult> {
    const code = input.code.trim().toLowerCase()
    const email = input.adminEmail.trim().toLowerCase()
    if (!/^[a-z0-9_]{2,50}$/.test(code)) {
      throw invalid('code', 'INVALID_CODE', 'O código usa 2–50 caracteres: a-z, 0-9 e _.')
    }
    if (!input.name.trim() || input.name.length > 160) {
      throw invalid('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).')
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw invalid('adminEmail', 'INVALID_EMAIL', 'O email do administrador não é válido.')
    }

    let tenant = await this.gateway.findTenant(code)
    let created = false
    if (!tenant) {
      created = await this.gateway.createTenant({ code, name: input.name.trim() })
      tenant = await this.gateway.findTenant(code)
    }
    if (!tenant) throw new Error('Tenant não encontrado após a criação')
    if (tenant.status !== 'PROVISIONING' && tenant.status !== 'ACTIVE') {
      throw ApiError.conflict(
        'TENANT_NOT_PROVISIONABLE',
        `O tenant está ${tenant.status}; não se provisiona de novo.`
      )
    }

    await this.gateway.assignPlan({
      tenantId: tenant.id,
      planCode: input.planCode,
      revision: input.planRevision,
      trialDays: input.trialDays,
    })
    const { roleId } = await this.gateway.ensureAdminRole(tenant.id)
    await this.gateway.ensureInitialOrganization(tenant.id, input.name.trim())
    await this.gateway.inviteAdmin(tenant.id, email, roleId)
    if (tenant.status === 'PROVISIONING') await this.gateway.activate(code)

    return { created, ...(await this.gateway.state(tenant.id)) }
  }
}

export class ListPlatformTenants {
  constructor(private readonly gateway: ProvisioningGateway) {}
  execute(): Promise<TenantSummary[]> {
    return this.gateway.listTenants()
  }
}

export class GetPlatformTenant {
  constructor(private readonly gateway: ProvisioningGateway) {}

  async execute(tenantId: string): Promise<ProvisioningState & { pending: string[] }> {
    const state = await this.gateway.state(tenantId)
    return { ...state, pending: PROVISIONING_STEPS.filter((s) => !state.done.includes(s)) }
  }
}

/** Suspender impede novas operações empresariais (o tenant deixa de ser operacional); reactivar repõe. */
export class ChangeTenantLifecycle {
  constructor(private readonly gateway: ProvisioningGateway) {}

  async execute(tenantId: string, to: 'SUSPENDED' | 'ACTIVE'): Promise<TenantSummary> {
    const summary = await this.gateway.summarize(tenantId)
    if (!summary) throw ApiError.notFound('Tenant não encontrado.')
    if (summary.status === to) return summary
    await this.gateway.changeStatus(summary.code, to)
    const after = await this.gateway.summarize(tenantId)
    if (!after) throw ApiError.notFound('Tenant não encontrado.')
    return after
  }
}
