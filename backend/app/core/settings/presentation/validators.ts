import vine from '@vinejs/vine'

const uuid = () => vine.string().uuid()
const version = () => vine.number().withoutDecimals().min(1)
const date = () =>
  vine
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)

export const effectiveQueryValidator = vine.compile(
  vine.object({
    organizationId: uuid().optional(),
    branchId: uuid().optional(),
    moduleCode: vine.string().trim().maxLength(50).optional(),
  })
)

export const settingsListValidator = vine.compile(
  vine.object({
    key: vine.string().trim().maxLength(100).optional(),
    scopeType: vine
      .enum(['TENANT', 'ORGANIZATION', 'BRANCH', 'MODULE', 'MEMBERSHIP'] as const)
      .optional(),
  })
)

export const setSettingValidator = vine.compile(
  vine.object({
    scopeType: vine.enum(['TENANT', 'ORGANIZATION', 'BRANCH', 'MODULE'] as const),
    scopeId: uuid().nullable().optional(),
    moduleCode: vine.string().trim().maxLength(50).nullable().optional(),
    value: vine.any(),
    expectedVersion: version().optional(),
  })
)

export const resetSettingValidator = vine.compile(
  vine.object({
    scopeType: vine.enum(['TENANT', 'ORGANIZATION', 'BRANCH', 'MODULE'] as const),
    scopeId: uuid().optional(),
    moduleCode: vine.string().trim().maxLength(50).optional(),
  })
)

export const personalValueValidator = vine.compile(
  vine.object({ value: vine.any(), expectedVersion: version().optional() })
)

export const taxListValidator = vine.compile(
  vine.object({
    organizationId: uuid().optional(),
    code: vine.string().trim().maxLength(40).optional(),
    on: date().optional(),
  })
)

export const createTaxRateValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    code: vine.string().trim().maxLength(40),
    name: vine.string().trim().maxLength(160),
    rate: vine.string().trim().maxLength(12),
    validFrom: date(),
    validTo: date().nullable().optional(),
    category: vine.string().trim().maxLength(50),
    exemptionReason: vine.string().trim().maxLength(250).nullable().optional(),
  })
)

export const updateTaxRateValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    validTo: date().nullable().optional(),
    category: vine.string().trim().maxLength(50).optional(),
    exemptionReason: vine.string().trim().maxLength(250).nullable().optional(),
  })
)

export const createUnitValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(20),
    name: vine.string().trim().maxLength(120),
    dimension: vine.string().trim().maxLength(30),
    precision: vine.number().withoutDecimals(),
    baseUnitId: uuid().nullable().optional(),
    conversionFactor: vine.string().trim().maxLength(24).nullable().optional(),
  })
)

export const updateUnitValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(120).optional(),
    precision: vine.number().withoutDecimals().optional(),
  })
)

export const convertValidator = vine.compile(
  vine.object({
    from: vine.string().trim().maxLength(20),
    to: vine.string().trim().maxLength(20),
    quantity: vine.string().trim().maxLength(24),
  })
)

export const sequenceListValidator = vine.compile(
  vine.object({
    organizationId: uuid().optional(),
    documentType: vine.string().trim().maxLength(50).optional(),
  })
)

export const createSequenceValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    branchId: uuid().nullable().optional(),
    documentType: vine.string().trim().maxLength(50),
    series: vine.string().trim().maxLength(30),
    period: vine.string().trim().maxLength(20).optional(),
    prefixTemplate: vine.string().maxLength(120),
    nextValue: vine.string().trim().maxLength(20).optional(),
    padding: vine.number().withoutDecimals().optional(),
  })
)

export const updateSequenceValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    prefixTemplate: vine.string().maxLength(120).optional(),
    padding: vine.number().withoutDecimals().optional(),
    nextValue: vine.string().trim().maxLength(20).optional(),
  })
)

export const previewSequenceValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    branchId: uuid().nullable().optional(),
    series: vine.string().trim().maxLength(30),
    prefixTemplate: vine.string().maxLength(120),
    padding: vine.number().withoutDecimals().optional(),
    nextValue: vine.string().trim().maxLength(20).optional(),
    date: vine.date({ formats: ['iso8601'] }).optional(),
  })
)
