import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  APPLICATION_SORT_FIELDS,
  ApplicationService,
  CandidateService,
  HrSettingsService,
  OfferService,
  REQUISITION_SORT_FIELDS,
  RequisitionService,
} from '#modules/hr/application/recruitment_service'
import { OnboardingService } from '#modules/hr/application/onboarding_service'
import { APPLICATION_STAGES, REQUISITION_STATUSES } from '#modules/hr/domain/recruitment'

/**
 * Recrutamento e onboarding (7.2). O âmbito de cada pedido (pela colocação da vaga, ou do colaborador no onboarding)
 * é verificado no serviço com `hr.recruitment.read|manage|approve` e `hr.read|manage`.
 */
const settings = new HrSettingsService()
const requisitions = new RequisitionService()
const candidates = new CandidateService()
const applications = new ApplicationService()
const offers = new OfferService()
const onboarding = new OnboardingService()

const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}
const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const reason = vine.string().trim().maxLength(1000).optional()

const requisitionList = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(REQUISITION_STATUSES).optional(),
    legalEntityId: vine.string().uuid().optional(),
    departmentId: vine.string().uuid().optional(),
    sort: vine.enum(REQUISITION_SORT_FIELDS).optional(),
    direction: vine.enum(['asc', 'desc'] as const).optional(),
    ...page,
  })
)
const candidateList = vine.create(
  vine.object({ q: vine.string().trim().maxLength(100).optional(), ...page })
)
const applicationList = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    requisitionId: vine.string().uuid().optional(),
    candidateId: vine.string().uuid().optional(),
    stage: vine.enum(APPLICATION_STAGES).optional(),
    sort: vine.enum(APPLICATION_SORT_FIELDS).optional(),
    direction: vine.enum(['asc', 'desc'] as const).optional(),
    ...page,
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const decision = vine.create(
  vine.object({ decision: vine.enum(['APPROVE', 'REJECT'] as const), reason, ...version })
)
const withReason = vine.create(vine.object({ reason, ...version }))
const settingsBody = vine.create(
  vine.object({
    requisitionWorkflowId: vine.string().uuid().nullable().optional(),
    offerWorkflowId: vine.string().uuid().nullable().optional(),
    compensationWorkflowId: vine.string().uuid().nullable().optional(),
    ...version,
  })
)
const newApplication = vine.create(
  vine.object({ requisitionId: vine.string().uuid(), candidateId: vine.string().uuid() })
)
const stageBody = vine.create(
  vine.object({ stage: vine.enum(APPLICATION_STAGES), reason, ...version })
)
const respondBody = vine.create(vine.object({ accepted: vine.boolean(), ...version }))

const id = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const sortOf = <F extends string>(q: { sort?: F; direction?: 'asc' | 'desc' }) =>
  q.sort ? { field: q.sort, direction: q.direction ?? 'asc' } : undefined

export default class RecruitmentController {
  // Configuração ------------------------------------------------------------------------------------------------
  async settings(ctx: HttpContext) {
    return ok(ctx, await settings.get(ctx.tenantContext!))
  }

  async updateSettings(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(settingsBody, {
      data: ctx.request.body(),
    })
    return ok(ctx, await settings.update(ctx.tenantContext!, body, expectedVersion))
  }

  // Vagas -------------------------------------------------------------------------------------------------------
  async requisitions(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(requisitionList, { data: ctx.request.qs() })
    const result = await requisitions.list(ctx.tenantContext!, {
      ...q,
      sort: sortOf(q),
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, result.items, { total: result.total })
  }

  async requisition(ctx: HttpContext) {
    return ok(ctx, await requisitions.get(ctx.tenantContext!, id(ctx)))
  }

  async createRequisition(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })) as Record<
      string,
      unknown
    >
    return created(ctx, await requisitions.create(ctx.tenantContext!, body))
  }

  async updateRequisition(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(versioned, {
      data: ctx.request.body(),
    })
    return ok(ctx, await requisitions.update(ctx.tenantContext!, id(ctx), body, expectedVersion))
  }

  async submitRequisition(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(onlyVersion, {
      data: ctx.request.body(),
    })
    return ok(ctx, await requisitions.submit(ctx.tenantContext!, id(ctx), expectedVersion))
  }

  async decideRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(decision, { data: ctx.request.body() })
    return ok(
      ctx,
      await requisitions.decide(
        ctx.tenantContext!,
        id(ctx),
        b.decision,
        b.reason ?? null,
        b.expectedVersion
      )
    )
  }

  async closeRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(withReason, { data: ctx.request.body() })
    return ok(
      ctx,
      await requisitions.finish(
        ctx.tenantContext!,
        id(ctx),
        'CLOSED',
        b.reason ?? null,
        b.expectedVersion
      )
    )
  }

  async cancelRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(withReason, { data: ctx.request.body() })
    return ok(
      ctx,
      await requisitions.finish(
        ctx.tenantContext!,
        id(ctx),
        'CANCELLED',
        b.reason ?? null,
        b.expectedVersion
      )
    )
  }

  // Candidatos --------------------------------------------------------------------------------------------------
  async candidates(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(candidateList, { data: ctx.request.qs() })
    const result = await candidates.list(ctx.tenantContext!, {
      q: q.q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, result.items, { total: result.total })
  }

  async candidate(ctx: HttpContext) {
    return ok(ctx, await candidates.get(ctx.tenantContext!, id(ctx)))
  }

  async createCandidate(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })) as Record<
      string,
      unknown
    >
    return created(ctx, await candidates.create(ctx.tenantContext!, body))
  }

  async updateCandidate(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(versioned, {
      data: ctx.request.body(),
    })
    return ok(ctx, await candidates.update(ctx.tenantContext!, id(ctx), body, expectedVersion))
  }

  // Candidaturas, entrevistas e avaliações ----------------------------------------------------------------------
  async applications(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(applicationList, { data: ctx.request.qs() })
    const result = await applications.list(ctx.tenantContext!, {
      ...q,
      sort: sortOf(q),
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, result.items, { total: result.total })
  }

  async application(ctx: HttpContext) {
    return ok(ctx, await applications.get(ctx.tenantContext!, id(ctx)))
  }

  async createApplication(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(newApplication, { data: ctx.request.body() })
    return created(ctx, await applications.create(ctx.tenantContext!, body))
  }

  async changeStage(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(stageBody, { data: ctx.request.body() })
    return ok(
      ctx,
      await applications.changeStage(
        ctx.tenantContext!,
        id(ctx),
        b.stage,
        b.reason ?? null,
        b.expectedVersion
      )
    )
  }

  async scheduleInterview(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })) as Record<
      string,
      unknown
    >
    return created(ctx, await applications.scheduleInterview(ctx.tenantContext!, id(ctx), body))
  }

  async updateInterview(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(versioned, {
      data: ctx.request.body(),
    })
    return ok(
      ctx,
      await applications.updateInterview(ctx.tenantContext!, id(ctx), body, expectedVersion)
    )
  }

  async myInterviews(ctx: HttpContext) {
    return ok(ctx, await applications.myInterviews(ctx.tenantContext!))
  }

  async evaluate(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })) as Record<
      string,
      unknown
    >
    return created(ctx, await applications.evaluate(ctx.tenantContext!, id(ctx), body))
  }

  // Propostas ---------------------------------------------------------------------------------------------------
  async createOffer(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })) as Record<
      string,
      unknown
    >
    return created(ctx, await offers.create(ctx.tenantContext!, id(ctx), body))
  }

  async updateOffer(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(versioned, {
      data: ctx.request.body(),
    })
    return ok(ctx, await offers.update(ctx.tenantContext!, id(ctx), body, expectedVersion))
  }

  async submitOffer(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(onlyVersion, {
      data: ctx.request.body(),
    })
    return ok(ctx, await offers.submit(ctx.tenantContext!, id(ctx), expectedVersion))
  }

  async decideOffer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(decision, { data: ctx.request.body() })
    return ok(
      ctx,
      await offers.decide(
        ctx.tenantContext!,
        id(ctx),
        b.decision,
        b.reason ?? null,
        b.expectedVersion
      )
    )
  }

  async respondOffer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(respondBody, { data: ctx.request.body() })
    return ok(ctx, await offers.respond(ctx.tenantContext!, id(ctx), b.accepted, b.expectedVersion))
  }

  async cancelOffer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(withReason, { data: ctx.request.body() })
    return ok(
      ctx,
      await offers.cancel(ctx.tenantContext!, id(ctx), b.reason ?? null, b.expectedVersion)
    )
  }

  async hire(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(versioned, {
      data: ctx.request.body(),
    })
    return created(ctx, await offers.hire(ctx.tenantContext!, id(ctx), body, expectedVersion))
  }

  // Onboarding --------------------------------------------------------------------------------------------------
  async onboarding(ctx: HttpContext) {
    return ok(ctx, await onboarding.list(ctx.tenantContext!, id(ctx)))
  }

  async createOnboardingTask(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })) as Record<
      string,
      unknown
    >
    return created(ctx, await onboarding.create(ctx.tenantContext!, id(ctx), body))
  }

  async updateOnboardingTask(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(versioned, {
      data: ctx.request.body(),
    })
    return ok(ctx, await onboarding.update(ctx.tenantContext!, id(ctx), body, expectedVersion))
  }
}
