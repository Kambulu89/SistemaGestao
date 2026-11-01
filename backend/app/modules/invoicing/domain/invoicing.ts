import {
  fromScaled,
  roundDiv,
  toScaled,
  type RoundingMode,
} from '#modules/invoicing/domain/decimal'

/**
 * Contratos, facturas e notas de crédito (M05). Domínio puro: estados, validação das entradas e aritmética exacta (sempre
 * `bigint` escalado, nunca `number`). O que foi facturado e creditado nunca se guarda como saldo editável: deriva-se das
 * linhas emitidas.
 */
export type ContractType = 'SALES' | 'PURCHASE' | 'SERVICE'
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED'
export type RenewalMode = 'NONE' | 'MANUAL' | 'AUTO'
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CREDITED'
export type CreditNoteStatus = 'DRAFT' | 'ISSUED'

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export const CURRENCY = /^[A-Z]{3}$/
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const QUANTITY = /^\d{1,13}(\.\d{1,6})?$/
const MONEY = /^\d{1,15}(\.\d{1,4})?$/
const RATE = /^\d{1,3}(\.\d{1,4})?$/

export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

const positive = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value) && /[1-9]/.test(value)
export const isPositiveQuantity = (value: unknown): value is string => positive(value, QUANTITY)
export const isPositiveMoney = (value: unknown): value is string => positive(value, MONEY)
export const isMoney = (value: unknown): value is string =>
  typeof value === 'string' && MONEY.test(value)

/** Dias entre duas datas ISO (b − a). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

// --- contratos --------------------------------------------------------------------------------------

export interface ContractValues {
  organizationId: string
  partyId: string
  type: ContractType
  title: string
  startDate: string
  endDate: string | null
  currency: string
  amount: string | null
  renewalMode: RenewalMode
  noticeDays: number
  notes: string | null
}

export interface ContractInput {
  organizationId?: unknown
  partyId?: unknown
  type?: unknown
  title?: unknown
  startDate?: unknown
  endDate?: unknown
  currency?: unknown
  amount?: unknown
  renewalMode?: unknown
  noticeDays?: unknown
  notes?: unknown
}

const CONTRACT_TYPES: readonly ContractType[] = ['SALES', 'PURCHASE', 'SERVICE']
const RENEWAL_MODES: readonly RenewalMode[] = ['NONE', 'MANUAL', 'AUTO']

/** Um contrato activo cujo fim passou deixa de estar em vigor: o estado é derivado, nunca gravado. */
export function effectiveContractStatus(
  status: Exclude<ContractStatus, 'EXPIRED'>,
  endDate: string | null,
  today: string
): ContractStatus {
  return status === 'ACTIVE' && endDate !== null && endDate < today ? 'EXPIRED' : status
}

/** Último dia para avisar da não renovação (`fim − aviso`); `null` sem fim. */
export const noticeDeadline = (endDate: string | null, noticeDays: number): string | null =>
  endDate ? addDays(endDate, -noticeDays) : null

/** Valida o contrato; em actualização `base` traz o que já existe e o que não vem mantém-se. */
export function normalizeContract(
  input: ContractInput,
  base: ContractValues | null,
  currencyDefault: string,
  issues: Issue[]
): ContractValues | null {
  const before = issues.length
  const organizationId = (input.organizationId ?? base?.organizationId) as string | undefined
  const partyId = (input.partyId ?? base?.partyId) as string | undefined
  if (typeof organizationId !== 'string' || !organizationId) {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  if (typeof partyId !== 'string' || !partyId) {
    issues.push(issue('partyId', 'REQUIRED', 'Indique a contraparte (Party).'))
  }
  const type = (input.type ?? base?.type ?? 'SERVICE') as ContractType
  if (!CONTRACT_TYPES.includes(type)) {
    issues.push(issue('type', 'INVALID_TYPE', 'Tipo: SALES, PURCHASE ou SERVICE.'))
  }
  const title = typeof input.title === 'string' ? input.title.trim() : (base?.title ?? '')
  if (!title || title.length > 160) {
    issues.push(issue('title', 'INVALID_TITLE', 'Indique o título (até 160 caracteres).'))
  }
  const startDate = (input.startDate ?? base?.startDate) as unknown
  if (!isIsoDate(startDate)) {
    issues.push(issue('startDate', 'INVALID_DATE', 'A data de início tem de ser AAAA-MM-DD.'))
  }
  const endRaw = input.endDate === undefined ? (base?.endDate ?? null) : input.endDate
  if (endRaw !== null && !isIsoDate(endRaw)) {
    issues.push(issue('endDate', 'INVALID_DATE', 'A data de fim tem de ser AAAA-MM-DD.'))
  } else if (endRaw !== null && isIsoDate(startDate) && endRaw < startDate) {
    issues.push(issue('endDate', 'END_BEFORE_START', 'O fim não pode ser anterior ao início.'))
  }
  const currency = (input.currency ?? base?.currency ?? currencyDefault) as unknown
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda ISO 4217 em maiúsculas (ex.: AOA).'))
  }
  const amountRaw = input.amount === undefined ? (base?.amount ?? null) : input.amount
  if (amountRaw !== null && !isMoney(amountRaw)) {
    issues.push(issue('amount', 'INVALID_AMOUNT', 'Valor com até 4 casas, não negativo.'))
  }
  const renewalMode = (input.renewalMode ?? base?.renewalMode ?? 'NONE') as RenewalMode
  if (!RENEWAL_MODES.includes(renewalMode)) {
    issues.push(issue('renewalMode', 'INVALID_RENEWAL', 'Renovação: NONE, MANUAL ou AUTO.'))
  }
  const noticeDays = input.noticeDays === undefined ? (base?.noticeDays ?? 0) : input.noticeDays
  if (
    !Number.isInteger(noticeDays) ||
    (noticeDays as number) < 0 ||
    (noticeDays as number) > 3650
  ) {
    issues.push(issue('noticeDays', 'INVALID_NOTICE', 'Aviso: inteiro entre 0 e 3650 dias.'))
  }
  if (renewalMode !== 'NONE' && endRaw === null) {
    issues.push(issue('endDate', 'END_REQUIRED', 'Um contrato renovável precisa de data de fim.'))
  }
  const notesRaw = input.notes === undefined ? (base?.notes ?? null) : input.notes
  if (notesRaw !== null && (typeof notesRaw !== 'string' || notesRaw.length > 1000)) {
    issues.push(issue('notes', 'INVALID_NOTES', 'As notas têm no máximo 1000 caracteres.'))
  }
  if (issues.length > before) return null
  return {
    organizationId: organizationId as string,
    partyId: partyId as string,
    type,
    title,
    startDate: startDate as string,
    endDate: endRaw as string | null,
    currency: currency as string,
    amount: amountRaw as string | null,
    renewalMode,
    noticeDays: noticeDays as number,
    notes: typeof notesRaw === 'string' ? notesRaw.trim() || null : null,
  }
}

// --- linhas de factura ------------------------------------------------------------------------------

export interface InvoiceLineValues {
  salesOrderLineId: string | null
  variantId: string | null
  description: string
  quantity: string
  unitPrice: string
  discountAmount: string
  taxCode: string
  taxRate: string
  exemptionReason: string | null
  netAmount: string
  taxAmount: string
  total: string
}

export interface ManualLineInput {
  description?: unknown
  quantity?: unknown
  unitPrice?: unknown
  discountAmount?: unknown
  taxCode?: unknown
  taxRate?: unknown
  exemptionReason?: unknown
}

/** Linha livre (sem encomenda): o preço vem do pedido, o imposto é `base × taxa` (preço sem imposto). */
export function manualLineValues(
  input: ManualLineInput,
  path: string,
  mode: RoundingMode,
  issues: Issue[]
): InvoiceLineValues | null {
  const before = issues.length
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (!description || description.length > 500) {
    issues.push(issue(`${path}description`, 'INVALID_DESCRIPTION', 'Descrição até 500 caracteres.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  if (!isMoney(input.unitPrice)) {
    issues.push(issue(`${path}unitPrice`, 'INVALID_PRICE', 'Preço com até 4 casas, não negativo.'))
  }
  const discountAmount = input.discountAmount === undefined ? '0' : input.discountAmount
  if (!isMoney(discountAmount)) {
    issues.push(issue(`${path}discountAmount`, 'INVALID_DISCOUNT', 'Desconto com até 4 casas.'))
  }
  const taxRate = input.taxRate === undefined ? '0' : input.taxRate
  if (typeof taxRate !== 'string' || !RATE.test(taxRate)) {
    issues.push(issue(`${path}taxRate`, 'INVALID_TAX_RATE', 'Taxa em percentagem com até 4 casas.'))
  }
  const exempt = typeof taxRate === 'string' && (toScaled(taxRate, 4) ?? 1n) === 0n
  const exemptionReason =
    typeof input.exemptionReason === 'string' ? input.exemptionReason.trim() : ''
  if (exempt && !exemptionReason) {
    issues.push(
      issue(
        `${path}exemptionReason`,
        'EXEMPTION_REQUIRED',
        'Uma linha sem imposto exige o motivo da isenção.'
      )
    )
  }
  if (issues.length > before) return null
  const q = toScaled(input.quantity as string, 6) as bigint
  const price = toScaled(input.unitPrice as string, 4) as bigint
  const discount = toScaled(discountAmount as string, 4) as bigint
  const gross = roundDiv(q * price, 10n ** 6n, mode)
  if (discount > gross) {
    issues.push(
      issue(
        `${path}discountAmount`,
        'DISCOUNT_EXCEEDS',
        'O desconto não pode ultrapassar o valor da linha.'
      )
    )
    return null
  }
  const net = gross - discount
  const rate = toScaled(taxRate as string, 4) as bigint
  const tax = roundDiv(net * rate, 1_000_000n, mode)
  return {
    salesOrderLineId: null,
    variantId: null,
    description,
    quantity: input.quantity as string,
    unitPrice: input.unitPrice as string,
    discountAmount: fromScaled(discount, 4),
    taxCode:
      typeof input.taxCode === 'string' && input.taxCode.trim()
        ? input.taxCode.trim().slice(0, 50)
        : exempt
          ? 'ISENTO'
          : `IVA-${taxRate as string}`,
    taxRate: taxRate as string,
    exemptionReason: exempt ? exemptionReason.slice(0, 300) : null,
    netAmount: fromScaled(net, 4),
    taxAmount: fromScaled(tax, 4),
    total: fromScaled(net + tax, 4),
  }
}

// --- elegibilidade e saldo creditável ---------------------------------------------------------------

/**
 * O que se pode facturar de uma linha de encomenda: o que já foi **expedido** nos bens com controlo de stock e o que foi
 * **encomendado** nos serviços (sem expedição). Menos o que já está facturado (e não creditado).
 */
export function billableQuantity(input: {
  ordered: bigint
  shipped: bigint
  billed: bigint
  stockTracked: boolean
}): bigint {
  const eligible = input.stockTracked ? input.shipped : input.ordered
  const capped = eligible > input.ordered ? input.ordered : eligible
  return capped > input.billed ? capped - input.billed : 0n
}

export interface CreditableLine {
  quantity: bigint
  net: bigint
  tax: bigint
}

export interface CreditRequest {
  quantity: string
  amount?: string
}

/**
 * Valores de uma linha de nota de crédito. Sem `amount` o crédito é proporcional à quantidade (e creditar **todo o que resta**
 * dá exactamente o que resta, sem sobras de arredondamento); com `amount` (valor líquido) o imposto é proporcional ao valor.
 * Nunca excede a quantidade nem o valor ainda creditáveis.
 */
export function creditLineValues(
  line: CreditableLine,
  credited: CreditableLine,
  request: CreditRequest,
  mode: RoundingMode,
  path: string,
  issues: Issue[]
): { quantity: string; amount: string; taxAmount: string } | null {
  const before = issues.length
  if (!isPositiveQuantity(request.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  if (request.amount !== undefined && !isPositiveMoney(request.amount)) {
    issues.push(issue(`${path}amount`, 'INVALID_AMOUNT', 'Valor positivo com até 4 casas.'))
  }
  if (issues.length > before) return null
  const quantity = toScaled(request.quantity, 6) as bigint
  const remainingQty = line.quantity - credited.quantity
  const remainingNet = line.net - credited.net
  const remainingTax = line.tax - credited.tax
  if (quantity > remainingQty) {
    issues.push(
      issue(
        `${path}quantity`,
        'EXCEEDS_CREDITABLE',
        `Só falta creditar ${fromScaled(remainingQty > 0n ? remainingQty : 0n, 6)}.`
      )
    )
    return null
  }
  let amount: bigint
  let tax: bigint
  if (request.amount !== undefined) {
    amount = toScaled(request.amount, 4) as bigint
    tax = line.net === 0n ? 0n : roundDiv(amount * line.tax, line.net, mode)
    if (quantity === remainingQty && amount === remainingNet) tax = remainingTax
  } else if (quantity === remainingQty) {
    amount = remainingNet
    tax = remainingTax
  } else {
    amount = roundDiv(line.net * quantity, line.quantity, mode)
    tax = roundDiv(line.tax * quantity, line.quantity, mode)
  }
  if (amount <= 0n) {
    issues.push(
      issue(`${path}amount`, 'NOTHING_TO_CREDIT', 'Esta linha já não tem valor por creditar.')
    )
    return null
  }
  if (amount > remainingNet || tax > remainingTax) {
    issues.push(
      issue(
        `${path}amount`,
        'EXCEEDS_CREDITABLE',
        `Só falta creditar ${fromScaled(remainingNet > 0n ? remainingNet : 0n, 4)} (líquido).`
      )
    )
    return null
  }
  return {
    quantity: request.quantity,
    amount: fromScaled(amount, 4),
    taxAmount: fromScaled(tax, 4),
  }
}

/** A factura fica `CREDITED` quando todas as linhas estão totalmente creditadas (quantidade e valor). */
export function fullyCredited(
  lines: readonly { line: CreditableLine; credited: CreditableLine }[]
): boolean {
  return (
    lines.length > 0 &&
    lines.every(
      (l) =>
        l.credited.quantity >= l.line.quantity &&
        l.credited.net >= l.line.net &&
        l.credited.tax >= l.line.tax
    )
  )
}
