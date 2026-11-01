import vine from '@vinejs/vine'

export const enableValidator = vine.compile(
  vine.object({ withDependencies: vine.boolean().optional() })
)

export const featureOverrideValidator = vine.compile(
  vine.object({
    override: vine.boolean().nullable(),
    reason: vine.string().trim().maxLength(500).nullable().optional(),
    expiresAt: vine
      .date({ formats: ['iso8601'] })
      .nullable()
      .optional(),
  })
)
