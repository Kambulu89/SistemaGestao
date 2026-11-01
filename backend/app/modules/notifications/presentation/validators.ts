import vine from '@vinejs/vine'

const uuid = () => vine.string().trim().uuid()
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

export const listNotificationsValidator = vine.compile(
  vine.object({ unread: vine.boolean().optional(), ...page })
)

export const updatePreferencesValidator = vine.compile(
  vine.object({
    preferences: vine
      .array(
        vine.object({
          typeCode: vine.string().trim().maxLength(80),
          channel: vine.string().trim().maxLength(10),
          enabled: vine.boolean(),
          quietHours: vine
            .object({
              start: vine.string().trim().maxLength(5),
              end: vine.string().trim().maxLength(5),
              utcOffsetMinutes: vine.number().withoutDecimals().optional(),
            })
            .nullable()
            .optional(),
        })
      )
      .minLength(1)
      .maxLength(100),
  })
)

export const listDeliveriesValidator = vine.compile(
  vine.object({
    status: vine.enum(['QUEUED', 'SENT', 'DELIVERED', 'FAILED']).optional(),
    channel: vine.enum(['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH']).optional(),
    ...page,
  })
)

export const manualRequestValidator = vine.compile(
  vine.object({
    typeCode: vine.string().trim().maxLength(80),
    recipientMembershipIds: vine.array(uuid()).minLength(1).maxLength(200),
    title: vine.string().trim().maxLength(200),
    body: vine.string().trim().maxLength(4000),
    dedupeKey: vine.string().trim().maxLength(120).optional(),
  })
)
