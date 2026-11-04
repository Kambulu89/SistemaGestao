import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ApiError } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { TenantRepository } from '#modules/tenancy/infrastructure/tenant_repository'
import { userTenantLinks } from '#modules/tenancy/infrastructure/membership_lookup'

export const TENANT_HEADER = 'x-tenant-id'
const tenants = new TenantRepository()

/**
 * Resolve o contexto de tenant no servidor: o `X-Tenant-Id` é só um selector, validado contra a membership **activa** do
 * utilizador autenticado e o estado do tenant. Sem membership activa: 403 (sem revelar se o tenant existe).
 */
export default class TenantMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.authUser
    if (!user) throw ApiError.unauthenticated()
    const tenantId = ctx.request.header(TENANT_HEADER)
    if (!tenantId)
      throw ApiError.badRequest('TENANT_REQUIRED', 'Indique a empresa (cabeçalho X-Tenant-Id).')
    if (!isUuid(tenantId))
      throw ApiError.badRequest('TENANT_INVALID', 'Identificador de empresa inválido.')
    const link = (await userTenantLinks(user.id)).find(
      (l) => l.tenantId === tenantId && l.status === 'ACTIVE'
    )
    if (!link) throw ApiError.forbidden('TENANT_ACCESS_DENIED', 'Sem acesso a esta empresa.')
    const tenant = await tenants.find(tenantId)
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw ApiError.forbidden('TENANT_UNAVAILABLE', 'A empresa está suspensa ou arquivada.')
    }
    ctx.tenant = tenant
    ctx.tenantContext = {
      tenantId,
      userId: user.id,
      membershipId: link.membershipId,
      requestId: ctx.request.id() ?? '',
    }
    return next()
  }
}
