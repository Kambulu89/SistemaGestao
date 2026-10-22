import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { securityEvents } from '#core/audit/index'
import { ApiError } from '#core/http/api_error'
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

    const ip = request.ip() || null
    let result
    try {
      result = await login.execute({
        ...input,
        ip,
        userAgent: request.header('user-agent') ?? null,
      })
    } catch (error) {
      // O email tentado não é gravado (podia ser uma palavra-passe digitada no campo errado).
      if (error instanceof ApiError && error.status === 429) {
        await securityEvents.record({
          type: 'LOGIN_RATE_LIMITED',
          severity: 'HIGH',
          metadata: { ip },
        })
      } else if (error instanceof ApiError && error.status === 401) {
        await securityEvents.record({ type: 'LOGIN_FAILED', severity: 'WARN', metadata: { ip } })
      }
      throw error
    }
    await securityEvents.record({
      type: 'LOGIN_SUCCEEDED',
      severity: 'INFO',
      userId: result.user.id,
      metadata: { ip },
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
    await securityEvents.record({ type: 'LOGOUT', severity: 'INFO', userId: ctx.principal.user.id })
    ctx.response.clearCookie(SESSION_COOKIE)
    return ctx.response.noContent()
  }

  /** Responde sempre 202 com o mesmo corpo, exista ou não a conta. */
  async forgotPassword(ctx: HttpContext) {
    const { email } = await ctx.request.validateUsing(forgotPasswordValidator)
    await authServices().requestPasswordReset.execute({ email, ip: ctx.request.ip() || null })
    // Sem utilizador nem email: a resposta não pode distinguir contas existentes.
    await securityEvents.record({ type: 'PASSWORD_RESET_REQUESTED', severity: 'INFO' })
    ctx.response.status(202)
    return envelope(ctx, {
      message: 'Se existir uma conta com esse email, enviámos instruções para recuperar o acesso.',
    })
  }

  async resetPassword(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(resetPasswordValidator)
    await authServices().resetPassword.execute(input)
    await securityEvents.record({ type: 'PASSWORD_RESET_COMPLETED', severity: 'INFO' })
    return ctx.response.noContent()
  }

  async verifyEmail(ctx: HttpContext) {
    const { token } = await ctx.request.validateUsing(verifyEmailValidator)
    await authServices().verifyEmail.execute(token)
    return ctx.response.noContent()
  }
}
