import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

/** O conteúdo (quantidades, estados, regras) é validado pelo domínio; aqui só o transporte. */
export const reasonValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)

// --- transferências ----------------------------------------------------------------------------------

const transferLine = vine.object({
  variantId: uuid(),
  quantity: vine.string().trim().maxLength(30),
  lotId: uuid().nullable().optional(),
  sourceLocationId: uuid().nullable().optional(),
  destinationLocationId: uuid().nullable().optional(),
})

export const listTransfersValidator = vine.compile(
  vine.object({
    status: vine
      .enum(['DRAFT', 'DISPATCHED', 'PARTIAL_RECEIVED', 'RECEIVED', 'CANCELLED'])
      .optional(),
    warehouseId: uuid().optional(),
    ...page,
  })
)
export const createTransferValidator = vine.compile(
  vine.object({
    sourceWarehouseId: uuid(),
    destinationWarehouseId: uuid(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    lines: vine.array(transferLine).maxLength(200).optional(),
  })
)
export const updateTransferValidator = vine.compile(
  vine.object({ expectedVersion: version(), notes: vine.string().maxLength(1000).nullable() })
)
export const transferLineValidator = vine.compile(transferLine)
export const receiveTransferValidator = vine.compile(
  vine.object({
    lines: vine
      .array(vine.object({ lineId: uuid(), quantity: vine.string().trim().maxLength(30) }))
      .minLength(1)
      .maxLength(200),
  })
)

// --- contagens ---------------------------------------------------------------------------------------

export const listCountsValidator = vine.compile(
  vine.object({
    status: vine.enum(['DRAFT', 'OPEN', 'REVIEW', 'POSTED', 'CANCELLED']).optional(),
    warehouseId: uuid().optional(),
    ...page,
  })
)
export const createCountValidator = vine.compile(
  vine.object({
    warehouseId: uuid(),
    locationIds: vine.array(uuid()).maxLength(500).optional(),
    blind: vine.boolean().optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)
export const countLinesValidator = vine.compile(
  vine.object({
    lines: vine
      .array(
        vine.object({
          lineId: uuid(),
          countedQty: vine.string().trim().maxLength(30),
          reason: vine.string().maxLength(300).nullable().optional(),
        })
      )
      .minLength(1)
      .maxLength(1000),
  })
)
export const countExtraLineValidator = vine.compile(
  vine.object({ variantId: uuid(), locationId: uuid(), lotId: uuid().nullable().optional() })
)

// --- devoluções --------------------------------------------------------------------------------------

const returnLine = vine.object({
  sourceLineId: uuid(),
  quantity: vine.string().trim().maxLength(30),
  condition: vine.string().trim().maxLength(12).optional(),
  lotId: uuid().nullable().optional(),
  locationId: uuid().nullable().optional(),
})
export const listReturnsValidator = vine.compile(
  vine.object({
    direction: vine.enum(['CUSTOMER', 'SUPPLIER']).optional(),
    status: vine.enum(['DRAFT', 'APPROVED', 'POSTED']).optional(),
    ...page,
  })
)
export const returnSourceValidator = vine.compile(
  vine.object({ direction: vine.enum(['CUSTOMER', 'SUPPLIER']), sourceDocumentId: uuid() })
)
export const createReturnValidator = vine.compile(
  vine.object({
    direction: vine.string().trim().maxLength(10),
    sourceDocumentId: uuid(),
    warehouseId: uuid(),
    reason: vine.string().trim().maxLength(300),
    lines: vine.array(returnLine).maxLength(200).optional(),
  })
)
export const returnLineValidator = vine.compile(returnLine)
