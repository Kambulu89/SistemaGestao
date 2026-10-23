import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { workflowServices } from '#dynamic/workflows/presentation/composition'
import {
  createDelegationValidator,
  createWorkflowValidator,
  decisionValidator,
  inboxValidator,
  listInstancesValidator,
  listWorkflowsValidator,
  submitValidator,
  updateWorkflowValidator,
  versionOnlyValidator,
} from '#dynamic/workflows/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class WorkflowsController {
  // --- definições ---------------------------------------------------------------------------

  async list(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listWorkflowsValidator, { data: ctx.request.qs() })
    return envelope(ctx, await workflowServices().definitions.list(ctx.tenantContext, q))
  }

  async show(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().definitions.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async create(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createWorkflowValidator)
    const workflow = await workflowServices().definitions.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/workflows/${workflow.id}`)
    return envelope(ctx, workflow)
  }

  async update(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateWorkflowValidator)
    return envelope(
      ctx,
      await workflowServices().definitions.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async createRevision(ctx: HttpContext) {
    const workflow = await workflowServices().definitions.createRevision(
      ctx.tenantContext,
      uuidParam(ctx, 'id')
    )
    ctx.response.status(201).header('location', `/api/v1/workflows/${workflow.id}`)
    return envelope(ctx, workflow)
  }

  async preview(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().definitions.preview(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async publish(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await workflowServices().definitions.publish(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }

  async retire(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await workflowServices().definitions.retire(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }

  // --- processos ----------------------------------------------------------------------------

  async submit(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(submitValidator)
    const detail = await workflowServices().instances.submit(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/workflow-instances/${detail.instance.id}`)
    return envelope(ctx, detail)
  }

  async submittable(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().instances.submittable(
        ctx.tenantContext,
        ctx.params.entityCode as string
      )
    )
  }

  async listInstances(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listInstancesValidator, { data: ctx.request.qs() })
    return envelope(ctx, await workflowServices().instances.list(ctx.tenantContext, q))
  }

  async showInstance(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().instances.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async cancelInstance(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().instances.cancel(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async recordInstances(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().instances.forRecord(
        ctx.tenantContext,
        ctx.params.entityCode as string,
        uuidParam(ctx, 'id')
      )
    )
  }

  // --- tarefas ------------------------------------------------------------------------------

  async inbox(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(inboxValidator, { data: ctx.request.qs() })
    return envelope(
      ctx,
      await workflowServices().tasks.inbox(ctx.tenantContext, q.view ?? 'pending')
    )
  }

  async showTask(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().tasks.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async claim(ctx: HttpContext) {
    return envelope(
      ctx,
      await workflowServices().tasks.claim(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async approve(ctx: HttpContext) {
    return this.decide(ctx, 'approve')
  }

  async reject(ctx: HttpContext) {
    return this.decide(ctx, 'reject')
  }

  async return(ctx: HttpContext) {
    return this.decide(ctx, 'return')
  }

  private async decide(ctx: HttpContext, action: 'approve' | 'reject' | 'return') {
    const b = await ctx.request.validateUsing(decisionValidator)
    return envelope(
      ctx,
      await workflowServices().tasks.decide(ctx.tenantContext, uuidParam(ctx, 'id'), action, b)
    )
  }

  // --- delegações ---------------------------------------------------------------------------

  async listDelegations(ctx: HttpContext) {
    return envelope(ctx, await workflowServices().delegations.list(ctx.tenantContext))
  }

  async createDelegation(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createDelegationValidator)
    const delegation = await workflowServices().delegations.create(ctx.tenantContext, {
      ...b,
      validFrom: b.validFrom ?? null,
    })
    ctx.response.status(201).header('location', `/api/v1/approval-delegations/${delegation.id}`)
    return envelope(ctx, delegation)
  }

  async revokeDelegation(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await workflowServices().delegations.revoke(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }
}
