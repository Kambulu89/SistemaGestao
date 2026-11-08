import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { ok } from '#shared/http/respond'
import {
  PREFERENCE_KEYS,
  PreferencesService,
  type PreferenceKey,
} from '#modules/preferences/application/preferences_service'

const preferences = new PreferencesService()
const bodyValidator = vine.create(vine.object({ value: vine.any() }))

const keyOf = (ctx: HttpContext) => {
  const key = ctx.params.key as PreferenceKey
  if (!PREFERENCE_KEYS.includes(key)) throw ApiError.notFound()
  return key
}

/** Preferências de interface do próprio membro (favoritos, painel). */
export default class PreferencesController {
  async show(ctx: HttpContext) {
    return ok(ctx, await preferences.get(ctx.tenantContext!, keyOf(ctx)))
  }

  async update(ctx: HttpContext) {
    const key = keyOf(ctx)
    const body = await ctx.request.validateUsing(bodyValidator)
    return ok(ctx, await preferences.set(ctx.tenantContext!, key, body.value))
  }
}
