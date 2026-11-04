import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ok } from '#shared/http/respond'
import { MemberService } from '#modules/members/application/member_service'

const acceptValidator = vine.create({
  token: vine.string().trim().maxLength(200),
  password: vine.string().maxLength(200).optional(),
  fullName: vine.string().trim().maxLength(160).optional(),
})
const members = new MemberService()

/** Público: aceitar um convite (o token prova a identidade; depois a pessoa entra com a palavra-passe). */
export default class InvitationController {
  async accept(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(acceptValidator)
    const accepted = await members.acceptInvitation(body)
    return ok(ctx, { accepted: true, tenantId: accepted.tenantId })
  }
}
