import { ApiError } from '#core/http/api_error'
import type { TenantContext } from '#core/tenancy/index'

/** A membership de quem age; uma automação activa-se em nome de uma pessoa (nunca de um serviço). */
export function memberOf(context: TenantContext): string {
  if (!context.membershipId) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
  }
  return context.membershipId
}
