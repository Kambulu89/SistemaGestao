import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { iamServices } from '#core/permissions/index'
import { isUuid } from '#core/tenancy/index'
import { prospectingServices } from '#modules/prospecting/presentation/composition'
import {
  activityValidator,
  addExclusionValidator,
  addMembersValidator,
  campaignStatusValidator,
  convertLeadValidator,
  createCampaignValidator,
  createLeadValidator,
  createOpportunityValidator,
  createStageValidator,
  listCampaignsValidator,
  listLeadsValidator,
  listMembersValidator,
  listOpportunitiesValidator,
  listStagesValidator,
  metricsValidator,
  moveOpportunityValidator,
  pageValidator,
  reasonValidator,
  updateCampaignValidator,
  updateLeadValidator,
  updateOpportunityValidator,
  updateStageValidator,
} from '#modules/prospecting/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Converter uma lead cria Party e cliente: quem converte tem de poder criar ambos. */
async function requireAll(ctx: HttpContext, permissions: readonly string[]): Promise<void> {
  for (const permission of permissions) {
    const decision = await iamServices().authorize.decision(ctx.tenantContext, permission)
    if (!decision.allowed) {
      throw new ApiError(403, 'FORBIDDEN', 'Sem permissão para esta operação.', [
        { path: 'permission', code: 'MISSING_PERMISSION', message: permission },
      ])
    }
  }
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class ProspectingController {
  // --- etapas ----------------------------------------------------------------------------------

  async listStages(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listStagesValidator, { data: ctx.request.qs() })
    return envelope(ctx, await prospectingServices().stages.list(ctx.tenantContext, q))
  }

  async createStage(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createStageValidator)
    const created = await prospectingServices().stages.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/pipeline-stages/${created.id}`)
    return envelope(ctx, created)
  }

  async updateStage(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateStageValidator)
    return envelope(
      ctx,
      await prospectingServices().stages.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  // --- leads -----------------------------------------------------------------------------------

  async listLeads(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listLeadsValidator, { data: ctx.request.qs() })
    const { items, total } = await prospectingServices().leads.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showLead(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().leads.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createLead(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createLeadValidator)
    const created = await prospectingServices().leads.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/leads/${created.id}`)
    return envelope(ctx, created)
  }

  async updateLead(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateLeadValidator)
    return envelope(
      ctx,
      await prospectingServices().leads.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async qualifyLead(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().leads.qualify(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async disqualifyLead(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await prospectingServices().leads.disqualify(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.reason
      )
    )
  }

  async convertLead(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(convertLeadValidator)
    await requireAll(ctx, ['customer.create', 'party.create'])
    const result = await prospectingServices().leads.convert(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    // Repetir uma conversão devolve os mesmos identificadores (200); a primeira cria (201).
    ctx.response.status(result.alreadyConverted ? 200 : 201)
    return envelope(ctx, result)
  }

  // --- oportunidades ---------------------------------------------------------------------------

  async listOpportunities(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listOpportunitiesValidator, {
      data: ctx.request.qs(),
    })
    const { items, total } = await prospectingServices().opportunities.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async opportunityMetrics(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(metricsValidator, { data: ctx.request.qs() })
    return envelope(ctx, await prospectingServices().opportunities.metrics(ctx.tenantContext, q))
  }

  async showOpportunity(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().opportunities.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async opportunityHistory(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().opportunities.history(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createOpportunity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createOpportunityValidator)
    const created = await prospectingServices().opportunities.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/opportunities/${created.id}`)
    return envelope(ctx, created)
  }

  async updateOpportunity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateOpportunityValidator)
    return envelope(
      ctx,
      await prospectingServices().opportunities.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async moveOpportunity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(moveOpportunityValidator)
    return envelope(
      ctx,
      await prospectingServices().opportunities.move(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async listActivities(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().opportunities.listActivities(
        ctx.tenantContext,
        uuidParam(ctx, 'id')
      )
    )
  }

  async addActivity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(activityValidator)
    const created = await prospectingServices().opportunities.addActivity(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async completeActivity(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().opportunities.completeActivity(
        ctx.tenantContext,
        uuidParam(ctx, 'id')
      )
    )
  }

  // --- campanhas -------------------------------------------------------------------------------

  async listCampaigns(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listCampaignsValidator, { data: ctx.request.qs() })
    const { items, total } = await prospectingServices().campaigns.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showCampaign(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().campaigns.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createCampaign(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createCampaignValidator)
    const created = await prospectingServices().campaigns.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/campaigns/${created.id}`)
    return envelope(ctx, created)
  }

  async updateCampaign(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateCampaignValidator)
    return envelope(
      ctx,
      await prospectingServices().campaigns.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async setCampaignStatus(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(campaignStatusValidator)
    return envelope(
      ctx,
      await prospectingServices().campaigns.setStatus(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.status
      )
    )
  }

  async listMembers(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listMembersValidator, { data: ctx.request.qs() })
    const { items, total } = await prospectingServices().campaigns.members(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      q
    )
    return envelope(ctx, items, { total })
  }

  async addMembers(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(addMembersValidator)
    const result = await prospectingServices().campaigns.addMembers(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, result)
  }

  async removeMember(ctx: HttpContext) {
    await prospectingServices().campaigns.removeMember(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      uuidParam(ctx, 'memberId')
    )
    return ctx.response.noContent()
  }

  async respondMember(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().campaigns.respond(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'memberId')
      )
    )
  }

  async optOutMember(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().campaigns.optOut(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'memberId')
      )
    )
  }

  async sendCampaign(ctx: HttpContext) {
    return envelope(
      ctx,
      await prospectingServices().campaigns.send(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  // --- lista de exclusão -----------------------------------------------------------------------

  async listExclusions(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(pageValidator, { data: ctx.request.qs() })
    const { items, total } = await prospectingServices().exclusions.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async addExclusion(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(addExclusionValidator)
    const created = await prospectingServices().exclusions.add(ctx.tenantContext, b)
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async removeExclusion(ctx: HttpContext) {
    await prospectingServices().exclusions.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }
}
