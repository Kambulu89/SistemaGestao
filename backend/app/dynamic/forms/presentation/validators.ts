import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)

/** O conteúdo (secções, condições, modos) é validado pelo domínio; aqui só o transporte. */
export const createFormValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50),
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    modes: vine.any().optional(),
    isDefault: vine.boolean().optional(),
    sections: vine.any(),
  })
)

export const updateFormValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    modes: vine.any().optional(),
    isDefault: vine.boolean().optional(),
    sections: vine.any().optional(),
  })
)

export const versionOnlyValidator = vine.compile(vine.object({ expectedVersion: version() }))

export const listFormsValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50).optional(),
    status: vine.enum(['DRAFT', 'PUBLISHED', 'RETIRED']).optional(),
  })
)
