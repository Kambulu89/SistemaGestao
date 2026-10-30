import vine from '@vinejs/vine'

const page = {
  limit: vine.number().withoutDecimals().min(1).max(500).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

/** O resto da validação (campos, operadores, valores) é do domínio, que devolve erros por campo. */
export const looseObjectValidator = vine.compile(vine.object({}).allowUnknownProperties())

export const versionValidator = vine.compile(
  vine.object({ version: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)

export const runValidator = vine.compile(
  vine.object({
    filters: vine.array(vine.object({}).allowUnknownProperties()).maxLength(20).optional(),
    ...page,
  })
)

export const searchValidator = vine.compile(
  vine.object({
    q: vine.string().trim().minLength(1).maxLength(200),
    types: vine.string().trim().maxLength(200).optional(),
    limit: vine.number().withoutDecimals().min(1).max(20).optional(),
  })
)

export const dataValidator = vine.compile(
  vine.object({ filters: vine.string().trim().maxLength(4000).optional() })
)
