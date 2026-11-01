import type { HttpContext } from '@adonisjs/core/http'
import { envelope } from '#core/http/api_response'
import { vineAcceptValidator } from '#platform/tenants/presentation/validators'
import { tenantServices } from '#platform/tenants/presentation/composition'

export default class InvitationsController {
  /**
   * Aceita um convite. Exige sessão (a conta é a identidade global) mas **não** um tenant seleccionado:
   * o tenant vem do próprio token e a prova é o segredo mais o email da conta.
   */
  async accept(ctx: HttpContext) {
    const { token } = await ctx.request.validateUsing(vineAcceptValidator)
    const { user } = ctx.principal
    const result = await tenantServices().acceptInvitation.execute(
      { id: user.id, email: user.email },
      token
    )
    return envelope(ctx, result)
  }
}
