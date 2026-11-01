import { ApiError } from '#core/http/api_error'
import { isUuid, TenantContext } from '#core/tenancy/index'
import { grantsAccess, type Membership, type MembershipDirectory } from '#core/membership/index'
import { isOperational, normalizeHostname, type Tenant } from '#platform/tenants/domain/tenant'
import type { TenantStore } from '#platform/tenants/application/ports'

export interface TenantSelector {
  /** `X-Tenant-Id` */
  tenantId?: string
  /** `X-Tenant-Code` */
  tenantCode?: string
  /** Cabeçalho `Host` do pedido; só conta se for um domínio **verificado** de um tenant. */
  host?: string
}

/** Porta: unidades acessíveis à membership (MembershipScope), pedidas já dentro do tenant validado. */
export interface UnitScopeResolver {
  resolve(context: TenantContext, membershipId: string): Promise<string[]>
}

export interface ResolvedTenantContext {
  context: TenantContext
  tenant: Tenant
  membership: Membership
}

const denied = () => new ApiError(403, 'TENANT_ACCESS_DENIED', 'Não tem acesso a este tenant.')

const badSelector = (code: string, message: string) => new ApiError(400, code, message)

/**
 * Pipeline da spec §10.1 (passos após a autenticação): resolve o tenant candidato a partir do
 * selector, valida a membership **activa** e o estado do tenant e constrói o `TenantContext`.
 * O selector nunca é prova de autorização. Tenant inexistente e tenant sem membership dão a mesma
 * resposta (403), para não revelar que o tenant existe.
 */
export class ResolveTenantContext {
  constructor(
    private readonly tenants: TenantStore,
    private readonly memberships: MembershipDirectory,
    private readonly units: UnitScopeResolver
  ) {}

  async execute(input: {
    user: { id: string; locale: string | null }
    selector: TenantSelector
    correlationId: string
  }): Promise<ResolvedTenantContext> {
    const candidate = await this.resolveCandidate(input.selector)
    const tenant = candidate ? await this.load(candidate) : null
    const membership = tenant ? await this.memberships.findForUser(input.user.id, tenant.id) : null
    if (!tenant || !membership || !grantsAccess(membership)) throw denied()

    if (!isOperational(tenant.status)) {
      throw new ApiError(403, 'TENANT_NOT_ACTIVE', 'O tenant não está activo.')
    }

    const base = {
      tenantId: tenant.id,
      userId: input.user.id,
      membershipId: membership.id,
      organizationId: membership.defaultOrganizationId,
      actorType: 'USER' as const,
      permissionsVersion: membership.authorizationVersion,
      correlationId: input.correlationId,
      locale: input.user.locale ?? tenant.defaultLocale,
    }
    // Sem âmbitos atribuídos, o actor não tem acesso a nenhuma unidade (nega por omissão).
    const unitIds = await this.units.resolve(
      TenantContext.create({ ...base, unitScope: { kind: 'UNITS', unitIds: [] } }),
      membership.id
    )
    const context = TenantContext.create({ ...base, unitScope: { kind: 'UNITS', unitIds } })
    return { context, tenant, membership }
  }

  /** Um selector explícito (id ou código) e/ou o domínio verificado; se houver vários têm de coincidir. */
  private async resolveCandidate(
    selector: TenantSelector
  ): Promise<{ id: string } | { code: string } | null> {
    if (selector.tenantId && selector.tenantCode) {
      throw badSelector(
        'TENANT_SELECTOR_AMBIGUOUS',
        'Indique o tenant por id ou por código, não ambos.'
      )
    }
    if (selector.tenantId && !isUuid(selector.tenantId)) {
      throw badSelector('TENANT_SELECTOR_INVALID', 'O identificador do tenant é inválido.')
    }
    const explicit = selector.tenantId
      ? { id: selector.tenantId }
      : selector.tenantCode
        ? { code: selector.tenantCode.trim().toLowerCase() }
        : null

    const domain = selector.host
      ? await this.tenants.findDomainByHostname(normalizeHostname(selector.host.split(':')[0]))
      : null
    const fromDomain = domain?.verifiedAt ? { id: domain.tenantId } : null

    if (explicit && fromDomain) {
      const tenant = await this.load(explicit)
      if (tenant && tenant.id !== fromDomain.id) {
        throw badSelector(
          'TENANT_SELECTOR_MISMATCH',
          'O domínio e o tenant indicado não coincidem.'
        )
      }
      return explicit
    }
    const result = explicit ?? fromDomain
    if (!result) {
      throw badSelector(
        'TENANT_SELECTOR_REQUIRED',
        'Indique o tenant (X-Tenant-Id ou X-Tenant-Code).'
      )
    }
    return result
  }

  private load(candidate: { id: string } | { code: string }) {
    return 'id' in candidate
      ? this.tenants.findById(candidate.id)
      : this.tenants.findByCode(candidate.code)
  }
}

export interface MyTenant {
  id: string
  code: string
  name: string
  status: Tenant['status']
}

/** Tenants a que o utilizador pertence com membership activa (inclui os não activos, para a UI os mostrar). */
export class ListMyTenants {
  constructor(
    private readonly tenants: TenantStore,
    private readonly memberships: MembershipDirectory
  ) {}

  async execute(userId: string): Promise<MyTenant[]> {
    const all = await this.memberships.listForUser(userId)
    const active = all.filter((m) => grantsAccess(m))
    const tenants = await this.tenants.findByIds(active.map((m) => m.tenantId))
    return tenants
      .map(({ id, code, name, status }) => ({ id, code, name, status }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}
