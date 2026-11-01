import {
  LucidTenantScope,
  TenantRepository,
  type TenantRow,
  type TenantScope,
} from '#core/tenancy/index'
import {
  contactKey,
  identityKey,
  taxKey,
  type Address,
  type AddressType,
  type Contact,
  type ContactType,
  type OrganizationParty,
  type Party,
  type PartyKind,
  type PartyRelationship,
  type PartyStatus,
  type Person,
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

interface PartyRow extends TenantRow {
  kind: PartyKind
  display_name: string
  status: PartyStatus
  external_reference: string | null
}
interface ContactRow extends TenantRow {
  party_id: string
  type: ContactType
  value: string
  label: string | null
  is_primary: boolean
  verified_at: Date | null
}
interface AddressRow extends TenantRow {
  party_id: string
  type: AddressType
  line1: string
  line2: string | null
  city: string
  province: string | null
  country_code: string
  postal_code: string | null
  is_primary: boolean
}

class Parties extends TenantRepository<PartyRow> {
  protected readonly table = 'parties'
}
class Contacts extends TenantRepository<ContactRow> {
  protected readonly table = 'contacts'
}
class Addresses extends TenantRepository<AddressRow> {
  protected readonly table = 'addresses'
}

const toParty = (r: PartyRow): Party => ({
  id: r.id,
  kind: r.kind,
  displayName: r.display_name,
  status: r.status,
  externalReference: r.external_reference,
  version: r.version,
})
const toContact = (r: ContactRow): Contact => ({
  id: r.id,
  partyId: r.party_id,
  type: r.type,
  value: r.value,
  label: r.label,
  isPrimary: r.is_primary,
  verifiedAt: r.verified_at,
  version: r.version,
})
const toAddress = (r: AddressRow): Address => ({
  id: r.id,
  partyId: r.party_id,
  type: r.type,
  line1: r.line1,
  line2: r.line2,
  city: r.city,
  province: r.province,
  countryCode: r.country_code,
  postalCode: r.postal_code,
  isPrimary: r.is_primary,
  version: r.version,
})

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const contextOf = (scope: TenantScope) => (scope as LucidTenantScope).context
const tenantOf = (scope: TenantScope) => contextOf(scope).tenantId
const audit = (scope: TenantScope) => {
  const id = contextOf(scope).membershipId as string
  return [id, id]
}

/** Escapa `%`, `_` e `\` para pesquisas `ilike` com o texto do utilizador. */
const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

function pick<T extends object>(values: T, map: Record<string, string>) {
  const out: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(map)) {
    const value = (values as Record<string, unknown>)[key]
    if (value !== undefined) out[column] = value
  }
  return out
}

export class LucidPartyStore implements PartyStore {
  private readonly parties = new Parties()
  private readonly contacts = new Contacts()
  private readonly addresses = new Addresses()

  // --- criar -----------------------------------------------------------------------------------

  private async insertParty(
    scope: TenantScope,
    kind: PartyKind,
    base: { displayName: string; externalReference: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into parties (tenant_id, kind, display_name, external_reference,
                            created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) returning id`,
      [tenantOf(scope), kind, base.displayName, base.externalReference as string, ...audit(scope)]
    )
    return (result.rows as { id: string }[])[0].id
  }

  async createPerson(scope: TenantScope, input: NewPerson) {
    const id = await this.insertParty(scope, 'PERSON', input)
    await trxOf(scope).rawQuery(
      `insert into people (tenant_id, party_id, given_names, family_name, birth_date, nationality,
                           identity_type, identity_number, identity_key,
                           created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        id,
        input.givenNames,
        input.familyName,
        input.birthDate as string,
        input.nationality as string,
        input.identityType as string,
        input.identityNumber as string,
        identityKey(input.identityType, input.identityNumber) as string,
        ...audit(scope),
      ]
    )
    return id
  }

  async createOrganization(scope: TenantScope, input: NewOrganizationParty) {
    const id = await this.insertParty(scope, 'ORGANIZATION', input)
    await trxOf(scope).rawQuery(
      `insert into organization_parties (tenant_id, party_id, legal_name, tax_country, tax_id, tax_key,
                                         registration_number, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        id,
        input.legalName,
        input.taxCountry as string,
        input.taxId as string,
        taxKey(input.taxCountry, input.taxId) as string,
        input.registrationNumber as string,
        ...audit(scope),
      ]
    )
    return id
  }

  // --- ler -------------------------------------------------------------------------------------

  async find(scope: TenantScope, id: string): Promise<PartyDetail | null> {
    const row = await this.parties.findById(scope, id)
    if (!row) return null
    const trx = trxOf(scope)
    const tenantId = tenantOf(scope)

    let person: Person | null = null
    let organization: OrganizationParty | null = null
    if (row.kind === 'PERSON') {
      const result = await trx.rawQuery(
        `select id, given_names, family_name, birth_date::text as birth_date, nationality,
                identity_type, identity_number
           from people where tenant_id = ? and party_id = ?`,
        [tenantId, id]
      )
      const p = (result.rows as Record<string, string | null>[])[0]
      if (p) {
        person = {
          id: p.id as string,
          givenNames: p.given_names as string,
          familyName: p.family_name as string,
          birthDate: p.birth_date,
          nationality: p.nationality,
          identityType: p.identity_type,
          identityNumber: p.identity_number,
        }
      }
    } else {
      const o = await trx
        .from('organization_parties')
        .where({ tenant_id: tenantId, party_id: id })
        .first()
      if (o) {
        organization = {
          id: o.id,
          legalName: o.legal_name,
          taxCountry: o.tax_country,
          taxId: o.tax_id,
          registrationNumber: o.registration_number,
        }
      }
    }

    const contacts = await trx
      .from('contacts')
      .where({ tenant_id: tenantId, party_id: id })
      .orderBy([
        { column: 'type' },
        { column: 'is_primary', order: 'desc' },
        { column: 'created_at' },
      ])
    const addresses = await trx
      .from('addresses')
      .where({ tenant_id: tenantId, party_id: id })
      .orderBy([
        { column: 'type' },
        { column: 'is_primary', order: 'desc' },
        { column: 'created_at' },
      ])
    return {
      party: toParty(row),
      person,
      organization,
      contacts: (contacts as ContactRow[]).map(toContact),
      addresses: (addresses as AddressRow[]).map(toAddress),
    }
  }

  async list(scope: TenantScope, filter: PartyFilter) {
    const query = trxOf(scope)
      .from('parties as p')
      .where('p.tenant_id', tenantOf(scope))
      .select('p.*')
      .orderBy([{ column: 'p.display_name' }, { column: 'p.id' }])
      .limit(filter.limit)
      .offset(filter.offset)
    if (filter.kind) query.where('p.kind', filter.kind)
    if (filter.status) query.where('p.status', filter.status)
    if (filter.q) {
      const pattern = like(filter.q.trim())
      query.where((group) => {
        group
          .whereRaw('p.display_name ilike ?', [pattern])
          .orWhereRaw('p.external_reference ilike ?', [pattern])
          .orWhereExists((sub) =>
            sub
              .from('contacts as c')
              .select(trxOf(scope).raw('1'))
              .whereRaw('c.tenant_id = p.tenant_id and c.party_id = p.id and c.value_key ilike ?', [
                like(filter.q?.trim().toLowerCase() ?? ''),
              ])
          )
      })
    }
    return ((await query) as PartyRow[]).map(toParty)
  }

  // --- actualizar ------------------------------------------------------------------------------

  async updateParty(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Pick<Party, 'displayName' | 'status' | 'externalReference'>>
  ) {
    await this.parties.update(
      scope,
      id,
      expectedVersion,
      pick(values, {
        displayName: 'display_name',
        status: 'status',
        externalReference: 'external_reference',
      }) as never
    )
  }

  async updatePerson(scope: TenantScope, partyId: string, values: Partial<Omit<Person, 'id'>>) {
    const trx = trxOf(scope)
    const where = { tenant_id: tenantOf(scope), party_id: partyId }
    const current = await trx.from('people').where(where).first()
    if (!current) return
    const type = values.identityType !== undefined ? values.identityType : current.identity_type
    const number =
      values.identityNumber !== undefined ? values.identityNumber : current.identity_number
    await trx
      .from('people')
      .where(where)
      .update({
        ...pick(values, {
          givenNames: 'given_names',
          familyName: 'family_name',
          birthDate: 'birth_date',
          nationality: 'nationality',
          identityType: 'identity_type',
          identityNumber: 'identity_number',
        }),
        identity_key: identityKey(type, number),
        updated_at: new Date(),
      })
  }

  async updateOrganization(
    scope: TenantScope,
    partyId: string,
    values: Partial<Omit<OrganizationParty, 'id'>>
  ) {
    const trx = trxOf(scope)
    const where = { tenant_id: tenantOf(scope), party_id: partyId }
    const current = await trx.from('organization_parties').where(where).first()
    if (!current) return
    const country = values.taxCountry !== undefined ? values.taxCountry : current.tax_country
    const taxId = values.taxId !== undefined ? values.taxId : current.tax_id
    await trx
      .from('organization_parties')
      .where(where)
      .update({
        ...pick(values, {
          legalName: 'legal_name',
          taxCountry: 'tax_country',
          taxId: 'tax_id',
          registrationNumber: 'registration_number',
        }),
        tax_key: taxKey(country, taxId),
        updated_at: new Date(),
      })
  }

  // --- duplicados ------------------------------------------------------------------------------

  async duplicatesOf(scope: TenantScope, partyId: string): Promise<PossibleDuplicate[]> {
    const tenantId = tenantOf(scope)
    const result = await trxOf(scope).rawQuery(
      `select p.id, p.display_name, array_agg(distinct r.reason) as reasons
         from (
           select other.party_id, 'IDENTITY' as reason
             from people me
             join people other on other.tenant_id = me.tenant_id and other.identity_key = me.identity_key
                              and other.party_id <> me.party_id
            where me.tenant_id = ? and me.party_id = ? and me.identity_key is not null
           union all
           select other.party_id, 'TAX_ID'
             from organization_parties me
             join organization_parties other on other.tenant_id = me.tenant_id and other.tax_key = me.tax_key
                                            and other.party_id <> me.party_id
            where me.tenant_id = ? and me.party_id = ? and me.tax_key is not null
           union all
           select c2.party_id, 'CONTACT'
             from contacts c1
             join contacts c2 on c2.tenant_id = c1.tenant_id and c2.type = c1.type
                             and c2.value_key = c1.value_key and c2.party_id <> c1.party_id
            where c1.tenant_id = ? and c1.party_id = ?
         ) r
         join parties p on p.tenant_id = ? and p.id = r.party_id
        group by p.id, p.display_name
        order by p.display_name, p.id`,
      [tenantId, partyId, tenantId, partyId, tenantId, partyId, tenantId]
    )
    return (result.rows as { id: string; display_name: string; reasons: string[] }[]).map((r) => ({
      partyId: r.id,
      displayName: r.display_name,
      reasons: r.reasons as PossibleDuplicate['reasons'],
    }))
  }

  // --- contactos -------------------------------------------------------------------------------

  /** Serializa as alterações de contactos/moradas de um party (um principal por tipo). */
  private async lockParty(scope: TenantScope, partyId: string) {
    await trxOf(scope).rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `party:${tenantOf(scope)}:${partyId}`,
    ])
  }

  async insertContact(scope: TenantScope, partyId: string, values: ContactValues) {
    await this.lockParty(scope, partyId)
    const trx = trxOf(scope)
    const tenantId = tenantOf(scope)
    const existing = await trx
      .from('contacts')
      .where({ tenant_id: tenantId, party_id: partyId, type: values.type })
      .first()
    // O primeiro contacto de um tipo é o principal; pedir principal demove o anterior.
    const primary = values.isPrimary || !existing
    if (primary) {
      await trx
        .from('contacts')
        .where({ tenant_id: tenantId, party_id: partyId, type: values.type, is_primary: true })
        .update({ is_primary: false, updated_at: new Date() })
    }
    const [row] = await trx
      .table('contacts')
      .insert({
        tenant_id: tenantId,
        party_id: partyId,
        type: values.type,
        value: values.value,
        value_key: contactKey(values.type, values.value),
        label: values.label,
        is_primary: primary,
        created_by_membership_id: contextOf(scope).membershipId,
        updated_by_membership_id: contextOf(scope).membershipId,
      })
      .returning('*')
    return toContact(row)
  }

  async findContact(scope: TenantScope, id: string) {
    const row = await this.contacts.findById(scope, id)
    return row ? toContact(row) : null
  }

  async updateContact(
    scope: TenantScope,
    contact: Contact,
    expectedVersion: number,
    values: Partial<ContactValues>
  ) {
    await this.lockParty(scope, contact.partyId)
    const trx = trxOf(scope)
    if (values.isPrimary) {
      await trx
        .from('contacts')
        .where({
          tenant_id: tenantOf(scope),
          party_id: contact.partyId,
          type: contact.type,
          is_primary: true,
        })
        .whereNot('id', contact.id)
        .update({ is_primary: false, updated_at: new Date() })
    }
    const changes: Record<string, unknown> = {
      ...pick(values, { value: 'value', label: 'label', isPrimary: 'is_primary' }),
    }
    if (values.value !== undefined && values.value !== contact.value) {
      changes.value_key = contactKey(contact.type, values.value)
      changes.verified_at = null // um valor novo deixa de estar verificado
    }
    const row = await this.contacts.update(scope, contact.id, expectedVersion, changes as never)
    return toContact(row)
  }

  async deleteContact(scope: TenantScope, id: string) {
    const rows = await trxOf(scope)
      .from('contacts')
      .where({ tenant_id: tenantOf(scope), id })
      .delete()
      .returning('id')
    return rows.length > 0
  }

  // --- moradas ---------------------------------------------------------------------------------

  async insertAddress(scope: TenantScope, partyId: string, values: AddressValues) {
    await this.lockParty(scope, partyId)
    const trx = trxOf(scope)
    const tenantId = tenantOf(scope)
    const existing = await trx
      .from('addresses')
      .where({ tenant_id: tenantId, party_id: partyId, type: values.type })
      .first()
    const primary = values.isPrimary || !existing
    if (primary) {
      await trx
        .from('addresses')
        .where({ tenant_id: tenantId, party_id: partyId, type: values.type, is_primary: true })
        .update({ is_primary: false, updated_at: new Date() })
    }
    const [row] = await trx
      .table('addresses')
      .insert({
        tenant_id: tenantId,
        party_id: partyId,
        type: values.type,
        line1: values.line1,
        line2: values.line2,
        city: values.city,
        province: values.province,
        country_code: values.countryCode,
        postal_code: values.postalCode,
        is_primary: primary,
        created_by_membership_id: contextOf(scope).membershipId,
        updated_by_membership_id: contextOf(scope).membershipId,
      })
      .returning('*')
    return toAddress(row)
  }

  async findAddress(scope: TenantScope, id: string) {
    const row = await this.addresses.findById(scope, id)
    return row ? toAddress(row) : null
  }

  async updateAddress(
    scope: TenantScope,
    address: Address,
    expectedVersion: number,
    values: Partial<AddressValues>
  ) {
    await this.lockParty(scope, address.partyId)
    const trx = trxOf(scope)
    const type = values.type ?? address.type
    if (values.isPrimary) {
      await trx
        .from('addresses')
        .where({ tenant_id: tenantOf(scope), party_id: address.partyId, type, is_primary: true })
        .whereNot('id', address.id)
        .update({ is_primary: false, updated_at: new Date() })
    }
    const row = await this.addresses.update(
      scope,
      address.id,
      expectedVersion,
      pick(values, {
        type: 'type',
        line1: 'line1',
        line2: 'line2',
        city: 'city',
        province: 'province',
        countryCode: 'country_code',
        postalCode: 'postal_code',
        isPrimary: 'is_primary',
      }) as never
    )
    return toAddress(row)
  }

  async deleteAddress(scope: TenantScope, id: string) {
    const rows = await trxOf(scope)
      .from('addresses')
      .where({ tenant_id: tenantOf(scope), id })
      .delete()
      .returning('id')
    return rows.length > 0
  }

  // --- relações --------------------------------------------------------------------------------

  async listRelationships(scope: TenantScope, partyId: string) {
    const result = await trxOf(scope).rawQuery(
      `select id, source_party_id, target_party_id, relationship_type,
              starts_on::text as starts_on, ends_on::text as ends_on
         from party_relationships
        where tenant_id = ? and (source_party_id = ? or target_party_id = ?)
        order by created_at, id`,
      [tenantOf(scope), partyId, partyId]
    )
    return (result.rows as Record<string, string | null>[]).map(toRelationship)
  }

  async insertRelationship(scope: TenantScope, values: Omit<PartyRelationship, 'id'>) {
    const result = await trxOf(scope).rawQuery(
      `insert into party_relationships
         (tenant_id, source_party_id, target_party_id, relationship_type, starts_on, ends_on,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id, source_party_id, target_party_id, relationship_type,
                 starts_on::text as starts_on, ends_on::text as ends_on`,
      [
        tenantOf(scope),
        values.sourcePartyId,
        values.targetPartyId,
        values.relationshipType,
        values.startsOn as string,
        values.endsOn as string,
        ...audit(scope),
      ]
    )
    const [row] = result.rows as Record<string, string | null>[]
    return row ? toRelationship(row) : null
  }

  async deleteRelationship(scope: TenantScope, id: string) {
    const rows = await trxOf(scope)
      .from('party_relationships')
      .where({ tenant_id: tenantOf(scope), id })
      .delete()
      .returning('id')
    return rows.length > 0
  }

  async personIdOfParty(scope: TenantScope, partyId: string) {
    const row = await trxOf(scope)
      .from('people')
      .where({ tenant_id: tenantOf(scope), party_id: partyId })
      .first()
    return row ? (row.id as string) : null
  }
}

function toRelationship(r: Record<string, string | null>): PartyRelationship {
  return {
    id: r.id as string,
    sourcePartyId: r.source_party_id as string,
    targetPartyId: r.target_party_id as string,
    relationshipType: r.relationship_type as string,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
  }
}
