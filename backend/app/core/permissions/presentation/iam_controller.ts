import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import type { Condition } from '#core/permissions/domain/condition'
import type { FieldRule } from '#core/permissions/domain/decision'
import { iamServices } from '#core/permissions/presentation/composition'
import {
  assignRoleValidator,
  createPolicyValidator,
  createRoleValidator,
  listAssignmentsValidator,
  simulateValidator,
  updatePolicyValidator,
  updateRoleValidator,
} from '#core/permissions/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const asCondition = (value: unknown): Condition | null =>
  value === undefined || value === null ? null : (value as Condition)

const asFieldRules = (
  rules: { field: string; mode: FieldRule['mode']; when?: unknown }[] | undefined
) =>
  rules?.map((r) => ({
    field: r.field,
    mode: r.mode,
    ...(r.when ? { when: r.when as Condition } : {}),
  }))

/** Transporte apenas: valida o pedido, chama o caso de uso e formata a resposta. */
export default class IamController {
  async permissions(ctx: HttpContext) {
    return envelope(ctx, await iamServices().permissions.execute())
  }

  async listRoles(ctx: HttpContext) {
    return envelope(ctx, await iamServices().roles.list(ctx.tenantContext))
  }

  async showRole(ctx: HttpContext) {
    return envelope(ctx, await iamServices().roles.get(ctx.tenantContext, idParam(ctx)))
  }

  async createRole(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createRoleValidator)
    const role = await iamServices().roles.create(ctx.tenantContext, input)
    ctx.response.status(201).header('location', `/api/v1/roles/${role.id}`)
    return envelope(ctx, role)
  }

  async updateRole(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updateRoleValidator)
    return envelope(ctx, await iamServices().roles.update(ctx.tenantContext, idParam(ctx), input))
  }

  async deleteRole(ctx: HttpContext) {
    await iamServices().roles.delete(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }

  async listAssignments(ctx: HttpContext) {
    const { membershipId } = await ctx.request.validateUsing(listAssignmentsValidator, {
      data: ctx.request.qs(),
    })
    return envelope(ctx, await iamServices().assignments.list(ctx.tenantContext, membershipId))
  }

  async assign(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(assignRoleValidator)
    const assignment = await iamServices().assignments.assign(ctx.tenantContext, input)
    ctx.response.status(201).header('location', `/api/v1/role-assignments/${assignment.id}`)
    return envelope(ctx, assignment)
  }

  async revoke(ctx: HttpContext) {
    await iamServices().assignments.revoke(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }

  async listPolicies(ctx: HttpContext) {
    return envelope(ctx, await iamServices().policies.list(ctx.tenantContext))
  }

  async createPolicy(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createPolicyValidator)
    const policy = await iamServices().policies.create(ctx.tenantContext, {
      name: input.name,
      resource: input.resource,
      action: input.action,
      effect: input.effect,
      condition: asCondition(input.condition),
      priority: input.priority ?? 0,
      status: input.status ?? 'DRAFT',
      fieldRules: asFieldRules(input.fieldRules) ?? [],
    })
    ctx.response.status(201).header('location', `/api/v1/access-policies/${policy.id}`)
    return envelope(ctx, policy)
  }

  async updatePolicy(ctx: HttpContext) {
    const { condition, fieldRules, ...rest } =
      await ctx.request.validateUsing(updatePolicyValidator)
    const policy = await iamServices().policies.update(ctx.tenantContext, idParam(ctx), {
      ...rest,
      ...(condition !== undefined ? { condition: asCondition(condition) } : {}),
      ...(fieldRules !== undefined ? { fieldRules: asFieldRules(fieldRules) } : {}),
    })
    return envelope(ctx, policy)
  }

  /** Só diz o que aconteceria; não concede nem altera nada. */
  async simulate(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(simulateValidator)
    return envelope(ctx, await iamServices().simulate.execute(ctx.tenantContext, input))
  }
}
