import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  fromScaled,
  roundDiv,
  toScaled,
  type RoundingMode,
} from '#core/decimal/index'

/**
 * Tesouraria, contas a receber e a pagar (M09). Domínio puro: estados, validação das entradas e aritmética exacta
 * (`bigint` escalado, nunca `number`). O saldo de uma obrigação nunca é um campo: deriva do original, dos créditos
 * aplicados e das alocações de pagamentos confirmados e não revertidos.
 */
export type AccountType = 'CASH' | 'BANK'
export type ObligationKind = 'receivable' | 'payable'
export type ObligationStatus = 'OPEN' | 'CLOSED' | 'CANCELLED'
export type PaymentDirection = 'INBOUND' | 'OUTBOUND'
export type PaymentMethod = 'CASH' | 'TRANSFER' | 'CARD' | 'OTHER'
export type PaymentStatus = 'DRAFT' | 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED'
export type SupplierInvoiceStatus = 'DRAFT' | 'VALIDATED' | 'DISPUTED' | 'VOID'

export const ACCOUNT_TYPES: readonly AccountType[] = ['CASH', 'BANK']
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['CASH', 'TRANSFER', 'CARD', 'OTHER']

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/
export const CURRENCY = /^[A-Z]{3}$/
const MONEY = /^\d{1,15}(\.\d{1,4})?$/
const QUANTITY = /^\d{1,13}(\.\d{1,6})?$/
const RATE = /^\d{1,3}(\.\d{1,4})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

export const isPositiveMoney = (value: unknown): value is string =>
  typeof value === 'string' && MONEY.test(value) && /[1-9]/.test(value)

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null

const optionalText = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed.length <= max ? trimmed : undefined
}

export const money = (value: string): bigint => toScaled(value, MONEY_SCALE) as bigint
export const showMoney = (value: bigint): string => fromScaled(value, MONEY_SCALE)

// --- contas de tesouraria ---------------------------------------------------------------------------

export interface AccountValues {
  organizationId: string
  code: string
  name: string
  type: AccountType
  currency: string
  bankName: string | null
  accountIdentifier: string | null
  active: boolean
}

export interface AccountInput {
  organizationId?: unknown
  code?: unknown
  name?: unknown
  type?: unknown
  currency?: unknown
  bankName?: unknown
  accountIdentifier?: unknown
  active?: unknown
}

/** A organização, o código, o tipo e a moeda nunca mudam depois de criada a conta (há movimentos que lhe pertencem). */
export function normalizeAccount(
  input: AccountInput,
  base: AccountValues | null,
  defaultCurrency: string,
  issues: Issue[]
): AccountValues | null {
  const before = issues.length
  const immutable = (field: 'organizationId' | 'code' | 'type' | 'currency') => {
    if (base && input[field] !== undefined && input[field] !== base[field]) {
      issues.push(
        issue(field, 'IMMUTABLE', 'Este campo não pode ser alterado depois de criada a conta.')
      )
    }
  }
  for (const field of ['organizationId', 'code', 'type', 'currency'] as const) immutable(field)

  const organizationId = base?.organizationId ?? input.organizationId
  if (!base && typeof organizationId !== 'string') {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  const code = base?.code ?? (typeof input.code === 'string' ? input.code.trim() : '')
  if (!base && !CODE.test(code)) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  const name = input.name === undefined && base ? base.name : text(input.name, 160)
  if (!name) issues.push(issue('name', 'REQUIRED', 'Indique o nome da conta (máx. 160).'))
  const type = base?.type ?? input.type
  if (!ACCOUNT_TYPES.includes(type as AccountType)) {
    issues.push(issue('type', 'INVALID_TYPE', 'Tipo: CASH (caixa) ou BANK (banco).'))
  }
  const currency =
    base?.currency ?? (input.currency === undefined ? defaultCurrency : input.currency)
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda: código ISO de 3 letras maiúsculas.'))
  }
  const bankName = optionalText(input.bankName, 160)
  if (input.bankName !== undefined && bankName === undefined) {
    issues.push(issue('bankName', 'INVALID_TEXT', 'Nome do banco: texto até 160 caracteres.'))
  }
  const identifier = optionalText(input.accountIdentifier, 100)
  if (input.accountIdentifier !== undefined && identifier === undefined) {
    issues.push(
      issue('accountIdentifier', 'INVALID_TEXT', 'Identificador: texto até 100 caracteres.')
    )
  }
  const active = input.active === undefined ? (base?.active ?? true) : input.active
  if (typeof active !== 'boolean')
    issues.push(issue('active', 'INVALID_FLAG', 'active é booleano.'))
  if (issues.length > before || !name) return null
  return {
    organizationId: organizationId as string,
    code,
    name,
    type: type as AccountType,
    currency: currency as string,
    bankName: bankName === undefined ? (base?.bankName ?? null) : bankName,
    accountIdentifier: identifier === undefined ? (base?.accountIdentifier ?? null) : identifier,
    active: active as boolean,
  }
}

// --- saldo e estado derivados -----------------------------------------------------------------------

export interface BalanceParts {
  original: string
  credits: string
  paid: string
}

/** `saldo = original − créditos aplicados − alocações confirmadas e não revertidas`; nunca negativo. */
export function balanceOf(parts: BalanceParts): string {
  const balance = money(parts.original) - money(parts.credits) - money(parts.paid)
  return showMoney(balance < 0n ? 0n : balance)
}

export type ObligationView = 'OPEN' | 'PARTIAL' | 'OVERDUE' | 'CLOSED' | 'CANCELLED'

/** Estado mostrado: aberto, parcialmente pago, vencido (por pagar depois do vencimento), liquidado ou cancelado. */
export function viewOf(
  status: ObligationStatus,
  parts: BalanceParts,
  dueOn: string,
  today: string
): ObligationView {
  if (status === 'CANCELLED') return 'CANCELLED'
  if (status === 'CLOSED') return 'CLOSED'
  if (dueOn < today) return 'OVERDUE'
  return money(parts.credits) + money(parts.paid) > 0n ? 'PARTIAL' : 'OPEN'
}

export const addDays = (date: string, days: number): string => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

// --- pagamentos --------------------------------------------------------------------------------------

export interface AllocationValues {
  receivableId: string | null
  payableId: string | null
  amount: string
}

export interface PaymentValues {
  organizationId: string
  direction: PaymentDirection
  partyId: string
  treasuryAccountId: string
  amount: string
  currency: string
  method: PaymentMethod
  occurredOn: string
  reference: string | null
  allocations: AllocationValues[]
}

export interface PaymentInput {
  organizationId?: unknown
  direction?: unknown
  partyId?: unknown
  treasuryAccountId?: unknown
  amount?: unknown
  method?: unknown
  occurredOn?: unknown
  reference?: unknown
  allocations?: unknown
}

export const MAX_ALLOCATIONS = 100

/**
 * Valida um pagamento. A moeda é a da conta de tesouraria (passada em `accountCurrency`). Cada alocação visa uma só
 * obrigação do sentido certo (recebível para entradas, pagável para saídas), sem repetições, e a soma das alocações
 * tem de igualar o montante: o dinheiro de um pagamento nunca fica por atribuir.
 */
export function normalizePayment(
  input: PaymentInput,
  accountCurrency: string | null,
  today: string,
  issues: Issue[]
): PaymentValues | null {
  const before = issues.length
  if (typeof input.organizationId !== 'string')
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  if (input.direction !== 'INBOUND' && input.direction !== 'OUTBOUND')
    issues.push(
      issue(
        'direction',
        'INVALID_DIRECTION',
        'Sentido: INBOUND (recebimento) ou OUTBOUND (pagamento).'
      )
    )
  if (typeof input.partyId !== 'string')
    issues.push(issue('partyId', 'REQUIRED', 'Indique o cliente ou fornecedor (Party).'))
  if (typeof input.treasuryAccountId !== 'string')
    issues.push(issue('treasuryAccountId', 'REQUIRED', 'Indique a conta de tesouraria.'))
  if (!isPositiveMoney(input.amount))
    issues.push(issue('amount', 'INVALID_MONEY', 'Montante: número positivo, até 4 casas.'))
  const method = input.method ?? 'TRANSFER'
  if (!PAYMENT_METHODS.includes(method as PaymentMethod))
    issues.push(issue('method', 'INVALID_METHOD', 'Método: CASH, TRANSFER, CARD ou OTHER.'))
  const occurredOn = input.occurredOn === undefined ? today : input.occurredOn
  if (!isIsoDate(occurredOn))
    issues.push(issue('occurredOn', 'INVALID_DATE', 'Data no formato AAAA-MM-DD.'))
  const reference = optionalText(input.reference, 160)
  if (input.reference !== undefined && reference === undefined)
    issues.push(issue('reference', 'INVALID_TEXT', 'Referência: texto até 160 caracteres.'))

  const allocations: AllocationValues[] = []
  if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
    issues.push(issue('allocations', 'REQUIRED', 'Indique pelo menos uma obrigação a liquidar.'))
  } else if (input.allocations.length > MAX_ALLOCATIONS) {
    issues.push(issue('allocations', 'TOO_MANY', `No máximo ${MAX_ALLOCATIONS} alocações.`))
  } else {
    const seen = new Set<string>()
    input.allocations.forEach((raw, index) => {
      const path = `allocations[${index}]`
      const a = (raw ?? {}) as Record<string, unknown>
      const targetKey = input.direction === 'OUTBOUND' ? 'payableId' : 'receivableId'
      const target = a[targetKey]
      const other = input.direction === 'OUTBOUND' ? a.receivableId : a.payableId
      if (typeof target !== 'string') {
        issues.push(issue(`${path}.${targetKey}`, 'REQUIRED', 'Indique a obrigação a liquidar.'))
      } else if (seen.has(target)) {
        issues.push(issue(`${path}.${targetKey}`, 'DUPLICATE', 'Obrigação repetida no pagamento.'))
      } else {
        seen.add(target)
      }
      if (other !== undefined && other !== null) {
        issues.push(
          issue(path, 'WRONG_DIRECTION', 'A obrigação não corresponde ao sentido do pagamento.')
        )
      }
      if (!isPositiveMoney(a.amount)) {
        issues.push(
          issue(`${path}.amount`, 'INVALID_MONEY', 'Montante: número positivo, até 4 casas.')
        )
      }
      if (typeof target === 'string' && isPositiveMoney(a.amount)) {
        allocations.push({
          receivableId: input.direction === 'OUTBOUND' ? null : target,
          payableId: input.direction === 'OUTBOUND' ? target : null,
          amount: a.amount,
        })
      }
    })
    if (issues.length === before && isPositiveMoney(input.amount)) {
      const sum = allocations.reduce((total, a) => total + money(a.amount), 0n)
      if (sum !== money(input.amount)) {
        issues.push(
          issue(
            'allocations',
            'ALLOCATION_MISMATCH',
            'A soma das alocações tem de igualar o montante.'
          )
        )
      }
    }
  }
  if (!accountCurrency && typeof input.treasuryAccountId === 'string')
    issues.push(issue('treasuryAccountId', 'UNKNOWN_ACCOUNT', 'A conta de tesouraria não existe.'))
  if (issues.length > before) return null
  return {
    organizationId: input.organizationId as string,
    direction: input.direction as PaymentDirection,
    partyId: input.partyId as string,
    treasuryAccountId: input.treasuryAccountId as string,
    amount: input.amount as string,
    currency: accountCurrency as string,
    method: method as PaymentMethod,
    occurredOn: occurredOn as string,
    reference: reference ?? null,
    allocations,
  }
}

// --- facturas de fornecedor --------------------------------------------------------------------------

export interface SupplierInvoiceLineValues {
  purchaseLineId: string | null
  description: string
  quantity: string
  unitPrice: string
  taxRate: string
  netAmount: string
  taxAmount: string
  total: string
}

export interface SupplierInvoiceLineInput {
  purchaseLineId?: unknown
  description?: unknown
  quantity?: unknown
  unitPrice?: unknown
  taxRate?: unknown
}

export interface SupplierInvoiceHeaderValues {
  organizationId: string
  supplierId: string
  externalNumber: string
  purchaseOrderId: string | null
  invoiceDate: string
  dueOn: string
  currency: string
  notes: string | null
}

export interface SupplierInvoiceHeaderInput {
  organizationId?: unknown
  supplierId?: unknown
  externalNumber?: unknown
  purchaseOrderId?: unknown
  invoiceDate?: unknown
  dueOn?: unknown
  currency?: unknown
  notes?: unknown
}

export function normalizeSupplierInvoiceHeader(
  input: SupplierInvoiceHeaderInput,
  base: SupplierInvoiceHeaderValues | null,
  defaults: { currency: string; paymentTermDays: number; today: string },
  issues: Issue[]
): SupplierInvoiceHeaderValues | null {
  const before = issues.length
  const organizationId = base?.organizationId ?? input.organizationId
  if (typeof organizationId !== 'string')
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  const supplierId = base?.supplierId ?? input.supplierId
  if (typeof supplierId !== 'string')
    issues.push(issue('supplierId', 'REQUIRED', 'Indique o fornecedor.'))
  const externalNumber =
    input.externalNumber === undefined && base
      ? base.externalNumber
      : text(input.externalNumber, 80)
  if (!externalNumber)
    issues.push(
      issue('externalNumber', 'REQUIRED', 'Indique o número da factura do fornecedor (máx. 80).')
    )
  const purchaseOrderId =
    input.purchaseOrderId === undefined ? (base?.purchaseOrderId ?? null) : input.purchaseOrderId
  if (purchaseOrderId !== null && typeof purchaseOrderId !== 'string')
    issues.push(issue('purchaseOrderId', 'INVALID_REFERENCE', 'Encomenda inválida.'))
  const invoiceDate =
    input.invoiceDate === undefined ? (base?.invoiceDate ?? defaults.today) : input.invoiceDate
  if (!isIsoDate(invoiceDate))
    issues.push(issue('invoiceDate', 'INVALID_DATE', 'Data no formato AAAA-MM-DD.'))
  const dueOn =
    input.dueOn === undefined
      ? (base?.dueOn ??
        (isIsoDate(invoiceDate) ? addDays(invoiceDate, defaults.paymentTermDays) : ''))
      : input.dueOn
  if (!isIsoDate(dueOn))
    issues.push(issue('dueOn', 'INVALID_DATE', 'Vencimento no formato AAAA-MM-DD.'))
  else if (isIsoDate(invoiceDate) && dueOn < invoiceDate)
    issues.push(
      issue('dueOn', 'DUE_BEFORE_DATE', 'O vencimento não pode ser anterior à data da factura.')
    )
  const currency =
    base?.currency ?? (input.currency === undefined ? defaults.currency : input.currency)
  if (typeof currency !== 'string' || !CURRENCY.test(currency))
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda: código ISO de 3 letras maiúsculas.'))
  if (base && input.currency !== undefined && input.currency !== base.currency)
    issues.push(issue('currency', 'IMMUTABLE', 'A moeda não pode ser alterada.'))
  const notes = optionalText(input.notes, 1000)
  if (input.notes !== undefined && notes === undefined)
    issues.push(issue('notes', 'INVALID_TEXT', 'Notas: texto até 1000 caracteres.'))
  if (issues.length > before || !externalNumber) return null
  return {
    organizationId: organizationId as string,
    supplierId: supplierId as string,
    externalNumber,
    purchaseOrderId: purchaseOrderId as string | null,
    invoiceDate: invoiceDate as string,
    dueOn: dueOn as string,
    currency: currency as string,
    notes: notes === undefined ? (base?.notes ?? null) : notes,
  }
}

/** Linha da factura: `líquido = quantidade × preço`, `imposto = líquido × taxa`, cada um arredondado uma só vez. */
export function supplierInvoiceLine(
  input: SupplierInvoiceLineInput,
  path: string,
  mode: RoundingMode,
  issues: Issue[]
): SupplierInvoiceLineValues | null {
  const before = issues.length
  const description = text(input.description, 500)
  if (!description)
    issues.push(issue(`${path}.description`, 'REQUIRED', 'Indique a descrição (máx. 500).'))
  const quantity = input.quantity
  if (typeof quantity !== 'string' || !QUANTITY.test(quantity) || !/[1-9]/.test(quantity))
    issues.push(issue(`${path}.quantity`, 'INVALID_QUANTITY', 'Quantidade: positiva, até 6 casas.'))
  const unitPrice = input.unitPrice
  if (typeof unitPrice !== 'string' || !MONEY.test(unitPrice))
    issues.push(
      issue(`${path}.unitPrice`, 'INVALID_MONEY', 'Preço: número não negativo, até 4 casas.')
    )
  const taxRate = input.taxRate === undefined ? '0' : input.taxRate
  if (typeof taxRate !== 'string' || !RATE.test(taxRate) || Number(taxRate) > 100)
    issues.push(issue(`${path}.taxRate`, 'INVALID_RATE', 'Taxa: 0 a 100, até 4 casas.'))
  const purchaseLineId = input.purchaseLineId ?? null
  if (purchaseLineId !== null && typeof purchaseLineId !== 'string')
    issues.push(issue(`${path}.purchaseLineId`, 'INVALID_REFERENCE', 'Linha de compra inválida.'))
  if (issues.length > before || !description) return null

  const q = toScaled(quantity as string, QUANTITY_SCALE) as bigint
  const price = toScaled(unitPrice as string, MONEY_SCALE) as bigint
  const rate = toScaled(taxRate as string, 4) as bigint
  const net = roundDiv(q * price, 10n ** BigInt(QUANTITY_SCALE), mode)
  const tax = roundDiv(net * rate, 10n ** 6n, mode)
  if (net + tax > 10n ** 19n - 1n) {
    issues.push(
      issue(`${path}.unitPrice`, 'AMOUNT_TOO_LARGE', 'O montante da linha é demasiado grande.')
    )
    return null
  }
  return {
    purchaseLineId: purchaseLineId as string | null,
    description,
    quantity: quantity as string,
    unitPrice: unitPrice as string,
    taxRate: taxRate as string,
    netAmount: showMoney(net),
    taxAmount: showMoney(tax),
    total: showMoney(net + tax),
  }
}

export interface InvoiceTotals {
  net: string
  tax: string
  total: string
}

export function sumInvoiceLines(lines: readonly SupplierInvoiceLineValues[]): InvoiceTotals {
  let net = 0n
  let tax = 0n
  for (const line of lines) {
    net += money(line.netAmount)
    tax += money(line.taxAmount)
  }
  return { net: showMoney(net), tax: showMoney(tax), total: showMoney(net + tax) }
}

export interface MatchLine {
  invoiceLineId: string
  purchaseLineId: string
  invoicedQuantity: string
  /** O que já foi facturado por outras facturas validadas da mesma linha de compra. */
  alreadyInvoiced: string
  receivedQuantity: string
  orderedUnitCost: string
  invoicedUnitPrice: string
}

export interface Discrepancy {
  line: string
  code: 'NOT_RECEIVED' | 'PRICE_ABOVE_ORDER'
  message: string
}

/**
 * Conferência a três vias (encomenda × recepção × factura), por linha de compra: não se factura mais do que o recebido
 * (incluindo o já facturado) nem a um preço acima do da encomenda. Devolve as divergências; vazio = conforme.
 */
export function matchInvoice(lines: readonly MatchLine[]): Discrepancy[] {
  const found: Discrepancy[] = []
  for (const l of lines) {
    const invoiced =
      (toScaled(l.invoicedQuantity, QUANTITY_SCALE) as bigint) +
      (toScaled(l.alreadyInvoiced, QUANTITY_SCALE) as bigint)
    if (invoiced > (toScaled(l.receivedQuantity, QUANTITY_SCALE) as bigint)) {
      found.push({
        line: l.invoiceLineId,
        code: 'NOT_RECEIVED',
        message: `Facturado ${fromScaled(invoiced, QUANTITY_SCALE)} mas só foram recebidas ${l.receivedQuantity}.`,
      })
    }
    if (money(l.invoicedUnitPrice) > money(l.orderedUnitCost)) {
      found.push({
        line: l.invoiceLineId,
        code: 'PRICE_ABOVE_ORDER',
        message: `Preço ${l.invoicedUnitPrice} acima do da encomenda (${l.orderedUnitCost}).`,
      })
    }
  }
  return found
}

// --- crédito -----------------------------------------------------------------------------------------

/** Exposição de crédito = recebíveis em aberto + reservas activas; o limite 0 significa «sem controlo». */
export function creditHeadroom(limit: string, exposure: string): string | null {
  if (money(limit) === 0n) return null
  const room = money(limit) - money(exposure)
  return showMoney(room < 0n ? 0n : room)
}

export function exceedsCredit(limit: string, exposure: string, additional: string): boolean {
  if (money(limit) === 0n) return false
  return money(exposure) + money(additional) > money(limit)
}
