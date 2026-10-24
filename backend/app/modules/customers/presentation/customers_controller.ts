import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { iamServices } from '#core/permissions/index'
import { partyServices } from '#core/party/index'
import { isUuid } from '#core/tenancy/index'
import type { Customer } from '#modules/customers/application/ports'
import { customerServices } from '#modules/customers/presentation/composition'
import {
  blockCustomerValidator,
  createCustomerValidator,
  createInteractionValidator,
  createSegmentValidator,
  listCustomersValidator,
  listInteractionsValidator,
  unblockCustomerValidator,
  updateCustomerValidator,
  updateInteractionValidator,
  updateSegmentValidator,
} from '#modules/customers/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** O limite de crédito é financeiro: só quem gere crédito o vê (campo sensível); os restantes recebem `null`. */
async function canSeeCredit(ctx: HttpContext): Promise<boolean> {
  const decision = await iamServices().authorize.decision(
    ctx.tenantContext,
    'customer.credit_manage'
  )
  return decision.allowed
}

const present = (customer: Customer, credit: boolean) => ({
  ...customer,
  creditLimit: credit ? customer.creditLimit : null,
})

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class CustomersController {
  // --- segmentos -----------------------------------------------------------------------------

  async listSegments(ctx: HttpContext) {
    return envelope(ctx, await customerServices().segments.list(ctx.tenantContext))
  }

  async createSegment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createSegmentValidator)
    const created = await customerServices().segments.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/customer-segments/${created.id}`)
    return envelope(ctx, created)
  }

  async updateSegment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateSegmentValidator)
    return envelope(
      ctx,
      await customerServices().segments.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  // --- clientes ------------------------------------------------------------------------------

  async listCustomers(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listCustomersValidator, { data: ctx.request.qs() })
    const { items, total } = await customerServices().customers.list(ctx.tenantContext, q)
    const credit = await canSeeCredit(ctx)
    return envelope(
      ctx,
      items.map((c) => present(c, credit)),
      { total }
    )
  }

  /** Detalhe: o cliente e os contactos da Party (só a quem pode ler a Party; sem `party.read` vêm vazios). */
  async showCustomer(ctx: HttpContext) {
    const customer = await customerServices().customers.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    const partyDecision = await iamServices().authorize.decision(ctx.tenantContext, 'party.read')
    const party = partyDecision.allowed
      ? await partyServices().parties.get(ctx.tenantContext, customer.partyId)
      : null
    const contacts = party ? party.detail.contacts : []
    return envelope(ctx, { ...present(customer, await canSeeCredit(ctx)), contacts })
  }

  async createCustomer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createCustomerValidator)
    const credit = await canSeeCredit(ctx)
    const created = await customerServices().customers.create(ctx.tenantContext, b, {
      canManageCredit: credit,
    })
    ctx.response.status(201).header('location', `/api/v1/customers/${created.id}`)
    return envelope(ctx, present(created, credit))
  }

  async updateCustomer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateCustomerValidator)
    const credit = await canSeeCredit(ctx)
    const updated = await customerServices().customers.update(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b,
      { canManageCredit: credit }
    )
    return envelope(ctx, present(updated, credit))
  }

  async blockCustomer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(blockCustomerValidator)
    const blocked = await customerServices().customers.block(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    return envelope(ctx, present(blocked, await canSeeCredit(ctx)))
  }

  async unblockCustomer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(unblockCustomerValidator)
    const unblocked = await customerServices().customers.unblock(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    return envelope(ctx, present(unblocked, await canSeeCredit(ctx)))
  }

  // --- interacções ---------------------------------------------------------------------------

  async listInteractions(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listInteractionsValidator, { data: ctx.request.qs() })
    const { items, total } = await customerServices().interactions.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showInteraction(ctx: HttpContext) {
    return envelope(
      ctx,
      await customerServices().interactions.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createInteraction(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createInteractionValidator)
    const created = await customerServices().interactions.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/interactions/${created.id}`)
    return envelope(ctx, created)
  }

  async updateInteraction(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateInteractionValidator)
    return envelope(
      ctx,
      await customerServices().interactions.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }
}
