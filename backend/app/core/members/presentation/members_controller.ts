import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { memberServices } from '#core/members/presentation/composition'
import {
  changeMemberStatusValidator,
  createInvitationValidator,
  defaultOrganizationValidator,
  preferenceValueValidator,
} from '#core/members/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida o pedido, chama o caso de uso e formata a resposta. */
export default class MembersController {
  async listMembers(ctx: HttpContext) {
    return envelope(ctx, await memberServices().members.list(ctx.tenantContext))
  }

  async showMember(ctx: HttpContext) {
    return envelope(ctx, await memberServices().members.get(ctx.tenantContext, idParam(ctx)))
  }

  async changeMemberStatus(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(changeMemberStatusValidator)
    return envelope(
      ctx,
      await memberServices().members.changeStatus(ctx.tenantContext, idParam(ctx), input)
    )
  }

  async listInvitations(ctx: HttpContext) {
    return envelope(ctx, await memberServices().invitations.list(ctx.tenantContext))
  }

  async createInvitation(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createInvitationValidator)
    const invitation = await memberServices().invitations.create(ctx.tenantContext, {
      email: input.email,
      roleIds: input.roleIds ?? [],
      unitIds: input.unitIds ?? [],
      expiresInDays: input.expiresInDays,
    })
    ctx.response.status(201).header('location', `/api/v1/invitations/${invitation.id}`)
    return envelope(ctx, invitation)
  }

  async revokeInvitation(ctx: HttpContext) {
    await memberServices().invitations.revoke(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }

  async preferences(ctx: HttpContext) {
    return envelope(ctx, await memberServices().preferences.list(ctx.tenantContext))
  }

  async setPreference(ctx: HttpContext) {
    const { value } = await ctx.request.validateUsing(preferenceValueValidator)
    const key = ctx.params.key as string
    await memberServices().preferences.set(ctx.tenantContext, key, value)
    return envelope(ctx, await memberServices().preferences.list(ctx.tenantContext))
  }

  async removePreference(ctx: HttpContext) {
    await memberServices().preferences.remove(ctx.tenantContext, ctx.params.key as string)
    return ctx.response.noContent()
  }

  async setDefaultOrganization(ctx: HttpContext) {
    const { organizationId } = await ctx.request.validateUsing(defaultOrganizationValidator)
    return envelope(
      ctx,
      await memberServices().members.setOwnDefaultOrganization(ctx.tenantContext, organizationId)
    )
  }
}
