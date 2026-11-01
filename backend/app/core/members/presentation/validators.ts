import vine from '@vinejs/vine'

export const createInvitationValidator = vine.compile(
  vine.object({
    email: vine.string().trim().maxLength(254),
    roleIds: vine.array(vine.string().uuid()).maxLength(50).optional(),
    unitIds: vine.array(vine.string().uuid()).maxLength(50).optional(),
    expiresInDays: vine.number().withoutDecimals().optional(),
  })
)

export const acceptInvitationValidator = vine.compile(
  vine.object({ token: vine.string().minLength(20).maxLength(300) })
)

export const changeMemberStatusValidator = vine.compile(
  vine.object({
    status: vine.enum(['ACTIVE', 'SUSPENDED', 'LEFT'] as const),
    expectedVersion: vine.number().withoutDecimals().min(1),
  })
)

export const preferenceValueValidator = vine.compile(vine.object({ value: vine.any() }))

export const defaultOrganizationValidator = vine.compile(
  vine.object({ organizationId: vine.string().uuid().nullable() })
)
