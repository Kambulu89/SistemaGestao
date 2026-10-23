import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)

/** O conteúdo das condições e das acções é validado pelo domínio e pelo motor de condições; aqui só o transporte. */
export const createRuleValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50),
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    priority: vine.number().withoutDecimals().optional(),
    conditionAst: vine.any(),
    actionAst: vine.any(),
    effectiveFrom: vine.string().trim().nullable().optional(),
    effectiveTo: vine.string().trim().nullable().optional(),
  })
)

export const updateRuleValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    priority: vine.number().withoutDecimals().optional(),
    conditionAst: vine.any().optional(),
    actionAst: vine.any().optional(),
    effectiveFrom: vine.string().trim().nullable().optional(),
    effectiveTo: vine.string().trim().nullable().optional(),
  })
)

export const versionOnlyValidator = vine.compile(vine.object({ expectedVersion: version() }))

export const simulateValidator = vine.compile(
  vine.object({ values: vine.any(), now: vine.string().trim().optional() })
)

export const listRulesValidator = vine.compile(
  vine.object({ entityCode: vine.string().trim().maxLength(50).optional() })
)
