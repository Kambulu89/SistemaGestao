import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { organizationServices } from '#core/organization/presentation/composition'
import {
  addScopeValidator,
  addTeamMemberValidator,
  createCostCenterValidator,
  createOrganizationValidator,
  createUnitValidator,
  listFilterValidator,
  updateCostCenterValidator,
  updateOrganizationValidator,
  updateUnitValidator,
} from '#core/organization/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const filters = (ctx: HttpContext) =>
  ctx.request.validateUsing(listFilterValidator, { data: ctx.request.qs() })

function created<T extends { id: string }>(ctx: HttpContext, path: string, body: T) {
  ctx.response.status(201).header('location', `/api/v1/${path}/${body.id}`)
  return envelope(ctx, body)
}

/** Transporte apenas: valida o pedido, chama o caso de uso e formata a resposta. */
export default class OrganizationController {
  async listOrganizations(ctx: HttpContext) {
    return envelope(ctx, await organizationServices().organizations.list(ctx.tenantContext))
  }

  async showOrganization(ctx: HttpContext) {
    return envelope(
      ctx,
      await organizationServices().organizations.get(ctx.tenantContext, idParam(ctx))
    )
  }

  async createOrganization(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createOrganizationValidator)
    const organization = await organizationServices().organizations.create(ctx.tenantContext, {
      code: input.code,
      legalName: input.legalName,
      tradeName: input.tradeName ?? null,
      countryCode: input.countryCode,
      taxId: input.taxId ?? null,
      baseCurrency: input.baseCurrency,
      fiscalYearStartMonth: input.fiscalYearStartMonth ?? 1,
      addressId: input.addressId ?? null,
      active: input.active ?? true,
    })
    return created(ctx, 'organizations', organization)
  }

  async updateOrganization(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updateOrganizationValidator)
    return envelope(
      ctx,
      await organizationServices().organizations.update(ctx.tenantContext, idParam(ctx), input)
    )
  }

  async listUnits(ctx: HttpContext) {
    const { organizationId } = await filters(ctx)
    return envelope(ctx, await organizationServices().units.list(ctx.tenantContext, organizationId))
  }

  async showUnit(ctx: HttpContext) {
    return envelope(ctx, await organizationServices().units.get(ctx.tenantContext, idParam(ctx)))
  }

  async createUnit(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createUnitValidator)
    const unit = await organizationServices().units.create(ctx.tenantContext, {
      organizationId: input.organizationId,
      parentId: input.parentId ?? null,
      code: input.code,
      name: input.name,
      type: input.type ?? 'OTHER',
      managerMembershipId: input.managerMembershipId ?? null,
      timezone: input.timezone ?? null,
      active: true,
    })
    return created(ctx, 'organization-units', unit)
  }

  async updateUnit(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updateUnitValidator)
    return envelope(
      ctx,
      await organizationServices().units.update(ctx.tenantContext, idParam(ctx), input)
    )
  }

  async listCostCenters(ctx: HttpContext) {
    const { organizationId } = await filters(ctx)
    return envelope(
      ctx,
      await organizationServices().costCenters.list(ctx.tenantContext, organizationId)
    )
  }

  async createCostCenter(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createCostCenterValidator)
    const costCenter = await organizationServices().costCenters.create(ctx.tenantContext, {
      organizationId: input.organizationId,
      parentId: input.parentId ?? null,
      code: input.code,
      name: input.name,
      responsibleMembershipId: input.responsibleMembershipId ?? null,
      active: true,
    })
    return created(ctx, 'cost-centers', costCenter)
  }

  async updateCostCenter(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updateCostCenterValidator)
    return envelope(
      ctx,
      await organizationServices().costCenters.update(ctx.tenantContext, idParam(ctx), input)
    )
  }

  async listTeam(ctx: HttpContext) {
    return envelope(ctx, await organizationServices().teams.list(ctx.tenantContext, idParam(ctx)))
  }

  async addTeamMember(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(addTeamMemberValidator)
    const member = await organizationServices().teams.add(ctx.tenantContext, {
      unitId: idParam(ctx),
      membershipId: input.membershipId,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      roleLabel: input.roleLabel ?? null,
    })
    return created(ctx, 'team-members', member)
  }

  async removeTeamMember(ctx: HttpContext) {
    await organizationServices().teams.remove(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }

  async listScopes(ctx: HttpContext) {
    const { membershipId } = await filters(ctx)
    return envelope(ctx, await organizationServices().scopes.list(ctx.tenantContext, membershipId))
  }

  async addScope(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(addScopeValidator)
    const scope = await organizationServices().scopes.add(ctx.tenantContext, {
      membershipId: input.membershipId,
      organizationId: input.organizationId,
      organizationUnitId: input.organizationUnitId ?? null,
      includeDescendants: input.includeDescendants ?? false,
    })
    return created(ctx, 'membership-scopes', scope)
  }

  async removeScope(ctx: HttpContext) {
    await organizationServices().scopes.remove(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }
}
