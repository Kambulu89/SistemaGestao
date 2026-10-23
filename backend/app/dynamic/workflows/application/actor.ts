import { ApiError } from '#core/http/api_error'
import type { TenantContext } from '#core/tenancy/index'

/** A membership de quem age; sem ela (ex.: um serviço) não há aprovações nem delegações. */
export function memberOf(context: TenantContext): string {
  if (!context.membershipId) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
  }
  return context.membershipId
}
