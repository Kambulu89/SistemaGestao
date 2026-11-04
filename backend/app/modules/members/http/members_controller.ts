import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { MemberService } from '#modules/members/application/member_service'

const listValidator = vine.create({
  status: vine.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
  q: vine.string().trim().maxLength(100).optional(),
  limit: vine.number().withoutDecimals().min(1).max(100).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
})
const roleRef = vine.object({
  roleId: vine.string().uuid(),
  scopeType: vine.enum(['TENANT', 'OWN']).optional(),
})
const inviteValidator = vine.create({
  email: vine.string().trim().maxLength(254),
  fullName: vine.string().trim().maxLength(160).nullable().optional(),
  roles: vine.array(roleRef).maxLength(20).optional(),
})
const versionValidator = vine.create({ expectedVersion: vine.number().withoutDecimals().min(1) })
const assignValidator = vine.create({
  roleId: vine.string().uuid(),
  scopeType: vine.enum(['TENANT', 'OWN']).optional(),
})

const members = new MemberService()
const uuid = (ctx: HttpContext, name: string) => {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

export default class MembersController {
  async index(ctx: HttpContext) {
    const filter = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await members.list(ctx.tenantContext!, filter)
    return ok(ctx, page.items, { total: page.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await members.get(ctx.tenantContext!, uuid(ctx, 'id')))
  }

  async invite(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(inviteValidator)
    const result = await members.invite(ctx.tenantContext!, body)
    return created(ctx, result, `/api/v1/members/${result.member.id}`)
  }

  async suspend(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(versionValidator)
    return ok(
      ctx,
      await members.setStatus(ctx.tenantContext!, uuid(ctx, 'id'), expectedVersion, 'SUSPENDED')
    )
  }

  async reactivate(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(versionValidator)
    return ok(
      ctx,
      await members.setStatus(ctx.tenantContext!, uuid(ctx, 'id'), expectedVersion, 'ACTIVE')
    )
  }

  async assignRole(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(assignValidator)
    return ok(ctx, await members.assignRole(ctx.tenantContext!, uuid(ctx, 'id'), body))
  }

  async unassignRole(ctx: HttpContext) {
    return ok(
      ctx,
      await members.unassignRole(ctx.tenantContext!, uuid(ctx, 'id'), uuid(ctx, 'assignmentId'))
    )
  }
}
