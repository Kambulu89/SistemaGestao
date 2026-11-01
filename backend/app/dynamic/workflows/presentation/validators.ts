import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()

/** O conteúdo (etapas, responsáveis, condições) é validado pelo domínio; aqui só o transporte. */
export const createWorkflowValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50),
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    graph: vine.any(),
  })
)

export const updateWorkflowValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    graph: vine.any().optional(),
  })
)

export const versionOnlyValidator = vine.compile(vine.object({ expectedVersion: version() }))

export const listWorkflowsValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50).optional(),
    status: vine.enum(['DRAFT', 'PUBLISHED', 'RETIRED']).optional(),
  })
)

export const submitValidator = vine.compile(
  vine.object({
    entityCode: vine.string().trim().maxLength(50),
    workflowCode: vine.string().trim().maxLength(50),
    recordId: uuid(),
  })
)

export const listInstancesValidator = vine.compile(
  vine.object({
    status: vine
      .enum(['RUNNING', 'WAITING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED'])
      .optional(),
    entityCode: vine.string().trim().maxLength(50).optional(),
    mine: vine.boolean().optional(),
  })
)

export const inboxValidator = vine.compile(
  vine.object({ view: vine.enum(['pending', 'decided']).optional() })
)

export const decisionValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(2000).nullable().optional() })
)

export const createDelegationValidator = vine.compile(
  vine.object({
    toMembershipId: uuid(),
    validFrom: vine.date({ formats: ['iso8601'] }).optional(),
    validUntil: vine.date({ formats: ['iso8601'] }),
    scope: vine.any().optional(),
    maxAmount: vine.string().trim().maxLength(30).nullable().optional(),
    currency: vine.string().trim().maxLength(3).nullable().optional(),
    reason: vine.string().trim().maxLength(500),
  })
)
