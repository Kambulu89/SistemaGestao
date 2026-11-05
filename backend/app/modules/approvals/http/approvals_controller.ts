import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  ApprovalRequestService,
  DelegationService,
  WorkflowService,
} from '#modules/approvals/application/approval_service'

const workflows = new WorkflowService()
const requests = new ApprovalRequestService()
const delegations = new DelegationService()

const idOf = (ctx: HttpContext) => {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const page = {
  limit: vine.number().withoutDecimals().min(1).max(100).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}
const workflowListValidator = vine.create(
  vine.object({ status: vine.enum(['DRAFT', 'ACTIVE', 'RETIRED'] as const).optional() })
)
/** A estrutura é validada pelo domínio (campos e etapas declarados); aqui só a forma geral. */
const workflowBodyValidator = vine.create(vine.object({}).allowUnknownProperties())
const versionValidator = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const requestListValidator = vine.create(
  vine.object({
    status: vine.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const).optional(),
    ...page,
  })
)
const decisionValidator = vine.create(
  vine.object({
    decision: vine.enum(['APPROVE', 'REJECT'] as const),
    comment: vine.string().trim().maxLength(2000).nullable().optional(),
    onBehalfOf: vine.string().uuid().nullable().optional(),
  })
)
const cancelValidator = vine.create(
  vine.object({ reason: vine.string().trim().maxLength(500).nullable().optional() })
)
const delegationValidator = vine.create(
  vine.object({
    delegateMembershipId: vine.string().uuid(),
    workflowId: vine.string().uuid().nullable().optional(),
    startsAt: vine.date({ formats: ['iso8601'] }).optional(),
    endsAt: vine.date({ formats: ['iso8601'] }),
    reason: vine.string().trim().minLength(3).maxLength(300),
  })
)
const delegationListValidator = vine.create(vine.object({ all: vine.boolean().optional() }))

export default class ApprovalsController {
  // ---------- workflows (approvals.manage) ----------
  async workflows(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(workflowListValidator, { data: ctx.request.qs() })
    return ok(ctx, await workflows.list(ctx.tenantContext!, q.status))
  }

  async workflow(ctx: HttpContext) {
    return ok(ctx, await workflows.get(ctx.tenantContext!, idOf(ctx)))
  }

  async createWorkflow(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(workflowBodyValidator)) as Record<string, unknown>
    const wf = await workflows.create(ctx.tenantContext!, body)
    return created(ctx, wf, `/api/v1/approvals/workflows/${wf.id}`)
  }

  async updateWorkflow(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await workflows.update(ctx.tenantContext!, idOf(ctx), body))
  }

  async publishWorkflow(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(versionValidator)
    return ok(
      ctx,
      await workflows.setStatus(ctx.tenantContext!, idOf(ctx), expectedVersion, 'ACTIVE')
    )
  }

  async retireWorkflow(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(versionValidator)
    return ok(
      ctx,
      await workflows.setStatus(ctx.tenantContext!, idOf(ctx), expectedVersion, 'RETIRED')
    )
  }

  async deleteWorkflow(ctx: HttpContext) {
    await workflows.remove(ctx.tenantContext!, idOf(ctx))
    return ctx.response.noContent()
  }

  /** Workflows publicados (para quem submete pedidos). */
  async activeWorkflows(ctx: HttpContext) {
    const list = await workflows.list(ctx.tenantContext!, 'ACTIVE')
    return ok(
      ctx,
      list
        .filter((w) => w.subjectType === 'manual')
        .map(({ id, code, name, description, subjectType, steps }) => ({
          id,
          code,
          name,
          description,
          subjectType,
          steps: steps.map(({ sequence, name: stepName }) => ({ sequence, name: stepName })),
        }))
    )
  }

  // ---------- pedidos ----------
  async requests(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(requestListValidator, { data: ctx.request.qs() })
    const result = await requests.list(ctx.tenantContext!, {
      status: q.status,
      limit: q.limit ?? 30,
      offset: q.offset ?? 0,
    })
    return ok(ctx, result.items, { total: result.total })
  }

  async request(ctx: HttpContext) {
    return ok(ctx, await requests.get(ctx.tenantContext!, idOf(ctx)))
  }

  async submit(ctx: HttpContext) {
    const body = ctx.request.only(['workflowId', 'title', 'description'])
    const request = await requests.submit(ctx.tenantContext!, body)
    return created(ctx, request, `/api/v1/approvals/requests/${request.id}`)
  }

  async decide(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(decisionValidator)
    return ok(ctx, await requests.decide(ctx.tenantContext!, idOf(ctx), body))
  }

  async cancel(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(cancelValidator)
    return ok(ctx, await requests.cancel(ctx.tenantContext!, idOf(ctx), body.reason ?? null))
  }

  // ---------- delegações ----------
  async delegations(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(delegationListValidator, { data: ctx.request.qs() })
    return ok(ctx, await delegations.list(ctx.tenantContext!, q.all ?? false))
  }

  async createDelegation(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(delegationValidator)
    const delegation = await delegations.create(ctx.tenantContext!, {
      ...body,
      startsAt: body.startsAt?.toJSDate(),
      endsAt: body.endsAt.toJSDate(),
    })
    return created(ctx, delegation)
  }

  async revokeDelegation(ctx: HttpContext) {
    return ok(ctx, await delegations.revoke(ctx.tenantContext!, idOf(ctx)))
  }
}
