/** API pública do módulo de Party (C08). Outros módulos (Customer, Supplier, Employee…) importam **apenas** daqui. */
export {
  SENSITIVE_PERSON_FIELDS,
  contactKey,
  identityKey,
  taxKey,
  type Address,
  type Contact,
  type OrganizationParty,
  type Party,
  type PartyKind,
  type PartyRelationship,
  type Person,
  type PossibleDuplicate,
} from '#core/party/domain/party'
export { partyServices } from '#core/party/presentation/composition'
export { LucidPartyStore } from '#core/party/infrastructure/lucid_party'
export type { PartyStore } from '#core/party/application/ports'
