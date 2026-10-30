import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { calendarServices } from '#modules/calendar/presentation/composition'
import {
  looseObjectValidator,
  rangeValidator,
  versionValidator,
} from '#modules/calendar/presentation/validators'

function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const bodyOf = async (ctx: HttpContext) =>
  (await ctx.request.validateUsing(looseObjectValidator)) as Record<string, unknown>

const created = <T>(ctx: HttpContext, data: T) => {
  ctx.response.status(201)
  return envelope(ctx, data)
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class CalendarController {
  // --- calendários ---------------------------------------------------------------------------------

  async listCalendars(ctx: HttpContext) {
    return envelope(ctx, await calendarServices().calendars.list(ctx.tenantContext))
  }

  async createCalendar(ctx: HttpContext) {
    return created(
      ctx,
      await calendarServices().calendars.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async showCalendar(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().calendars.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async updateCalendar(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await calendarServices().calendars.update(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        version,
        body
      )
    )
  }

  async removeCalendar(ctx: HttpContext) {
    await calendarServices().calendars.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  // --- recursos ------------------------------------------------------------------------------------

  async listResources(ctx: HttpContext) {
    return envelope(ctx, await calendarServices().resources.list(ctx.tenantContext))
  }

  async createResource(ctx: HttpContext) {
    return created(
      ctx,
      await calendarServices().resources.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async showResource(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().resources.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async updateResource(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await calendarServices().resources.update(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        version,
        body
      )
    )
  }

  async removeResource(ctx: HttpContext) {
    await calendarServices().resources.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  async availability(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(rangeValidator)
    return envelope(
      ctx,
      await calendarServices().bookings.availability(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        query.from,
        query.to
      )
    )
  }

  // --- eventos -------------------------------------------------------------------------------------

  async listEvents(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(rangeValidator)
    return envelope(
      ctx,
      await calendarServices().events.list(ctx.tenantContext, {
        from: query.from,
        to: query.to,
        calendarId: query.calendarId ?? null,
      })
    )
  }

  async createEvent(ctx: HttpContext) {
    return created(
      ctx,
      await calendarServices().events.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async showEvent(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().events.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async updateEvent(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().events.update(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        await bodyOf(ctx)
      )
    )
  }

  async cancelEvent(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().events.cancel(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        await bodyOf(ctx)
      )
    )
  }

  async addParticipant(ctx: HttpContext) {
    return created(
      ctx,
      await calendarServices().events.addParticipant(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        await bodyOf(ctx)
      )
    )
  }

  async removeParticipant(ctx: HttpContext) {
    await calendarServices().events.removeParticipant(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      uuidParam(ctx, 'participantId')
    )
    ctx.response.status(204)
  }

  async respond(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().events.respond(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        await bodyOf(ctx)
      )
    )
  }

  // --- reservas ------------------------------------------------------------------------------------

  async listBookings(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(rangeValidator)
    return envelope(
      ctx,
      await calendarServices().bookings.list(ctx.tenantContext, {
        from: query.from,
        to: query.to,
        resourceId: query.resourceId ?? null,
        eventId: query.eventId ?? null,
      })
    )
  }

  async createBooking(ctx: HttpContext) {
    return created(
      ctx,
      await calendarServices().bookings.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async confirmBooking(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().bookings.confirm(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async cancelBooking(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().bookings.cancel(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  // --- horário útil --------------------------------------------------------------------------------

  async listBusiness(ctx: HttpContext) {
    return envelope(ctx, await calendarServices().business.list(ctx.tenantContext))
  }

  async createBusiness(ctx: HttpContext) {
    return created(
      ctx,
      await calendarServices().business.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async showBusiness(ctx: HttpContext) {
    return envelope(
      ctx,
      await calendarServices().business.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async updateBusiness(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await calendarServices().business.update(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        version,
        body
      )
    )
  }

  async removeBusiness(ctx: HttpContext) {
    await calendarServices().business.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  async workingTime(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(rangeValidator)
    return envelope(
      ctx,
      await calendarServices().business.workingTime(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        query.from,
        query.to
      )
    )
  }
}
