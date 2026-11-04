import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ok } from '#shared/http/respond'
import { AuthService } from '#modules/identity/application/auth_service'
import {
  clearSessionCookies,
  readSessionToken,
  setSessionCookies,
} from '#modules/identity/http/cookies'
import { TenantRepository, userTenantLinks } from '#modules/tenancy/index'
import type { User } from '#modules/identity/domain/user'

const loginValidator = vine.create({
  email: vine.string().trim().maxLength(254),
  password: vine.string().maxLength(200),
})

const auth = new AuthService()
const tenants = new TenantRepository()

export const presentUser = (u: User) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  isPlatformAdmin: u.isPlatformAdmin,
  lastLoginAt: u.lastLoginAt,
})

/** Empresas a que o utilizador pertence (para o seletor); só as memberships activas dão acesso. */
async function myTenants(userId: string) {
  const links = await userTenantLinks(userId)
  const found = await tenants.findMany(links.map((l) => l.tenantId))
  return found.map((t) => {
    const link = links.find((l) => l.tenantId === t.id)!
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      status: t.status,
      membershipStatus: link.status,
      available: t.status === 'ACTIVE' && link.status === 'ACTIVE',
    }
  })
}

export default class AuthController {
  async login(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(loginValidator)
    const { user, sessionToken } = await auth.login(body, {
      ip: ctx.request.ip(),
      userAgent: ctx.request.header('user-agent') ?? null,
    })
    setSessionCookies(ctx, sessionToken)
    return ok(ctx, { user: presentUser(user), tenants: await myTenants(user.id) })
  }

  async logout(ctx: HttpContext) {
    const token = readSessionToken(ctx)
    if (token) await auth.logout(token)
    clearSessionCookies(ctx)
    return ok(ctx, { loggedOut: true })
  }

  async me(ctx: HttpContext) {
    const user = ctx.authUser!
    return ok(ctx, { user: presentUser(user), tenants: await myTenants(user.id) })
  }
}
