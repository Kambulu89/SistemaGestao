import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)

/** O conteúdo (estados, transições, guardas) é validado pelo domínio; aqui só o transporte. */
export const createMachineValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50),
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    states: vine.any(),
    transitions: vine.any().optional(),
  })
)

export const updateMachineValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    states: vine.any().optional(),
    transitions: vine.any().optional(),
  })
)

export const versionOnlyValidator = vine.compile(vine.object({ expectedVersion: version() }))

export const listMachinesValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50).optional(),
    status: vine.enum(['DRAFT', 'PUBLISHED', 'RETIRED']).optional(),
  })
)

export const transitionValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    reason: vine.string().trim().maxLength(1000).nullable().optional(),
  })
)
