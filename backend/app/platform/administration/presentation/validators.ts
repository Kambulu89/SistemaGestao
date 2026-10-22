import vine from '@vinejs/vine'

export const provisionValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    adminEmail: vine.string().trim().maxLength(254),
    planCode: vine.string().trim().maxLength(60),
    planRevision: vine.number().withoutDecimals().min(1).optional(),
    trialDays: vine.number().withoutDecimals().optional(),
  })
)

export const reasonValidator = vine.compile(
  vine.object({ reason: vine.string().trim().minLength(3).maxLength(500) })
)

export const createPlanValidator = vine.compile(
  vine.object({
    planCode: vine.string().trim().maxLength(60),
    name: vine.string().trim().maxLength(160),
    currency: vine.string().trim().maxLength(3),
    price: vine.string().trim().maxLength(24),
    billingInterval: vine.string().trim().maxLength(5),
    limits: vine.any(),
    entitlements: vine.any().optional(),
  })
)

export const assignValidator = vine.compile(
  vine.object({
    planCode: vine.string().trim().maxLength(60),
    revision: vine.number().withoutDecimals().min(1).optional(),
    trialDays: vine.number().withoutDecimals().optional(),
  })
)

export const changePlanValidator = vine.compile(
  vine.object({
    planCode: vine.string().trim().maxLength(60),
    revision: vine.number().withoutDecimals().min(1).optional(),
    adequacyDays: vine.number().withoutDecimals().optional(),
  })
)

export const statusValidator = vine.compile(
  vine.object({
    status: vine.enum(['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const),
    graceDays: vine.number().withoutDecimals().optional(),
  })
)
