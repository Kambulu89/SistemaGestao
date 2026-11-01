import vine from '@vinejs/vine'

/** O resto da validação (códigos, datas, linhas, montantes) é do domínio, que devolve erros por campo. */
export const looseObjectValidator = vine.compile(vine.object({}).allowUnknownProperties())

export const versionValidator = vine.compile(
  vine.object({ version: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)

export const organizationQueryValidator = vine.compile(
  vine.object({ organizationId: vine.string().trim().uuid().optional() })
)

export const rangeQueryValidator = vine.compile(
  vine.object({
    organizationId: vine.string().trim().uuid().optional(),
    accountId: vine.string().trim().uuid().optional(),
    from: vine.string().trim().maxLength(10),
    to: vine.string().trim().maxLength(10),
  })
)

export const entriesQueryValidator = vine.compile(
  vine.object({
    organizationId: vine.string().trim().uuid().optional(),
    journalId: vine.string().trim().uuid().optional(),
    status: vine.string().trim().maxLength(10).optional(),
    from: vine.string().trim().maxLength(10).optional(),
    to: vine.string().trim().maxLength(10).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
