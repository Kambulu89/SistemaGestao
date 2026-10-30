import type { TenantScope } from '#core/tenancy/index'
import type {
  Address,
  AddressType,
  Contact,
  ContactType,
  OrganizationParty,
  Party,
  PartyKind,
  PartyRelationship,
  PartyStatus,
  Person,
  PossibleDuplicate,
} from '#core/party/domain/party'

export interface PartyDetail {
  party: Party
  person: Person | null
  organization: OrganizationParty | null
  contacts: Contact[]
  addresses: Address[]
}

export interface PartyFilter {
  kind?: PartyKind
  status?: PartyStatus
  /** Pesquisa só por nome, referência e contactos — nunca por campos sensíveis. */
  q?: string
  limit: number
  offset: number
}

export interface NewPerson {
  displayName: string
  externalReference: string | null
  givenNames: string
  familyName: string
  birthDate: string | null
  nationality: string | null
  identityType: string | null
  identityNumber: string | null
}

export interface NewOrganizationParty {
  displayName: string
  externalReference: string | null
  legalName: string
  taxCountry: string | null
  taxId: string | null
  registrationNumber: string | null
}

export interface ContactValues {
  type: ContactType
  value: string
  label: string | null
  isPrimary: boolean
}

export interface AddressValues {
  type: AddressType
  line1: string
  line2: string | null
  city: string
  province: string | null
  countryCode: string
  postalCode: string | null
  isPrimary: boolean
}

/** Dados de Party do tenant. Todas as operações correm no âmbito (transacção + RLS) do contexto. */
export interface PartyStore {
  createPerson(scope: TenantScope, input: NewPerson): Promise<string>
  createOrganization(scope: TenantScope, input: NewOrganizationParty): Promise<string>
  find(scope: TenantScope, id: string): Promise<PartyDetail | null>
  list(scope: TenantScope, filter: PartyFilter): Promise<Party[]>
  updateParty(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Pick<Party, 'displayName' | 'status' | 'externalReference'>>
  ): Promise<void>
  updatePerson(
    scope: TenantScope,
    partyId: string,
    values: Partial<Omit<Person, 'id'>>
  ): Promise<void>
  updateOrganization(
    scope: TenantScope,
    partyId: string,
    values: Partial<Omit<OrganizationParty, 'id'>>
  ): Promise<void>

  /** Duplicados possíveis por identificação ou contacto (exclui o próprio party). */
  duplicatesOf(scope: TenantScope, partyId: string): Promise<PossibleDuplicate[]>

  insertContact(scope: TenantScope, partyId: string, values: ContactValues): Promise<Contact>
  findContact(scope: TenantScope, id: string): Promise<Contact | null>
  updateContact(
    scope: TenantScope,
    contact: Contact,
    expectedVersion: number,
    values: Partial<ContactValues>
  ): Promise<Contact>
  deleteContact(scope: TenantScope, id: string): Promise<boolean>

  insertAddress(scope: TenantScope, partyId: string, values: AddressValues): Promise<Address>
  findAddress(scope: TenantScope, id: string): Promise<Address | null>
  updateAddress(
    scope: TenantScope,
    address: Address,
    expectedVersion: number,
    values: Partial<AddressValues>
  ): Promise<Address>
  deleteAddress(scope: TenantScope, id: string): Promise<boolean>

  listRelationships(scope: TenantScope, partyId: string): Promise<PartyRelationship[]>
  /** `null` se a relação (origem, destino, tipo) já existir. */
  insertRelationship(
    scope: TenantScope,
    values: Omit<PartyRelationship, 'id'>
  ): Promise<PartyRelationship | null>
  deleteRelationship(scope: TenantScope, id: string): Promise<boolean>

  /** O id da pessoa (`people.id`) de um party PERSON, ou `null`. */
  personIdOfParty(scope: TenantScope, partyId: string): Promise<string | null>
}
