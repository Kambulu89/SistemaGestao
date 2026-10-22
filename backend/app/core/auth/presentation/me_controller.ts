import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { authServices } from '#core/auth/presentation/composition'
import { userView } from '#core/auth/presentation/auth_controller'
import { changePasswordValidator } from '#core/auth/presentation/validators'

export default class MeController {
  async show(ctx: HttpContext) {
    const { user, session } = ctx.principal
    return envelope(ctx, {
      user: userView(user),
      csrfToken: authServices().csrf.issue(session.id),
      session: { id: session.id, expiresAt: session.expiresAt },
    })
  }

  async sessions(ctx: HttpContext) {
    return envelope(ctx, await authServices().listSessions.execute(ctx.principal))
  }

  async revokeSession(ctx: HttpContext) {
    const id = ctx.params.id as string
    // Um id mal formado é "inexistente" (404), tal como um id de outro utilizador.
    if (!isUuid(id)) throw ApiError.notFound('Sessão não encontrada.')
    await authServices().revokeSession.execute(ctx.principal, id)
    return ctx.response.noContent()
  }

  async changePassword(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(changePasswordValidator)
    await authServices().changePassword.execute(ctx.principal, input)
    return ctx.response.noContent()
  }
}
