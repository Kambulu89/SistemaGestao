import {
  fromScaled,
  roundDiv,
  toScaled,
  type RoundingMode,
} from '#modules/procurement/domain/decimal'

/**
 * Compras (M06). Domínio puro: estados, validação das entradas e aritmética exacta (sempre `bigint` escalado, nunca
 * `number`). O que foi recebido de uma linha deriva das recepções lançadas e não revertidas; nunca é um saldo editável.
 */
export type SupplierStatus = 'ACTIVE' | 'BLOCKED' | 'INACTIVE'
export type RequisitionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CONVERTED'
export type PurchaseStatus = 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED'
export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'REVERSED'

export const SUPPLIER_STATUSES: readonly SupplierStatus[] = ['ACTIVE', 'BLOCKED', 'INACTIVE']

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/
export const CURRENCY = /^[A-Z]{3}$/
const QUANTITY = /^\d{1,13}(\.\d{1,6})?$/
const MONEY = /^\d{1,15}(\.\d{1,4})?$/
const RATE = /^\d{1,3}(\.\d{1,4})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

export const isPositiveQuantity = (value: unknown): value is string =>
  typeof value === 'string' && QUANTITY.test(value) && /[1-9]/.test(value)
export const isMoney = (value: unknown): value is string =>
  typeof value === 'string' && MONEY.test(value)

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null

// --- fornecedores -----------------------------------------------------------------------------------

export interface SupplierValues {
  partyId: string
  organizationId: string
  code: string
  paymentTermDays: number
  currency: string
  status: SupplierStatus
  statusReason: string | null
}

export interface SupplierInput {
  partyId?: unknown
  organizationId?: unknown
  code?: unknown
  paymentTermDays?: unknown
  currency?: unknown
  status?: unknown
  statusReason?: unknown
}

/**
 * Valida o fornecedor. A Party, a organização e o código não mudam depois de criado. Bloquear ou inactivar exige motivo;
 * voltar a activo limpa-o.
 */
export function normalizeSupplier(
  input: SupplierInput,
  base: SupplierValues | null,
  defaultCurrency: string,
  issues: Issue[]
): SupplierValues | null {
  const before = issues.length
  const partyId = base?.partyId ?? input.partyId
  const organizationId = base?.organizationId ?? input.organizationId
  if (typeof partyId !== 'string' || !partyId) {
    issues.push(issue('partyId', 'REQUIRED', 'Indique a pessoa ou organização (Party).'))
  }
  if (typeof organizationId !== 'string' || !organizationId) {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  if (base) {
    for (const key of ['partyId', 'organizationId', 'code'] as const) {
      if (input[key] !== undefined && input[key] !== base[key]) {
        issues.push(issue(key, 'IMMUTABLE', 'Este campo não se altera depois de criado.'))
      }
    }
  }
  const code = base?.code ?? (typeof input.code === 'string' ? input.code.trim() : '')
  if (!base && !CODE.test(code)) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  const terms =
    input.paymentTermDays === undefined ? (base?.paymentTermDays ?? 0) : input.paymentTermDays
  if (!Number.isInteger(terms) || (terms as number) < 0 || (terms as number) > 3650) {
    issues.push(issue('paymentTermDays', 'INVALID_TERMS', 'Prazo: inteiro entre 0 e 3650 dias.'))
  }
  const currency =
    input.currency === undefined ? (base?.currency ?? defaultCurrency) : input.currency
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda ISO 4217 em maiúsculas (ex.: AOA).'))
  }
  const status = (input.status ?? base?.status ?? 'ACTIVE') as SupplierStatus
  if (!SUPPLIER_STATUSES.includes(status)) {
    issues.push(issue('status', 'INVALID_STATUS', 'Estado: ACTIVE, BLOCKED ou INACTIVE.'))
  }
  let statusReason: string | null = null
  if (status !== 'ACTIVE') {
    const given =
      input.statusReason === undefined ? (base?.statusReason ?? null) : input.statusReason
    statusReason = text(given, 300)
    if (!statusReason) {
      issues.push(
        issue('statusReason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')
      )
    }
  }
  if (issues.length > before) return null
  return {
    partyId: partyId as string,
    organizationId: organizationId as string,
    code,
    paymentTermDays: terms as number,
    currency: currency as string,
    status,
    statusReason,
  }
}

/** Um fornecedor bloqueado ou inactivo não recebe novas encomendas (as já feitas continuam a receber-se). */
export function purchaseBlocker(status: SupplierStatus): { code: string; message: string } | null {
  if (status === 'BLOCKED') {
    return {
      code: 'SUPPLIER_BLOCKED',
      message: 'O fornecedor está bloqueado: não recebe novas encomendas.',
    }
  }
  if (status === 'INACTIVE') {
    return {
      code: 'SUPPLIER_INACTIVE',
      message: 'O fornecedor está inactivo: não recebe novas encomendas.',
    }
  }
  return null
}

// --- linhas -----------------------------------------------------------------------------------------

export interface RequisitionLineInput {
  variantId?: unknown
  quantity?: unknown
}

export function normalizeRequisitionLine(
  input: RequisitionLineInput,
  path: string,
  issues: Issue[]
): { variantId: string; quantity: string } | null {
  const before = issues.length
  if (typeof input.variantId !== 'string' || !input.variantId) {
    issues.push(issue(`${path}variantId`, 'REQUIRED', 'Indique a variante.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  if (issues.length > before) return null
  return { variantId: input.variantId as string, quantity: input.quantity as string }
}

export interface PurchaseLineInput {
  variantId?: unknown
  quantity?: unknown
  unitCost?: unknown
  taxRate?: unknown
}

export interface PurchaseLineValues {
  variantId: string
  quantity: string
  unitCost: string
  taxRate: string
  netAmount: string
  taxAmount: string
  total: string
}

/** Linha de compra: `líquido = quantidade × custo`, `imposto = líquido × taxa`, cada um arredondado uma só vez. */
export function purchaseLineValues(
  input: PurchaseLineInput,
  path: string,
  mode: RoundingMode,
  issues: Issue[]
): PurchaseLineValues | null {
  const before = issues.length
  if (typeof input.variantId !== 'string' || !input.variantId) {
    issues.push(issue(`${path}variantId`, 'REQUIRED', 'Indique a variante.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  if (!isMoney(input.unitCost)) {
    issues.push(issue(`${path}unitCost`, 'INVALID_COST', 'Custo com até 4 casas, não negativo.'))
  }
  const taxRate = input.taxRate === undefined ? '0' : input.taxRate
  if (typeof taxRate !== 'string' || !RATE.test(taxRate) || Number(taxRate) > 100) {
    issues.push(
      issue(`${path}taxRate`, 'INVALID_TAX_RATE', 'Taxa em percentagem (0–100, até 4 casas).')
    )
  }
  if (issues.length > before) return null
  const quantity = toScaled(input.quantity as string, 6) as bigint
  const cost = toScaled(input.unitCost as string, 4) as bigint
  const rate = toScaled(taxRate as string, 4) as bigint
  const net = roundDiv(quantity * cost, 10n ** 6n, mode)
  const tax = roundDiv(net * rate, 1_000_000n, mode)
  return {
    variantId: input.variantId as string,
    quantity: input.quantity as string,
    unitCost: input.unitCost as string,
    taxRate: taxRate as string,
    netAmount: fromScaled(net, 4),
    taxAmount: fromScaled(tax, 4),
    total: fromScaled(net + tax, 4),
  }
}

// --- recepções --------------------------------------------------------------------------------------

export interface Balance {
  ordered: bigint
  received: bigint
}

/** O que ainda falta receber de uma linha (nunca negativo). */
export const remaining = (balance: Balance): bigint =>
  balance.ordered > balance.received ? balance.ordered - balance.received : 0n

/** `true` se a quantidade (positiva) cabe no saldo por receber. */
export const fits = (balance: Balance, quantity: string): boolean => {
  const q = toScaled(quantity, 6)
  return q !== null && q > 0n && q <= remaining(balance)
}

export const quantityText = (value: bigint): string => fromScaled(value, 6)

/** Estado da encomenda a partir dos saldos: nada recebido → `ORDERED`; tudo → `RECEIVED`; senão `PARTIAL`. */
export function statusAfterReceiving(
  balances: readonly Balance[]
): 'ORDERED' | 'PARTIAL' | 'RECEIVED' {
  if (balances.length === 0 || balances.every((b) => b.received === 0n)) return 'ORDERED'
  return balances.every((b) => b.received >= b.ordered) ? 'RECEIVED' : 'PARTIAL'
}

export const canReceive = (status: PurchaseStatus): boolean =>
  status === 'ORDERED' || status === 'PARTIAL'

export interface ReceiptLineInput {
  purchaseLineId?: unknown
  quantity?: unknown
  lotCode?: unknown
  expiresOn?: unknown
}

export interface ReceiptLineValues {
  purchaseLineId: string
  quantity: string
  lotCode: string | null
  expiresOn: string | null
}

export function normalizeReceiptLine(
  input: ReceiptLineInput,
  path: string,
  issues: Issue[]
): ReceiptLineValues | null {
  const before = issues.length
  if (typeof input.purchaseLineId !== 'string' || !input.purchaseLineId) {
    issues.push(issue(`${path}purchaseLineId`, 'REQUIRED', 'Indique a linha da encomenda.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  let lotCode: string | null = null
  if (input.lotCode !== undefined && input.lotCode !== null && input.lotCode !== '') {
    lotCode = text(input.lotCode, 60)
    if (!lotCode)
      issues.push(issue(`${path}lotCode`, 'INVALID_LOT', 'Código do lote até 60 caracteres.'))
  }
  let expiresOn: string | null = null
  if (input.expiresOn !== undefined && input.expiresOn !== null && input.expiresOn !== '') {
    if (!isIsoDate(input.expiresOn)) {
      issues.push(issue(`${path}expiresOn`, 'INVALID_DATE', 'A validade tem de ser AAAA-MM-DD.'))
    } else {
      expiresOn = input.expiresOn
    }
  }
  if (issues.length > before) return null
  return {
    purchaseLineId: input.purchaseLineId as string,
    quantity: input.quantity as string,
    lotCode,
    expiresOn,
  }
}

export interface LineTotals {
  netAmount: string
  taxAmount: string
  total: string
}

/** Soma exacta dos valores das linhas já arredondadas: o total do documento é a soma das suas linhas. */
export function sumLines(lines: readonly LineTotals[]): {
  net: string
  tax: string
  total: string
} {
  let net = 0n
  let tax = 0n
  let total = 0n
  for (const line of lines) {
    net += toScaled(line.netAmount, 4) ?? 0n
    tax += toScaled(line.taxAmount, 4) ?? 0n
    total += toScaled(line.total, 4) ?? 0n
  }
  return { net: fromScaled(net, 4), tax: fromScaled(tax, 4), total: fromScaled(total, 4) }
}
