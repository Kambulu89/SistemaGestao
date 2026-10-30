import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()

/** O conteúdo (datas, moeda, decimais, regras) é validado pelo domínio; aqui só o transporte. */
export const listDocumentsValidator = vine.compile(
  vine.object({
    customerId: uuid().optional(),
    organizationId: uuid().optional(),
    status: vine.string().trim().maxLength(20).optional(),
    q: vine.string().trim().maxLength(60).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

export const createQuoteValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    customerId: uuid(),
    validUntil: vine.string().trim().maxLength(10),
    currency: vine.string().trim().maxLength(3).optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)

export const updateQuoteValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    validUntil: vine.string().trim().maxLength(10).optional(),
    currency: vine.string().trim().maxLength(3).optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    // Presentes só para o domínio os recusar com uma mensagem clara (imutáveis).
    organizationId: vine.string().trim().optional(),
    customerId: vine.string().trim().optional(),
  })
)

export const createOrderValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    customerId: uuid(),
    orderDate: vine.string().trim().maxLength(10).optional(),
    currency: vine.string().trim().maxLength(3).optional(),
    deliveryAddress: vine.any().optional(),
  })
)

export const updateOrderValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    orderDate: vine.string().trim().maxLength(10).optional(),
    currency: vine.string().trim().maxLength(3).optional(),
    deliveryAddress: vine.any().optional(),
    organizationId: vine.string().trim().optional(),
    customerId: vine.string().trim().optional(),
  })
)

/** Quantidade e desconto chegam como texto e validam-se no domínio (nunca `number`). */
export const createLineValidator = vine.compile(
  vine.object({
    variantId: uuid(),
    quantity: vine.string().trim().maxLength(30),
    discountRate: vine.string().trim().maxLength(10).optional(),
  })
)

export const updateLineValidator = vine.compile(
  vine.object({
    quantity: vine.string().trim().maxLength(30).optional(),
    discountRate: vine.string().trim().maxLength(10).optional(),
    variantId: vine.string().trim().optional(),
  })
)

export const confirmOrderValidator = vine.compile(
  vine.object({ expectedVersion: version().optional() })
)

export const cancelOrderValidator = vine.compile(
  vine.object({
    reason: vine.string().trim().maxLength(300),
    expectedVersion: version().optional(),
  })
)

export const listShipmentsValidator = vine.compile(
  vine.object({
    orderId: uuid().optional(),
    status: vine.enum(['DRAFT', 'POSTED', 'REVERSED']).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

const shipmentLine = vine.object({
  orderLineId: uuid(),
  quantity: vine.string().trim().maxLength(30),
})

export const createShipmentValidator = vine.compile(
  vine.object({
    orderId: uuid(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    lines: vine.array(shipmentLine).maxLength(100).optional(),
  })
)

export const updateShipmentValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)

export const createShipmentLineValidator = vine.compile(shipmentLine)

export const updateShipmentLineValidator = vine.compile(
  vine.object({ quantity: vine.string().trim().maxLength(30) })
)

export const reverseShipmentValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)
