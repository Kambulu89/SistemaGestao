import vine from '@vinejs/vine'

const page = {
  limit: vine.number().withoutDecimals().min(1).max(100).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

export const listDocumentsValidator = vine.compile(
  vine.object({
    search: vine.string().trim().maxLength(100).optional(),
    categoryCode: vine.string().trim().maxLength(50).optional(),
    resourceType: vine.string().trim().maxLength(40).optional(),
    resourceId: vine.string().trim().uuid().optional(),
    ...page,
  })
)

/** O resto da validação (tipos, tamanhos, visibilidade) é do domínio, que devolve erros por campo. */
const loose = vine.object({}).allowUnknownProperties()
export const looseObjectValidator = vine.compile(loose)

export const versionValidator = vine.compile(
  vine.object({ version: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)

export const listResourceAttachmentsValidator = vine.compile(
  vine.object({
    resourceType: vine.string().trim().maxLength(40),
    resourceId: vine.string().trim().uuid(),
  })
)
