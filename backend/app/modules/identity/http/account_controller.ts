import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { AccountService } from '#modules/identity/application/account_service'
import { clearSessionCookies } from '#modules/identity/http/cookies'

const forgotValidator = vine.create({ email: vine.string().trim().maxLength(254) })
const resetValidator = vine.create({
  token: vine.string().trim().maxLength(200),
  password: vine.string().maxLength(200),
})
const accounts = new AccountService()

export default class AccountController {
  /** Resposta sempre igual (202), exista ou não a conta. */
  async forgotPassword(ctx: HttpContext) {
    const { email } = await ctx.request.validateUsing(forgotValidator)
    await accounts.requestPasswordReset(email)
    ctx.response.status(202)
    return ok(ctx, { requested: true })
  }

  async resetPassword(ctx: HttpContext) {
    const { token, password } = await ctx.request.validateUsing(resetValidator)
    await accounts.resetPassword(token, password)
    clearSessionCookies(ctx)
    return ok(ctx, { reset: true })
  }

  async sessions(ctx: HttpContext) {
    const items = await accounts.listSessions(ctx.authUser!.id)
    return ok(
      ctx,
      items.map((s) => ({ ...s, current: s.id === ctx.sessionId }))
    )
  }

  async revokeSession(ctx: HttpContext) {
    const id = ctx.params.id as string
    if (!isUuid(id)) throw ApiError.notFound()
    await accounts.revokeSession(ctx.authUser!.id, id)
    if (id === ctx.sessionId) clearSessionCookies(ctx)
    return ok(ctx, { revoked: true })
  }
}
