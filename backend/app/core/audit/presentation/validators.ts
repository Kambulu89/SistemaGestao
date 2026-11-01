import vine from '@vinejs/vine'

export const auditQueryValidator = vine.compile(
  vine.object({
    from: vine.date({ formats: ['iso8601'] }).optional(),
    to: vine.date({ formats: ['iso8601'] }).optional(),
    resourceType: vine.string().trim().maxLength(60).optional(),
    resourceId: vine.string().uuid().optional(),
    action: vine.string().trim().maxLength(100).optional(),
    actorMembershipId: vine.string().uuid().optional(),
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

export const pageValidator = vine.compile(
  vine.object({
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
