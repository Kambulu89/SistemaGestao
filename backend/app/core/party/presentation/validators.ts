import vine from '@vinejs/vine'

const contact = vine.object({
  type: vine.enum(['EMAIL', 'PHONE', 'WEBSITE'] as const),
  value: vine.string().trim().maxLength(254),
  label: vine.string().trim().maxLength(60).nullable().optional(),
  isPrimary: vine.boolean().optional(),
})

const address = vine.object({
  type: vine.enum(['BILLING', 'DELIVERY', 'OTHER'] as const),
  line1: vine.string().trim().maxLength(200),
  line2: vine.string().trim().maxLength(200).nullable().optional(),
  city: vine.string().trim().maxLength(100),
  province: vine.string().trim().maxLength(100).nullable().optional(),
  countryCode: vine.string().trim().fixedLength(2),
  postalCode: vine.string().trim().maxLength(20).nullable().optional(),
  isPrimary: vine.boolean().optional(),
})

const nullableText = (max: number) => vine.string().trim().maxLength(max).nullable().optional()

export const createPersonValidator = vine.compile(
  vine.object({
    displayName: nullableText(200),
    externalReference: nullableText(100),
    givenNames: vine.string().trim().maxLength(120),
    familyName: vine.string().trim().maxLength(120),
    birthDate: nullableText(10),
    nationality: nullableText(2),
    identityType: nullableText(30),
    identityNumber: nullableText(60),
    contacts: vine.array(contact).maxLength(20).optional(),
    addresses: vine.array(address).maxLength(20).optional(),
  })
)

export const createOrganizationPartyValidator = vine.compile(
  vine.object({
    displayName: nullableText(200),
    externalReference: nullableText(100),
    legalName: vine.string().trim().maxLength(200),
    taxCountry: nullableText(2),
    taxId: nullableText(40),
    registrationNumber: nullableText(60),
    contacts: vine.array(contact).maxLength(20).optional(),
    addresses: vine.array(address).maxLength(20).optional(),
  })
)

export const updatePartyValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    displayName: vine.string().trim().maxLength(200).optional(),
    status: vine.enum(['ACTIVE', 'INACTIVE'] as const).optional(),
    externalReference: nullableText(100),
    person: vine
      .object({
        givenNames: vine.string().trim().maxLength(120).optional(),
        familyName: vine.string().trim().maxLength(120).optional(),
        birthDate: nullableText(10),
        nationality: nullableText(2),
        identityType: nullableText(30),
        identityNumber: nullableText(60),
      })
      .optional(),
    organization: vine
      .object({
        legalName: vine.string().trim().maxLength(200).optional(),
        taxCountry: nullableText(2),
        taxId: nullableText(40),
        registrationNumber: nullableText(60),
      })
      .optional(),
  })
)

export const listPartiesValidator = vine.compile(
  vine.object({
    kind: vine.enum(['PERSON', 'ORGANIZATION'] as const).optional(),
    status: vine.enum(['ACTIVE', 'INACTIVE'] as const).optional(),
    q: vine.string().trim().minLength(2).maxLength(100).optional(),
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

export const addContactValidator = vine.compile(contact)
export const updateContactValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    value: vine.string().trim().maxLength(254).optional(),
    label: vine.string().trim().maxLength(60).nullable().optional(),
    isPrimary: vine.boolean().optional(),
  })
)

export const addAddressValidator = vine.compile(address)
export const updateAddressValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    type: vine.enum(['BILLING', 'DELIVERY', 'OTHER'] as const).optional(),
    line1: vine.string().trim().maxLength(200).optional(),
    line2: vine.string().trim().maxLength(200).nullable().optional(),
    city: vine.string().trim().maxLength(100).optional(),
    province: vine.string().trim().maxLength(100).nullable().optional(),
    countryCode: vine.string().trim().fixedLength(2).optional(),
    postalCode: vine.string().trim().maxLength(20).nullable().optional(),
    isPrimary: vine.boolean().optional(),
  })
)

export const addRelationshipValidator = vine.compile(
  vine.object({
    targetPartyId: vine.string().uuid(),
    relationshipType: vine.string().trim().maxLength(50),
    startsOn: nullableText(10),
    endsOn: nullableText(10),
  })
)

export const linkPersonValidator = vine.compile(
  vine.object({ partyId: vine.string().uuid().nullable() })
)
