import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  EmployeeTrainingService,
  TrainingCatalogService,
  TrainingSessionService,
} from '#modules/hr/application/training_service'
import { DisciplineService } from '#modules/hr/application/discipline_service'

/**
 * Formação e processos disciplinares (7.10). Catálogo: `hr.training.settings` (rota). Sessões e fichas: âmbito
 * `hr.training.*` no serviço. Processos disciplinares: âmbito `hr.discipline.*` no serviço (acesso restrito). Só o
 * corpo JSON é validado.
 */
const catalog = new TrainingCatalogService()
const sessions = new TrainingSessionService()
const employees = new EmployeeTrainingService()
const discipline = new DisciplineService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const enrollBody = vine.create(
  vine.object({
    employeeIds: vine.array(vine.string().uuid()).minLength(1).maxLength(500),
    ...version,
  })
)
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}
const sessionsQuery = vine.create(
  vine.object({
    status: vine.enum(['PLANNED', 'COMPLETED', 'CANCELLED'] as const).optional(),
    ...page,
  })
)
const casesQuery = vine.create(
  vine.object({
    status: vine.enum(['OPEN', 'UNDER_REVIEW', 'CLOSED'] as const).optional(),
    employeeId: vine.string().uuid().optional(),
    ...page,
  })
)
const costsQuery = vine.create(
  vine.object({ year: vine.number().withoutDecimals().min(2000).max(2100) })
)

const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class TrainingController {
  async competencies(ctx: HttpContext) {
    return ok(ctx, await catalog.competencies(ctx.tenantContext!))
  }

  async createCompetency(ctx: HttpContext) {
    return created(
      ctx,
      await catalog.saveCompetency(ctx.tenantContext!, null, await body(ctx, anyBody))
    )
  }

  async updateCompetency(ctx: HttpContext) {
    return ok(
      ctx,
      await catalog.saveCompetency(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async courses(ctx: HttpContext) {
    return ok(ctx, await catalog.courses(ctx.tenantContext!))
  }

  async createCourse(ctx: HttpContext) {
    return created(
      ctx,
      await catalog.saveCourse(ctx.tenantContext!, null, await body(ctx, anyBody))
    )
  }

  async updateCourse(ctx: HttpContext) {
    return ok(
      ctx,
      await catalog.saveCourse(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async sessions(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(sessionsQuery, { data: ctx.request.qs() })
    const p = await sessions.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async session(ctx: HttpContext) {
    return ok(ctx, await sessions.get(ctx.tenantContext!, param(ctx)))
  }

  async createSession(ctx: HttpContext) {
    return created(ctx, await sessions.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async enroll(ctx: HttpContext) {
    const b = await body(ctx, enrollBody)
    return ok(
      ctx,
      await sessions.enroll(ctx.tenantContext!, param(ctx), b.employeeIds, b.expectedVersion)
    )
  }

  async result(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await sessions.setResult(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async complete(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await sessions.complete(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async cancelSession(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await sessions.cancel(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async costs(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(costsQuery, { data: ctx.request.qs() })
    return ok(ctx, await sessions.costs(ctx.tenantContext!, q.year))
  }

  async employeeTraining(ctx: HttpContext) {
    return ok(ctx, await employees.summary(ctx.tenantContext!, param(ctx)))
  }

  async assess(ctx: HttpContext) {
    return created(
      ctx,
      await employees.assess(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async addCertificate(ctx: HttpContext) {
    return created(
      ctx,
      await employees.addCertificate(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async cases(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(casesQuery, { data: ctx.request.qs() })
    const p = await discipline.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async case(ctx: HttpContext) {
    return ok(ctx, await discipline.get(ctx.tenantContext!, param(ctx)))
  }

  async openCase(ctx: HttpContext) {
    return created(
      ctx,
      await discipline.create(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async caseEvent(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await discipline.addEvent(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async reviewCase(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await discipline.review(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async closeCase(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await discipline.close(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }
}
