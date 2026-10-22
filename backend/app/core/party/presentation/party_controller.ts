import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { forbiddenChanges, iamServices, redactFields } from '#core/permissions/index'
import type { PartyResult } from '#core/party/application/use_cases'
import { partyServices } from '#core/party/presentation/composition'
import {
  addAddressValidator,
  addContactValidator,
  addRelationshipValidator,
  createOrganizationPartyValidator,
  createPersonValidator,
  linkPersonValidator,
  listPartiesValidator,
  updateAddressValidator,
  updateContactValidator,
  updatePartyValidator,
} from '#core/party/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const loc = (ctx: HttpContext, path: string, id: string) =>
  ctx.response.status(201).header('location', `/api/v1/${path}/${id}`)

/** Campos que as regras de campo (C06) escondem a este actor para `party.read`. */
async function hiddenFields(ctx: HttpContext): Promise<string[]> {
  const decision = await iamServices().authorize.decision(ctx.tenantContext, 'party.read')
  return decision.hiddenFields
}

/** A resposta nunca inclui os campos escondidos (também em criações e alterações). */
function present(result: PartyResult, hidden: readonly string[]) {
  const { detail } = result
  return {
    ...redactFields(detail.party as unknown as Record<string, unknown>, hidden),
    person: detail.person
      ? redactFields(detail.person as unknown as Record<string, unknown>, hidden)
      : null,
    organization: detail.organization
      ? redactFields(detail.organization as unknown as Record<string, unknown>, hidden)
      : null,
    contacts: detail.contacts,
    addresses: detail.addresses,
    possibleDuplicates: result.possibleDuplicates,
  }
}

/** Transporte apenas: valida o pedido, chama o caso de uso e formata a resposta. */
export default class PartyController {
  async list(ctx: HttpContext) {
    const filter = await ctx.request.validateUsing(listPartiesValidator, { data: ctx.request.qs() })
    const parties = await partyServices().parties.list(ctx.tenantContext, {
      ...filter,
      limit: filter.limit ?? 50,
      offset: filter.offset ?? 0,
    })
    return envelope(ctx, parties)
  }

  async show(ctx: HttpContext) {
    const result = await partyServices().parties.get(ctx.tenantContext, idParam(ctx))
    return envelope(ctx, present(result, await hiddenFields(ctx)))
  }

  async duplicates(ctx: HttpContext) {
    return envelope(ctx, await partyServices().parties.duplicates(ctx.tenantContext, idParam(ctx)))
  }

  async createPerson(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createPersonValidator)
    const result = await partyServices().parties.createPerson(ctx.tenantContext, {
      displayName: input.displayName,
      externalReference: input.externalReference ?? null,
      givenNames: input.givenNames,
      familyName: input.familyName,
      birthDate: input.birthDate ?? null,
      nationality: input.nationality ?? null,
      identityType: input.identityType ?? null,
      identityNumber: input.identityNumber ?? null,
      contacts: input.contacts?.map((c) => ({
        ...c,
        label: c.label ?? null,
        isPrimary: c.isPrimary ?? false,
      })),
      addresses: input.addresses?.map(normalizeAddress),
    })
    loc(ctx, 'parties', result.detail.party.id)
    return envelope(ctx, present(result, await hiddenFields(ctx)))
  }

  async createOrganization(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createOrganizationPartyValidator)
    const result = await partyServices().parties.createOrganization(ctx.tenantContext, {
      displayName: input.displayName,
      externalReference: input.externalReference ?? null,
      legalName: input.legalName,
      taxCountry: input.taxCountry ?? null,
      taxId: input.taxId ?? null,
      registrationNumber: input.registrationNumber ?? null,
      contacts: input.contacts?.map((c) => ({
        ...c,
        label: c.label ?? null,
        isPrimary: c.isPrimary ?? false,
      })),
      addresses: input.addresses?.map(normalizeAddress),
    })
    loc(ctx, 'parties', result.detail.party.id)
    return envelope(ctx, present(result, await hiddenFields(ctx)))
  }

  async update(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updatePartyValidator)

    // Campos escondidos ou só de leitura para este actor (party.update) não podem ser alterados.
    const decision = await iamServices().authorize.decision(ctx.tenantContext, 'party.update')
    const changes = { ...input.person, ...input.organization }
    const forbidden = forbiddenChanges(changes, decision)
    if (forbidden.length > 0) {
      throw new ApiError(
        403,
        'FIELD_FORBIDDEN',
        'Não tem permissão para alterar alguns dos campos indicados.',
        forbidden.map((field) => ({
          path: field,
          code: 'FIELD_FORBIDDEN',
          message: 'Campo protegido.',
        }))
      )
    }

    const result = await partyServices().parties.update(ctx.tenantContext, idParam(ctx), input)
    return envelope(ctx, present(result, await hiddenFields(ctx)))
  }

  async addContact(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(addContactValidator)
    const contact = await partyServices().parties.addContact(ctx.tenantContext, idParam(ctx), {
      ...input,
      label: input.label ?? null,
      isPrimary: input.isPrimary ?? false,
    })
    loc(ctx, 'contacts', contact.id)
    return envelope(ctx, contact)
  }

  async updateContact(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updateContactValidator)
    return envelope(
      ctx,
      await partyServices().parties.updateContact(ctx.tenantContext, idParam(ctx), input)
    )
  }

  async removeContact(ctx: HttpContext) {
    await partyServices().parties.removeContact(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }

  async addAddress(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(addAddressValidator)
    const address = await partyServices().parties.addAddress(
      ctx.tenantContext,
      idParam(ctx),
      normalizeAddress(input)
    )
    loc(ctx, 'addresses', address.id)
    return envelope(ctx, address)
  }

  async updateAddress(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updateAddressValidator)
    return envelope(
      ctx,
      await partyServices().parties.updateAddress(ctx.tenantContext, idParam(ctx), input)
    )
  }

  async removeAddress(ctx: HttpContext) {
    await partyServices().parties.removeAddress(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }

  async listRelationships(ctx: HttpContext) {
    return envelope(
      ctx,
      await partyServices().parties.listRelationships(ctx.tenantContext, idParam(ctx))
    )
  }

  async addRelationship(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(addRelationshipValidator)
    const relationship = await partyServices().parties.addRelationship(ctx.tenantContext, {
      sourcePartyId: idParam(ctx),
      targetPartyId: input.targetPartyId,
      relationshipType: input.relationshipType,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
    })
    loc(ctx, 'party-relationships', relationship.id)
    return envelope(ctx, relationship)
  }

  async removeRelationship(ctx: HttpContext) {
    await partyServices().parties.removeRelationship(ctx.tenantContext, idParam(ctx))
    return ctx.response.noContent()
  }

  async linkMembership(ctx: HttpContext) {
    const { partyId } = await ctx.request.validateUsing(linkPersonValidator)
    const membership = await partyServices().parties.linkMembership(
      ctx.tenantContext,
      idParam(ctx),
      partyId
    )
    return envelope(ctx, {
      id: membership.id,
      personId: membership.personId,
      version: membership.version,
    })
  }
}

function normalizeAddress(a: {
  type: 'BILLING' | 'DELIVERY' | 'OTHER'
  line1: string
  line2?: string | null
  city: string
  province?: string | null
  countryCode: string
  postalCode?: string | null
  isPrimary?: boolean
}) {
  return {
    type: a.type,
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city,
    province: a.province ?? null,
    countryCode: a.countryCode,
    postalCode: a.postalCode ?? null,
    isPrimary: a.isPrimary ?? false,
  }
}
