import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { envelope } from '#core/http/api_response'
import { SESSION_TTL_SECONDS, type User } from '#core/auth/domain/identity'
import { SESSION_COOKIE, authServices } from '#core/auth/presentation/composition'
import {
  forgotPasswordValidator,
  loginValidator,
  resetPasswordValidator,
  verifyEmailValidator,
} from '#core/auth/presentation/validators'

export const userView = (user: User) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  locale: user.locale,
})

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class AuthController {
  async login(ctx: HttpContext) {
    const { request, response } = ctx
    const input = await request.validateUsing(loginValidator)
    const services = authServices()
    const login = await services.loginPromise

    const result = await login.execute({
      ...input,
      ip: request.ip() || null,
      userAgent: request.header('user-agent') ?? null,
    })

    response.plainCookie(SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: app.inProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })
    return envelope(ctx, {
      user: userView(result.user),
      csrfToken: services.csrf.issue(result.session.id),
      expiresAt: result.session.expiresAt,
    })
  }

  async logout(ctx: HttpContext) {
    await authServices().logout.execute(ctx.principal)
    ctx.response.clearCookie(SESSION_COOKIE)
    return ctx.response.noContent()
  }

  /** Responde sempre 202 com o mesmo corpo, exista ou não a conta. */
  async forgotPassword(ctx: HttpContext) {
    const { email } = await ctx.request.validateUsing(forgotPasswordValidator)
    await authServices().requestPasswordReset.execute({ email, ip: ctx.request.ip() || null })
    ctx.response.status(202)
    return envelope(ctx, {
      message: 'Se existir uma conta com esse email, enviámos instruções para recuperar o acesso.',
    })
  }

  async resetPassword(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(resetPasswordValidator)
    await authServices().resetPassword.execute(input)
    return ctx.response.noContent()
  }

  async verifyEmail(ctx: HttpContext) {
    const { token } = await ctx.request.validateUsing(verifyEmailValidator)
    await authServices().verifyEmail.execute(token)
    return ctx.response.noContent()
  }
}
