import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ok, created } from '#shared/http/respond'
import { ApiError } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { RoleService } from '#modules/rbac/application/role_service'
import { PERMISSIONS } from '#modules/rbac/domain/permissions'
import { permissionsFor } from '#modules/rbac/application/authorization'

const roleBody = {
  name: vine.string().trim().maxLength(120),
  description: vine.string().trim().maxLength(500).nullable().optional(),
  permissionCodes: vine.array(vine.string().trim().maxLength(80)).maxLength(500),
}
const createValidator = vine.create({ code: vine.string().trim().maxLength(50), ...roleBody })
const updateValidator = vine.create({
  expectedVersion: vine.number().withoutDecimals().min(1),
  code: vine.string().trim().optional(),
  name: roleBody.name.optional(),
  description: roleBody.description,
  status: vine.enum(['ACTIVE', 'INACTIVE']).optional(),
  permissionCodes: roleBody.permissionCodes.optional(),
})

const roles = new RoleService()
const idParam = (ctx: HttpContext) => {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte: valida e chama os casos de uso. */
export default class RolesController {
  async permissions(ctx: HttpContext) {
    return ok(ctx, PERMISSIONS)
  }

  /** Permissões efectivas do próprio na empresa em contexto (para o frontend esconder o que não pode usar). */
  async mine(ctx: HttpContext) {
    const granted = await permissionsFor(ctx.tenantContext!)
    return ok(ctx, { tenant: [...granted.tenant].sort(), own: [...granted.own].sort() })
  }

  async index(ctx: HttpContext) {
    return ok(ctx, await roles.list(ctx.tenantContext!))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await roles.get(ctx.tenantContext!, idParam(ctx)))
  }

  async store(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(createValidator)
    const role = await roles.create(ctx.tenantContext!, body)
    return created(ctx, role, `/api/v1/roles/${role.id}`)
  }

  async update(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(updateValidator)
    return ok(ctx, await roles.update(ctx.tenantContext!, idParam(ctx), body))
  }

  async destroy(ctx: HttpContext) {
    await roles.remove(ctx.tenantContext!, idParam(ctx))
    return ok(ctx, { deleted: true })
  }
}
