import { ApiError } from '#core/http/api_error'
import { generateOpaqueToken, hashToken, safeEqual } from '#core/auth/index'
import {
  canTransition,
  isValidHostname,
  isValidTenantCode,
  normalizeHostname,
  type Tenant,
  type TenantDomain,
  type TenantStatus,
} from '#platform/tenants/domain/tenant'
import type { TenantStore } from '#platform/tenants/application/ports'

const invalid = (path: string, code: string, message: string) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [{ path, code, message }])

export class CreateTenant {
  constructor(private readonly store: TenantStore) {}

  async execute(input: { code: string; name: string }): Promise<Tenant> {
    const code = input.code.trim().toLowerCase()
    if (!isValidTenantCode(code)) {
      throw invalid('code', 'INVALID_CODE', 'O código usa 2–50 caracteres: a-z, 0-9 e _.')
    }
    if (!input.name.trim() || input.name.length > 160) {
      throw invalid('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).')
    }
    const tenant = await this.store.insert({ code, name: input.name.trim() })
    if (!tenant)
      throw ApiError.conflict('TENANT_CODE_TAKEN', 'Já existe um tenant com este código.')
    return tenant
  }
}

export class ChangeTenantStatus {
  constructor(
    private readonly store: TenantStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(code: string, to: TenantStatus): Promise<Tenant> {
    const tenant = await this.store.findByCode(code)
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
    if (!canTransition(tenant.status, to)) {
      throw ApiError.conflict(
        'INVALID_STATE_TRANSITION',
        `Não é possível passar de ${tenant.status} para ${to}.`
      )
    }
    const updated = await this.store.updateStatus(tenant.id, to, tenant.version, this.now())
    if (!updated) throw ApiError.versionConflict(tenant.version + 1)
    return updated
  }
}

export class RegisterTenantDomain {
  constructor(private readonly store: TenantStore) {}

  /** Devolve o token de verificação (mostrado uma única vez; só o hash é guardado). */
  async execute(input: {
    code: string
    hostname: string
  }): Promise<{ domain: TenantDomain; verificationToken: string }> {
    const hostname = normalizeHostname(input.hostname)
    if (!isValidHostname(hostname)) {
      throw invalid('hostname', 'INVALID_HOSTNAME', 'O domínio não é válido.')
    }
    const tenant = await this.store.findByCode(input.code)
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')

    const verificationToken = generateOpaqueToken()
    const domain = await this.store.insertDomain({
      tenantId: tenant.id,
      hostname,
      verificationTokenHash: hashToken(verificationToken),
      isPrimary: !(await this.store.hasDomains(tenant.id)),
    })
    if (!domain) {
      throw ApiError.conflict('DOMAIN_ALREADY_REGISTERED', 'Este domínio já está registado.')
    }
    return { domain, verificationToken }
  }
}

export class VerifyTenantDomain {
  constructor(
    private readonly store: TenantStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(input: { hostname: string; verificationToken: string }): Promise<void> {
    const domain = await this.store.findDomainByHostname(normalizeHostname(input.hostname))
    if (!domain) throw ApiError.notFound('Domínio não encontrado.')
    if (domain.verifiedAt) return
    const expected = domain.verificationTokenHash ?? ''
    if (!expected || !safeEqual(expected, hashToken(input.verificationToken))) {
      throw new ApiError(400, 'INVALID_VERIFICATION_TOKEN', 'O token de verificação é inválido.')
    }
    await this.store.markDomainVerified(domain.id, this.now())
  }
}

/** Define a quota de membros do tenant (`null` retira o limite). Provisório até C02 (planos). */
export class SetMemberLimit {
  constructor(private readonly store: TenantStore) {}

  async execute(code: string, max: number | null): Promise<Tenant> {
    if (max !== null && !(Number.isInteger(max) && max >= 1)) {
      throw invalid('max', 'INVALID_LIMIT', 'O limite tem de ser um inteiro ≥ 1.')
    }
    const tenant = await this.store.findByCode(code.trim().toLowerCase())
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
    await this.store.setMaxMembers(tenant.id, max)
    return tenant
  }
}
