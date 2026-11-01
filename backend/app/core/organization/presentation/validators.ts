import vine from '@vinejs/vine'

const uuid = () => vine.string().uuid()

export const createOrganizationValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(40),
    legalName: vine.string().trim().maxLength(200),
    tradeName: vine.string().trim().maxLength(160).nullable().optional(),
    countryCode: vine.string().trim().fixedLength(2),
    taxId: vine.string().trim().maxLength(40).nullable().optional(),
    baseCurrency: vine.string().trim().fixedLength(3),
    fiscalYearStartMonth: vine.number().withoutDecimals().optional(),
    addressId: uuid().nullable().optional(),
    active: vine.boolean().optional(),
  })
)

export const updateOrganizationValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    legalName: vine.string().trim().maxLength(200).optional(),
    tradeName: vine.string().trim().maxLength(160).nullable().optional(),
    countryCode: vine.string().trim().fixedLength(2).optional(),
    taxId: vine.string().trim().maxLength(40).nullable().optional(),
    baseCurrency: vine.string().trim().fixedLength(3).optional(),
    fiscalYearStartMonth: vine.number().withoutDecimals().optional(),
    addressId: uuid().nullable().optional(),
    active: vine.boolean().optional(),
  })
)

const unitType = vine.enum(['BRANCH', 'DEPARTMENT', 'SECTION', 'TEAM', 'OTHER'] as const)

export const createUnitValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    parentId: uuid().nullable().optional(),
    code: vine.string().trim().maxLength(40),
    name: vine.string().trim().maxLength(160),
    type: unitType.optional(),
    managerMembershipId: uuid().nullable().optional(),
    timezone: vine.string().trim().maxLength(64).nullable().optional(),
  })
)

export const updateUnitValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    parentId: uuid().nullable().optional(),
    name: vine.string().trim().maxLength(160).optional(),
    type: unitType.optional(),
    managerMembershipId: uuid().nullable().optional(),
    timezone: vine.string().trim().maxLength(64).nullable().optional(),
    active: vine.boolean().optional(),
  })
)

export const createCostCenterValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    parentId: uuid().nullable().optional(),
    code: vine.string().trim().maxLength(40),
    name: vine.string().trim().maxLength(160),
    responsibleMembershipId: uuid().nullable().optional(),
  })
)

export const updateCostCenterValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    parentId: uuid().nullable().optional(),
    name: vine.string().trim().maxLength(160).optional(),
    responsibleMembershipId: uuid().nullable().optional(),
    active: vine.boolean().optional(),
  })
)

export const addTeamMemberValidator = vine.compile(
  vine.object({
    membershipId: uuid(),
    startsOn: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endsOn: vine
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    roleLabel: vine.string().trim().maxLength(80).nullable().optional(),
  })
)

export const addScopeValidator = vine.compile(
  vine.object({
    membershipId: uuid(),
    organizationId: uuid(),
    organizationUnitId: uuid().nullable().optional(),
    includeDescendants: vine.boolean().optional(),
  })
)

export const listFilterValidator = vine.compile(
  vine.object({
    organizationId: uuid().optional(),
    membershipId: uuid().optional(),
  })
)

const positionFields = {
  name: vine.string().trim().maxLength(160).optional(),
  description: vine.string().trim().maxLength(4000).nullable().optional(),
  jobFamily: vine.string().trim().maxLength(80).nullable().optional(),
  category: vine.string().trim().maxLength(80).nullable().optional(),
  hierarchyLevel: vine.number().withoutDecimals().nullable().optional(),
  departmentId: vine.string().uuid().nullable().optional(),
  parentId: vine.string().uuid().nullable().optional(),
  responsibilities: vine.string().trim().maxLength(4000).nullable().optional(),
  competencies: vine.array(vine.string().trim().maxLength(120)).maxLength(60).optional(),
  academicRequirements: vine.string().trim().maxLength(1000).nullable().optional(),
  recommendedExperience: vine.string().trim().maxLength(200).nullable().optional(),
  status: vine.enum(['ACTIVE', 'INACTIVE'] as const).optional(),
}

export const createPositionValidator = vine.compile(
  vine.object({ code: vine.string().trim().maxLength(40), ...positionFields })
)

export const updatePositionValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    // Aceite só para o caso de uso o recusar com 422 (o código é imutável), em vez de o ignorar em silêncio.
    code: vine.string().optional(),
    ...positionFields,
  })
)

export const listPositionsValidator = vine.compile(
  vine.object({
    departmentId: vine.string().uuid().optional(),
    status: vine.enum(['ACTIVE', 'INACTIVE'] as const).optional(),
    q: vine.string().trim().maxLength(80).optional(),
    limit: vine.number().withoutDecimals().range([1, 200]).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
