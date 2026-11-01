import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

/** O conteúdo (datas, decimais, regras) é validado pelo domínio; aqui só o transporte. */
export const listContractsValidator = vine.compile(
  vine.object({
    partyId: uuid().optional(),
    type: vine.string().trim().maxLength(20).optional(),
    status: vine.string().trim().maxLength(20).optional(),
    q: vine.string().trim().maxLength(60).optional(),
    ...page,
  })
)

const contractBody = {
  title: vine.string().trim().maxLength(200).optional(),
  type: vine.string().trim().maxLength(20).optional(),
  startDate: vine.string().trim().maxLength(10).optional(),
  endDate: vine.string().trim().maxLength(10).nullable().optional(),
  currency: vine.string().trim().maxLength(3).optional(),
  amount: vine.string().trim().maxLength(30).nullable().optional(),
  renewalMode: vine.string().trim().maxLength(10).optional(),
  noticeDays: vine.number().optional(),
  notes: vine.string().maxLength(2000).nullable().optional(),
}

export const createContractValidator = vine.compile(
  vine.object({ organizationId: uuid(), partyId: uuid(), ...contractBody })
)

export const updateContractValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    organizationId: vine.string().trim().optional(),
    partyId: vine.string().trim().optional(),
    ...contractBody,
  })
)

export const reasonValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)

export const listInvoicesValidator = vine.compile(
  vine.object({
    customerId: uuid().optional(),
    orderId: uuid().optional(),
    contractId: uuid().optional(),
    status: vine.enum(['DRAFT', 'ISSUED', 'CREDITED']).optional(),
    q: vine.string().trim().maxLength(60).optional(),
    ...page,
  })
)

const invoiceLine = vine.object({
  orderLineId: uuid().optional(),
  description: vine.string().maxLength(500).optional(),
  quantity: vine.string().trim().maxLength(30).optional(),
  unitPrice: vine.string().trim().maxLength(30).optional(),
  discountAmount: vine.string().trim().maxLength(30).optional(),
  taxCode: vine.string().trim().maxLength(50).optional(),
  taxRate: vine.string().trim().maxLength(12).optional(),
  exemptionReason: vine.string().maxLength(300).optional(),
})

export const createInvoiceValidator = vine.compile(
  vine.object({
    orderId: uuid().optional(),
    organizationId: uuid().optional(),
    customerId: uuid().optional(),
    contractId: uuid().nullable().optional(),
    dueOn: vine.string().trim().maxLength(10).optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
    lines: vine.array(invoiceLine).maxLength(100).optional(),
  })
)

export const updateInvoiceValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    contractId: uuid().nullable().optional(),
    dueOn: vine.string().trim().maxLength(10).optional(),
    notes: vine.string().maxLength(1000).nullable().optional(),
  })
)

export const invoiceLineValidator = vine.compile(invoiceLine)

export const listCreditNotesValidator = vine.compile(
  vine.object({
    invoiceId: uuid().optional(),
    status: vine.enum(['DRAFT', 'ISSUED']).optional(),
    ...page,
  })
)

const creditLine = vine.object({
  invoiceLineId: uuid(),
  quantity: vine.string().trim().maxLength(30),
  amount: vine.string().trim().maxLength(30).optional(),
})

export const createCreditNoteValidator = vine.compile(
  vine.object({
    invoiceId: uuid(),
    reason: vine.string().trim().maxLength(300),
    lines: vine.array(creditLine).maxLength(100).optional(),
  })
)

export const updateCreditNoteValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)

export const creditLineValidator = vine.compile(creditLine)
