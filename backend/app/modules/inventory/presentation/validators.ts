import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

/** O conteúdo (códigos, decimais, regras) é validado pelo domínio; aqui só o transporte. */
export const listWarehousesValidator = vine.compile(
  vine.object({ organizationId: uuid().optional() })
)

export const createWarehouseValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    code: vine.string().trim().maxLength(40),
    name: vine.string().trim().maxLength(160),
    allowNegative: vine.boolean().optional(),
    allowBackorder: vine.boolean().optional(),
  })
)

export const updateWarehouseValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    allowNegative: vine.boolean().optional(),
    allowBackorder: vine.boolean().optional(),
    salesDefault: vine.boolean().optional(),
    active: vine.boolean().optional(),
  })
)

export const createLocationValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(40),
    name: vine.string().trim().maxLength(160),
  })
)

export const updateLocationValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    active: vine.boolean().optional(),
  })
)

export const listLotsValidator = vine.compile(vine.object({ variantId: uuid().optional() }))

export const createLotValidator = vine.compile(
  vine.object({
    variantId: uuid(),
    code: vine.string().trim().maxLength(60),
    manufacturedOn: vine.string().trim().maxLength(10).nullable().optional(),
    expiresOn: vine.string().trim().maxLength(10).nullable().optional(),
  })
)

export const listBalancesValidator = vine.compile(
  vine.object({
    variantId: uuid().optional(),
    warehouseId: uuid().optional(),
    locationId: uuid().optional(),
    lotId: uuid().optional(),
    nonZero: vine.boolean().optional(),
    ...page,
  })
)

export const listMovementsValidator = vine.compile(
  vine.object({
    variantId: uuid().optional(),
    locationId: uuid().optional(),
    sourceType: vine.string().trim().maxLength(40).optional(),
    sourceId: uuid().optional(),
    ...page,
  })
)

export const adjustmentValidator = vine.compile(
  vine.object({
    variantId: uuid(),
    locationId: uuid(),
    lotId: uuid().nullable().optional(),
    quantityDelta: vine.string().trim().maxLength(30),
    unitCost: vine.string().trim().maxLength(30).nullable().optional(),
    reason: vine.string().trim().maxLength(300),
    reference: uuid().nullable().optional(),
  })
)

export const reverseValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)

export const listReservationsValidator = vine.compile(
  vine.object({
    variantId: uuid().optional(),
    sourceType: vine.string().trim().maxLength(40).optional(),
    sourceId: uuid().optional(),
    status: vine.enum(['ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED']).optional(),
    ...page,
  })
)

export const createReservationValidator = vine.compile(
  vine.object({
    variantId: uuid(),
    locationId: uuid(),
    lotId: uuid().nullable().optional(),
    quantity: vine.string().trim().maxLength(30),
    sourceType: vine.string().trim().maxLength(40),
    sourceId: uuid(),
    sourceLineId: uuid().nullable().optional(),
    expiresAt: vine.date({ formats: ['iso8601'] }).optional(),
  })
)

export const releaseReservationValidator = vine.compile(
  vine.object({ quantity: vine.string().trim().maxLength(30).optional() })
)
