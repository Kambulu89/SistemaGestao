import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

/** O conteúdo (datas, decimais, regras) é validado pelo domínio; aqui só o transporte. */
export const listAccountsValidator = vine.compile(
  vine.object({
    organizationId: uuid().optional(),
    active: vine.boolean().optional(),
    ...page,
  })
)

export const pageValidator = vine.compile(vine.object({ ...page }))

const accountBody = {
  name: vine.string().trim().maxLength(160).optional(),
  bankName: vine.string().maxLength(160).nullable().optional(),
  accountIdentifier: vine.string().maxLength(100).nullable().optional(),
  active: vine.boolean().optional(),
}

export const createAccountValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    code: vine.string().trim().maxLength(50),
    type: vine.string().trim().maxLength(10),
    currency: vine.string().trim().maxLength(3).optional(),
    ...accountBody,
    name: vine.string().trim().maxLength(160),
  })
)

export const updateAccountValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    // Presentes só para o domínio os recusar com uma mensagem clara (imutáveis).
    organizationId: vine.string().trim().optional(),
    code: vine.string().trim().optional(),
    type: vine.string().trim().optional(),
    currency: vine.string().trim().optional(),
    ...accountBody,
  })
)

export const listObligationsValidator = vine.compile(
  vine.object({
    partyId: uuid().optional(),
    organizationId: uuid().optional(),
    view: vine.enum(['OPEN', 'PARTIAL', 'OVERDUE', 'CLOSED', 'CANCELLED']).optional(),
    dueBefore: vine.string().trim().maxLength(10).optional(),
    ...page,
  })
)

export const listPaymentsValidator = vine.compile(
  vine.object({
    direction: vine.enum(['INBOUND', 'OUTBOUND']).optional(),
    status: vine.enum(['DRAFT', 'PENDING', 'CONFIRMED', 'FAILED', 'REVERSED']).optional(),
    partyId: uuid().optional(),
    treasuryAccountId: uuid().optional(),
    ...page,
  })
)

export const createPaymentValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    direction: vine.string().trim().maxLength(10),
    partyId: uuid(),
    treasuryAccountId: uuid(),
    amount: vine.string().trim().maxLength(30),
    method: vine.string().trim().maxLength(10).optional(),
    occurredOn: vine.string().trim().maxLength(10).optional(),
    reference: vine.string().maxLength(160).nullable().optional(),
    allocations: vine
      .array(
        vine.object({
          receivableId: uuid().optional(),
          payableId: uuid().optional(),
          amount: vine.string().trim().maxLength(30),
        })
      )
      .maxLength(100),
  })
)

export const reasonValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)

export const listSupplierInvoicesValidator = vine.compile(
  vine.object({
    supplierId: uuid().optional(),
    status: vine.enum(['DRAFT', 'VALIDATED', 'DISPUTED', 'VOID']).optional(),
    q: vine.string().trim().maxLength(60).optional(),
    ...page,
  })
)

const invoiceLine = vine.object({
  purchaseLineId: uuid().nullable().optional(),
  description: vine.string().trim().maxLength(500),
  quantity: vine.string().trim().maxLength(30),
  unitPrice: vine.string().trim().maxLength(30),
  taxRate: vine.string().trim().maxLength(12).optional(),
})

export const supplierInvoiceLineValidator = vine.compile(invoiceLine)

export const createSupplierInvoiceValidator = vine.compile(
  vine.object({
    supplierId: uuid(),
    organizationId: uuid().optional(),
    externalNumber: vine.string().trim().maxLength(80),
    purchaseOrderId: uuid().nullable().optional(),
    invoiceDate: vine.string().trim().maxLength(10).optional(),
    dueOn: vine.string().trim().maxLength(10).optional(),
    currency: vine.string().trim().maxLength(3).optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    lines: vine.array(invoiceLine).maxLength(100).optional(),
  })
)

export const updateSupplierInvoiceValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    externalNumber: vine.string().trim().maxLength(80).optional(),
    purchaseOrderId: uuid().nullable().optional(),
    invoiceDate: vine.string().trim().maxLength(10).optional(),
    dueOn: vine.string().trim().maxLength(10).optional(),
    currency: vine.string().trim().optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)

export const validateSupplierInvoiceValidator = vine.compile(
  vine.object({ overrideReason: vine.string().trim().maxLength(300).optional() })
)
