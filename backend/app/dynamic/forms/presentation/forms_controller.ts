import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { formServices } from '#dynamic/forms/presentation/composition'
import {
  createFormValidator,
  listFormsValidator,
  updateFormValidator,
  versionOnlyValidator,
} from '#dynamic/forms/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class FormsController {
  async list(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listFormsValidator, { data: ctx.request.qs() })
    return envelope(ctx, await formServices().forms.list(ctx.tenantContext, q))
  }

  /** Os formulários em vigor de uma entidade, para quem a lê (não exige poder desenhá-los). */
  async published(ctx: HttpContext) {
    const forms = await formServices().forms.list(ctx.tenantContext, {
      entityCode: ctx.params.entityCode as string,
      status: 'PUBLISHED',
    })
    return envelope(ctx, forms)
  }

  async show(ctx: HttpContext) {
    return envelope(ctx, await formServices().forms.get(ctx.tenantContext, idParam(ctx)))
  }

  async create(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createFormValidator)
    const form = await formServices().forms.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/forms/${form.id}`)
    return envelope(ctx, form)
  }

  async update(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateFormValidator)
    return envelope(ctx, await formServices().forms.update(ctx.tenantContext, idParam(ctx), b))
  }

  async createRevision(ctx: HttpContext) {
    const form = await formServices().forms.createRevision(ctx.tenantContext, idParam(ctx))
    ctx.response.status(201).header('location', `/api/v1/forms/${form.id}`)
    return envelope(ctx, form)
  }

  async preview(ctx: HttpContext) {
    return envelope(ctx, await formServices().forms.preview(ctx.tenantContext, idParam(ctx)))
  }

  async publish(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await formServices().forms.publish(ctx.tenantContext, idParam(ctx), b.expectedVersion)
    )
  }

  async retire(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await formServices().forms.retire(ctx.tenantContext, idParam(ctx), b.expectedVersion)
    )
  }
}
