import { ApiError, type ApiErrorDetail } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import type { Membership, MembershipStore } from '#core/membership/index'
import {
  addressIssues,
  contactIssues,
  displayNameOf,
  isIsoDate,
  organizationIssues,
  personIssues,
  type Address,
  type Contact,
  type PartyRelationship,
  type PossibleDuplicate,
} from '#core/party/domain/party'
import type {
  AddressValues,
  ContactValues,
  NewOrganizationParty,
  NewPerson,
  PartyDetail,
  PartyFilter,
  PartyStore,
} from '#core/party/application/ports'

const MAX_INITIAL_ITEMS = 10

const validation = (details: ApiErrorDetail[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

const prefixed = (prefix: string, issues: ApiErrorDetail[]) =>
  issues.map((i) => ({ ...i, path: `${prefix}.${i.path}` }))

export interface PartyResult {
  detail: PartyDetail
  /** Aviso, nunca bloqueio: a fusão de duplicados é sempre uma decisão humana. */
  possibleDuplicates: PossibleDuplicate[]
}

interface Clock {
  today(): string
}

export class PartyUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: PartyStore,
    private readonly memberships: MembershipStore,
    private readonly clock: Clock
  ) {}

  private async result(scope: Parameters<PartyStore['find']>[0], id: string): Promise<PartyResult> {
    const detail = await this.store.find(scope, id)
    if (!detail) throw ApiError.notFound('Registo não encontrado.')
    return { detail, possibleDuplicates: await this.store.duplicatesOf(scope, id) }
  }

  // --- criação -------------------------------------------------------------------------------

  createPerson(
    context: TenantContext,
    input: Omit<NewPerson, 'displayName'> & {
      displayName?: string | null
      contacts?: ContactValues[]
      addresses?: AddressValues[]
    }
  ): Promise<PartyResult> {
    const details = [
      ...personIssues(input, this.clock.today()),
      ...this.initialItemIssues(input.contacts, input.addresses),
    ]
    if (details.length > 0) throw validation(details)
    return this.uow.run(async (scope) => {
      const id = await this.store.createPerson(scope, {
        ...input,
        givenNames: input.givenNames.trim(),
        familyName: input.familyName.trim(),
        displayName: input.displayName?.trim() || displayNameOf(input.givenNames, input.familyName),
      })
      await this.addInitialItems(scope, id, input.contacts, input.addresses)
      return this.result(scope, id)
    }, context)
  }

  createOrganization(
    context: TenantContext,
    input: Omit<NewOrganizationParty, 'displayName'> & {
      displayName?: string | null
      contacts?: ContactValues[]
      addresses?: AddressValues[]
    }
  ): Promise<PartyResult> {
    const details = [
      ...organizationIssues(input),
      ...this.initialItemIssues(input.contacts, input.addresses),
    ]
    if (details.length > 0) throw validation(details)
    return this.uow.run(async (scope) => {
      const id = await this.store.createOrganization(scope, {
        ...input,
        legalName: input.legalName.trim(),
        displayName: input.displayName?.trim() || input.legalName.trim(),
      })
      await this.addInitialItems(scope, id, input.contacts, input.addresses)
      return this.result(scope, id)
    }, context)
  }

  private initialItemIssues(contacts: ContactValues[] = [], addresses: AddressValues[] = []) {
    const details: ApiErrorDetail[] = []
    if (contacts.length > MAX_INITIAL_ITEMS || addresses.length > MAX_INITIAL_ITEMS) {
      details.push({
        path: 'contacts',
        code: 'TOO_MANY',
        message: `No máximo ${MAX_INITIAL_ITEMS}.`,
      })
    }
    contacts.forEach((c, i) =>
      details.push(...prefixed(`contacts[${i}]`, contactIssues(c.type, c.value)))
    )
    addresses.forEach((a, i) => details.push(...prefixed(`addresses[${i}]`, addressIssues(a))))
    return details
  }

  private async addInitialItems(
    scope: Parameters<PartyStore['find']>[0],
    partyId: string,
    contacts: ContactValues[] = [],
    addresses: AddressValues[] = []
  ) {
    for (const contact of contacts) {
      await this.store.insertContact(scope, partyId, { ...contact, value: contact.value.trim() })
    }
    for (const address of addresses) await this.store.insertAddress(scope, partyId, address)
  }

  // --- leitura / alteração -------------------------------------------------------------------

  list(context: TenantContext, filter: PartyFilter) {
    return this.uow.run((scope) => this.store.list(scope, filter), context)
  }

  get(context: TenantContext, id: string): Promise<PartyResult> {
    return this.uow.run((scope) => this.result(scope, id), context)
  }

  duplicates(context: TenantContext, id: string): Promise<PossibleDuplicate[]> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.find(scope, id))) throw ApiError.notFound('Registo não encontrado.')
      return this.store.duplicatesOf(scope, id)
    }, context)
  }

  /**
   * Corrige os dados base. Os documentos emitidos guardam o seu próprio snapshot (módulos futuros),
   * por isso alterar o NIF ou o nome aqui nunca reescreve histórico.
   */
  update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      displayName?: string
      status?: 'ACTIVE' | 'INACTIVE'
      externalReference?: string | null
      person?: Parameters<PartyStore['updatePerson']>[2]
      organization?: Parameters<PartyStore['updateOrganization']>[2]
    }
  ): Promise<PartyResult> {
    const { expectedVersion, person, organization, ...base } = input
    const details: ApiErrorDetail[] = []
    if (base.displayName !== undefined && !base.displayName.trim()) {
      details.push({ path: 'displayName', code: 'REQUIRED', message: 'Indique o nome.' })
    }
    if (details.length > 0) throw validation(details)

    return this.uow.run(async (scope) => {
      const current = await this.store.find(scope, id)
      if (!current) throw ApiError.notFound('Registo não encontrado.')
      if (
        (person && current.party.kind !== 'PERSON') ||
        (organization && current.party.kind !== 'ORGANIZATION')
      ) {
        throw validation([
          {
            path: person ? 'person' : 'organization',
            code: 'KIND_MISMATCH',
            message: 'Os dados do subtipo não correspondem ao tipo do registo.',
          },
        ])
      }
      // O subtipo valida-se já com os valores resultantes (ex.: o país fiscal que já existia).
      const merged = [
        ...(person && current.person
          ? personIssues({ ...current.person, ...person }, this.clock.today())
          : []),
        ...(organization && current.organization
          ? organizationIssues({ ...current.organization, ...organization })
          : []),
      ]
      if (merged.length > 0) throw validation(merged)
      await this.store.updateParty(scope, id, expectedVersion, base)
      if (person) await this.store.updatePerson(scope, id, person)
      if (organization) await this.store.updateOrganization(scope, id, organization)
      return this.result(scope, id)
    }, context)
  }

  // --- contactos e moradas -------------------------------------------------------------------

  addContact(context: TenantContext, partyId: string, values: ContactValues): Promise<Contact> {
    const issues = contactIssues(values.type, values.value)
    if (issues.length > 0) throw validation(issues)
    return this.uow.run(async (scope) => {
      if (!(await this.store.find(scope, partyId)))
        throw ApiError.notFound('Registo não encontrado.')
      return this.store.insertContact(scope, partyId, { ...values, value: values.value.trim() })
    }, context)
  }

  updateContact(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number } & Partial<Omit<ContactValues, 'type'>>
  ): Promise<Contact> {
    const { expectedVersion, ...values } = input
    return this.uow.run(async (scope) => {
      const contact = await this.store.findContact(scope, id)
      if (!contact) throw ApiError.notFound('Contacto não encontrado.')
      if (values.value !== undefined) {
        const issues = contactIssues(contact.type, values.value)
        if (issues.length > 0) throw validation(issues)
        values.value = values.value.trim()
      }
      return this.store.updateContact(scope, contact, expectedVersion, values)
    }, context)
  }

  removeContact(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.deleteContact(scope, id)))
        throw ApiError.notFound('Contacto não encontrado.')
    }, context)
  }

  addAddress(context: TenantContext, partyId: string, values: AddressValues): Promise<Address> {
    const issues = addressIssues(values)
    if (issues.length > 0) throw validation(issues)
    return this.uow.run(async (scope) => {
      if (!(await this.store.find(scope, partyId)))
        throw ApiError.notFound('Registo não encontrado.')
      return this.store.insertAddress(scope, partyId, values)
    }, context)
  }

  updateAddress(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number } & Partial<AddressValues>
  ): Promise<Address> {
    const { expectedVersion, ...values } = input
    const issues = addressIssues(values, true)
    if (issues.length > 0) throw validation(issues)
    return this.uow.run(async (scope) => {
      const address = await this.store.findAddress(scope, id)
      if (!address) throw ApiError.notFound('Morada não encontrada.')
      return this.store.updateAddress(scope, address, expectedVersion, values)
    }, context)
  }

  removeAddress(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.deleteAddress(scope, id)))
        throw ApiError.notFound('Morada não encontrada.')
    }, context)
  }

  // --- relações ------------------------------------------------------------------------------

  listRelationships(context: TenantContext, partyId: string): Promise<PartyRelationship[]> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.find(scope, partyId)))
        throw ApiError.notFound('Registo não encontrado.')
      return this.store.listRelationships(scope, partyId)
    }, context)
  }

  addRelationship(
    context: TenantContext,
    input: Omit<PartyRelationship, 'id'>
  ): Promise<PartyRelationship> {
    const details: ApiErrorDetail[] = []
    if (input.sourcePartyId === input.targetPartyId) {
      details.push({
        path: 'targetPartyId',
        code: 'SAME_PARTY',
        message: 'A relação tem de ser entre registos diferentes.',
      })
    }
    if (!input.relationshipType.trim() || input.relationshipType.length > 50) {
      details.push({
        path: 'relationshipType',
        code: 'INVALID_TYPE',
        message: 'Tipo obrigatório (máx. 50).',
      })
    }
    for (const [path, value] of [
      ['startsOn', input.startsOn],
      ['endsOn', input.endsOn],
    ] as const) {
      if (value && !isIsoDate(value))
        details.push({ path, code: 'INVALID_DATE', message: 'Data inválida (AAAA-MM-DD).' })
    }
    if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
      details.push({
        path: 'endsOn',
        code: 'INVALID_WINDOW',
        message: 'O fim não pode ser anterior ao início.',
      })
    }
    if (details.length > 0) throw validation(details)
    return this.uow.run(async (scope) => {
      // Os dois registos têm de existir *neste* tenant (um id alheio é 404).
      for (const id of [input.sourcePartyId, input.targetPartyId]) {
        if (!(await this.store.find(scope, id))) throw ApiError.notFound('Registo não encontrado.')
      }
      const created = await this.store.insertRelationship(scope, {
        ...input,
        relationshipType: input.relationshipType.trim(),
      })
      if (!created) throw ApiError.conflict('RELATIONSHIP_EXISTS', 'A relação já existe.')
      return created
    }, context)
  }

  removeRelationship(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.deleteRelationship(scope, id)))
        throw ApiError.notFound('Relação não encontrada.')
    }, context)
  }

  // --- vínculo membership ↔ pessoa -----------------------------------------------------------

  /** Liga (ou desliga, com `null`) uma membership à Person de um party PERSON. Uma pessoa por membership. */
  linkMembership(
    context: TenantContext,
    membershipId: string,
    partyId: string | null
  ): Promise<Membership> {
    return this.uow.run(async (scope) => {
      await this.memberships.lockMembers(scope)
      const membership = await this.memberships.findById(scope, membershipId)
      if (!membership) throw ApiError.notFound('Membro não encontrado.')
      if (partyId === null) return this.memberships.setPerson(scope, membership, null)

      const party = await this.store.find(scope, partyId)
      if (!party) throw ApiError.notFound('Registo não encontrado.')
      const personId = await this.store.personIdOfParty(scope, partyId)
      if (party.party.kind !== 'PERSON' || !personId) {
        throw validation([
          { path: 'partyId', code: 'NOT_A_PERSON', message: 'O registo não é uma pessoa.' },
        ])
      }
      const taken = await this.memberships.findByPerson(scope, personId)
      if (taken && taken.id !== membership.id) {
        throw ApiError.conflict(
          'PERSON_ALREADY_LINKED',
          'Esta pessoa já está ligada a outro membro.'
        )
      }
      return this.memberships.setPerson(scope, membership, personId)
    }, context)
  }
}
