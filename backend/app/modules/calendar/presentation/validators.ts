import vine from '@vinejs/vine'

/** O resto da validação (campos, fusos, regras, intervalos) é do domínio, que devolve erros por campo. */
export const looseObjectValidator = vine.compile(vine.object({}).allowUnknownProperties())

export const versionValidator = vine.compile(
  vine.object({ version: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)

export const rangeValidator = vine.compile(
  vine.object({
    from: vine.string().trim().maxLength(40),
    to: vine.string().trim().maxLength(40),
    calendarId: vine.string().trim().uuid().optional(),
    resourceId: vine.string().trim().uuid().optional(),
    eventId: vine.string().trim().uuid().optional(),
  })
)
