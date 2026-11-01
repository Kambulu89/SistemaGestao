import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)

/** O conteúdo (gatilho, condição, acções) é validado pelo domínio e pelo catálogo; aqui só o transporte. */
export const createAutomationValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    eventType: vine.string().trim().maxLength(100).nullable().optional(),
    schedule: vine.string().trim().maxLength(100).nullable().optional(),
    timezone: vine.string().trim().maxLength(64).optional(),
    condition: vine.any().optional(),
    actions: vine.any(),
    maxRunsPerPeriod: vine.any().optional(),
  })
)

export const updateAutomationValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    eventType: vine.string().trim().maxLength(100).nullable().optional(),
    schedule: vine.string().trim().maxLength(100).nullable().optional(),
    timezone: vine.string().trim().maxLength(64).optional(),
    condition: vine.any().optional(),
    actions: vine.any().optional(),
    maxRunsPerPeriod: vine.any().optional(),
  })
)

export const versionOnlyValidator = vine.compile(vine.object({ expectedVersion: version() }))

export const simulateValidator = vine.compile(
  vine.object({
    payload: vine.record(vine.any()).optional(),
    scheduledFor: vine.date({ formats: ['iso8601'] }).optional(),
  })
)

export const listRunsValidator = vine.compile(
  vine.object({
    automationId: vine.string().trim().uuid().optional(),
    status: vine.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD']).optional(),
  })
)
