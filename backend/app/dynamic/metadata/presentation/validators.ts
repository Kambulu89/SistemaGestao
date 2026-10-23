import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)

/** O corpo `fields` e `data` é validado pelo domínio (o motor conhece os tipos); aqui só o transporte. */
export const createEntityValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    kind: vine.enum(['DYNAMIC'] as const).optional(),
    ownershipMode: vine.enum(['TENANT', 'UNIT', 'OWNER'] as const).optional(),
    presentation: vine.any().optional(),
    fields: vine.any().optional(),
  })
)

export const updateEntityValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    ownershipMode: vine.enum(['TENANT', 'UNIT', 'OWNER'] as const).optional(),
    presentation: vine.any().optional(),
  })
)

export const saveDraftValidator = vine.compile(
  vine.object({ expectedVersion: version(), fields: vine.any() })
)

export const versionOnlyValidator = vine.compile(vine.object({ expectedVersion: version() }))

export const createRecordValidator = vine.compile(
  vine.object({
    data: vine.any(),
    organizationUnitId: vine.string().uuid().nullable().optional(),
  })
)

export const updateRecordValidator = vine.compile(
  vine.object({ data: vine.any(), expectedVersion: version() })
)

export const listRecordsValidator = vine.compile(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    archived: vine.boolean().optional(),
    sort: vine.string().trim().maxLength(80).optional(),
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
