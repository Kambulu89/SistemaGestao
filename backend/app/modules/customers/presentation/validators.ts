import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()

/** O conteúdo (códigos, dinheiro, regras) é validado pelo domínio; aqui só o transporte. */
export const createSegmentValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    description: vine.string().trim().maxLength(500).nullable().optional(),
  })
)

export const updateSegmentValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    description: vine.string().trim().maxLength(500).nullable().optional(),
    active: vine.boolean().optional(),
  })
)

export const listCustomersValidator = vine.compile(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    segmentId: uuid().optional(),
    accountManagerMembershipId: uuid().optional(),
    organizationId: uuid().optional(),
    partyId: uuid().optional(),
    status: vine.enum(['ACTIVE', 'BLOCKED', 'INACTIVE']).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

export const createCustomerValidator = vine.compile(
  vine.object({
    partyId: uuid(),
    organizationId: uuid(),
    code: vine.string().trim().maxLength(50),
    segmentId: uuid().nullable().optional(),
    accountManagerMembershipId: uuid().nullable().optional(),
    paymentTermDays: vine.number().withoutDecimals().optional(),
    creditLimit: vine.string().trim().maxLength(30).optional(),
    currency: vine.string().trim().maxLength(3).optional(),
    status: vine.string().trim().optional(),
  })
)

export const updateCustomerValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    segmentId: uuid().nullable().optional(),
    accountManagerMembershipId: uuid().nullable().optional(),
    paymentTermDays: vine.number().withoutDecimals().optional(),
    creditLimit: vine.string().trim().maxLength(30).optional(),
    currency: vine.string().trim().maxLength(3).optional(),
    status: vine.string().trim().optional(),
    // Presentes só para o domínio os recusar com uma mensagem clara (imutáveis).
    partyId: vine.string().trim().optional(),
    organizationId: vine.string().trim().optional(),
    code: vine.string().trim().optional(),
  })
)

export const blockCustomerValidator = vine.compile(
  vine.object({ expectedVersion: version(), reason: vine.string().trim().maxLength(300) })
)

export const unblockCustomerValidator = vine.compile(vine.object({ expectedVersion: version() }))

export const listInteractionsValidator = vine.compile(
  vine.object({
    partyId: uuid().optional(),
    ownerMembershipId: uuid().optional(),
    followUpBefore: vine.string().trim().maxLength(40).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

export const createInteractionValidator = vine.compile(
  vine.object({
    partyId: uuid(),
    channel: vine.string().trim(),
    subject: vine.string().trim().maxLength(200),
    occurredAt: vine.string().trim().maxLength(40).optional(),
    summary: vine.string().maxLength(5000).optional(),
    followUpAt: vine.string().trim().maxLength(40).nullable().optional(),
  })
)

export const updateInteractionValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    channel: vine.string().trim().optional(),
    subject: vine.string().trim().maxLength(200).optional(),
    occurredAt: vine.string().trim().maxLength(40).optional(),
    summary: vine.string().maxLength(5000).optional(),
    followUpAt: vine.string().trim().maxLength(40).nullable().optional(),
    partyId: vine.string().trim().optional(),
  })
)
