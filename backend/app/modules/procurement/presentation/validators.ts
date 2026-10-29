import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

/** O conteúdo (datas, decimais, regras) é validado pelo domínio; aqui só o transporte. */
export const listSuppliersValidator = vine.compile(
  vine.object({
    q: vine.string().trim().maxLength(60).optional(),
    status: vine.enum(['ACTIVE', 'BLOCKED', 'INACTIVE']).optional(),
    organizationId: uuid().optional(),
    ...page,
  })
)

const supplierBody = {
  paymentTermDays: vine.number().optional(),
  currency: vine.string().trim().maxLength(3).optional(),
  status: vine.string().trim().maxLength(10).optional(),
  statusReason: vine.string().maxLength(300).nullable().optional(),
}

export const createSupplierValidator = vine.compile(
  vine.object({
    partyId: uuid(),
    organizationId: uuid(),
    code: vine.string().trim().maxLength(50),
    ...supplierBody,
  })
)

export const updateSupplierValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    // Presentes só para o domínio os recusar com uma mensagem clara (imutáveis).
    partyId: vine.string().trim().optional(),
    organizationId: vine.string().trim().optional(),
    code: vine.string().trim().optional(),
    ...supplierBody,
  })
)

const requisitionLine = vine.object({
  variantId: uuid(),
  quantity: vine.string().trim().maxLength(30),
})

export const listRequisitionsValidator = vine.compile(
  vine.object({
    status: vine.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED']).optional(),
    requestedByMembershipId: uuid().optional(),
    ...page,
  })
)

export const createRequisitionValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    neededOn: vine.string().trim().maxLength(10).nullable().optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    lines: vine.array(requisitionLine).maxLength(100).optional(),
  })
)

export const updateRequisitionValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    neededOn: vine.string().trim().maxLength(10).nullable().optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)

export const requisitionLineValidator = vine.compile(requisitionLine)

export const reasonValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)

export const optionalReasonValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300).optional() })
)

const purchaseLine = vine.object({
  variantId: uuid(),
  quantity: vine.string().trim().maxLength(30),
  unitCost: vine.string().trim().maxLength(30),
  taxRate: vine.string().trim().maxLength(12).optional(),
})

export const listPurchasesValidator = vine.compile(
  vine.object({
    supplierId: uuid().optional(),
    status: vine.enum(['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED']).optional(),
    q: vine.string().trim().maxLength(60).optional(),
    ...page,
  })
)

export const createPurchaseValidator = vine.compile(
  vine.object({
    supplierId: uuid(),
    organizationId: uuid().optional(),
    orderDate: vine.string().trim().maxLength(10).optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    lines: vine.array(purchaseLine).maxLength(100).optional(),
  })
)

export const updatePurchaseValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    orderDate: vine.string().trim().maxLength(10).optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)

export const purchaseLineValidator = vine.compile(purchaseLine)

/** A requisição não leva preços: o pedido traz o custo (e a taxa) de cada variante; a quantidade vem da requisição. */
export const convertRequisitionValidator = vine.compile(
  vine.object({
    supplierId: uuid(),
    lines: vine
      .array(
        vine.object({
          variantId: uuid(),
          unitCost: vine.string().trim().maxLength(30),
          taxRate: vine.string().trim().maxLength(12).optional(),
          quantity: vine.string().trim().maxLength(30).optional(),
        })
      )
      .maxLength(100)
      .optional(),
  })
)

const receiptLine = vine.object({
  purchaseLineId: uuid(),
  quantity: vine.string().trim().maxLength(30),
  lotCode: vine.string().trim().maxLength(60).nullable().optional(),
  expiresOn: vine.string().trim().maxLength(10).nullable().optional(),
})

export const listReceiptsValidator = vine.compile(
  vine.object({
    purchaseOrderId: uuid().optional(),
    status: vine.enum(['DRAFT', 'POSTED', 'REVERSED']).optional(),
    ...page,
  })
)

export const createReceiptValidator = vine.compile(
  vine.object({
    purchaseOrderId: uuid(),
    warehouseId: uuid().nullable().optional(),
    supplierDocument: vine.string().maxLength(100).nullable().optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    lines: vine.array(receiptLine).maxLength(100).optional(),
  })
)

export const updateReceiptValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    warehouseId: uuid().nullable().optional(),
    supplierDocument: vine.string().maxLength(100).nullable().optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)

export const receiptLineValidator = vine.compile(receiptLine)
