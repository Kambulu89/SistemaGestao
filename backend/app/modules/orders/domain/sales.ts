/**
 * Propostas e encomendas (M04). Domínio puro: estados, validação das entradas e regras de transição. A aritmética está em
 * `money.ts`; nada aqui lê a base de dados.
 */
export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'
export type OrderStatus = 'DRAFT' | 'CONFIRMED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED'

export interface Issue {
  path: string
  code: string
  message: string
}

export const CURRENCY = /^[A-Z]{3}$/
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export const RATE = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/
export const QUANTITY = /^\d{1,13}(\.\d{1,6})?$/

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

/** Quantidade estritamente positiva em texto (nunca `number`). */
export const isPositiveQuantity = (value: unknown): value is string =>
  typeof value === 'string' && QUANTITY.test(value) && /[1-9]/.test(value)

// --- propostas --------------------------------------------------------------------------------------

/** Uma proposta enviada que passou da validade deixa de poder ser aceite: o estado é derivado, nunca gravado. */
export function effectiveQuoteStatus(
  status: QuoteStatus,
  validUntil: string,
  today: string
): QuoteStatus {
  return status === 'SENT' && validUntil < today ? 'EXPIRED' : status
}

export interface QuoteHeaderValues {
  organizationId: string
  customerId: string
  validUntil: string
  currency: string
  notes: string | null
}

export interface QuoteHeaderInput {
  organizationId?: unknown
  customerId?: unknown
  validUntil?: unknown
  currency?: unknown
  notes?: unknown
}

/** `defaultCurrency` (a do cliente) vale quando não há moeda nem base. A organização e o cliente não mudam depois de criada. */
export function normalizeQuoteHeader(
  input: QuoteHeaderInput,
  base: QuoteHeaderValues | null,
  defaultCurrency: string,
  today: string,
  issues: Issue[]
): QuoteHeaderValues | null {
  const before = issues.length
  const organizationId = base?.organizationId ?? input.organizationId
  const customerId = base?.customerId ?? input.customerId
  if (!base && typeof organizationId !== 'string') {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  if (!base && typeof customerId !== 'string') {
    issues.push(issue('customerId', 'REQUIRED', 'Indique o cliente.'))
  }
  const validUntil = input.validUntil === undefined ? base?.validUntil : input.validUntil
  if (!isIsoDate(validUntil)) {
    issues.push(issue('validUntil', 'INVALID_DATE', 'Validade: data AAAA-MM-DD.'))
  } else if (validUntil < today) {
    issues.push(issue('validUntil', 'IN_THE_PAST', 'A validade não pode estar no passado.'))
  }
  const currency = (
    input.currency === undefined ? (base?.currency ?? defaultCurrency) : input.currency
  ) as string
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda: três letras maiúsculas (ISO 4217).'))
  }
  let notes = base?.notes ?? null
  if (input.notes !== undefined) {
    notes =
      input.notes === null
        ? null
        : typeof input.notes === 'string'
          ? input.notes.trim() || null
          : null
    if (input.notes !== null && typeof input.notes !== 'string') {
      issues.push(issue('notes', 'INVALID_NOTES', 'Notas: texto.'))
    } else if (notes && notes.length > 1000) {
      issues.push(issue('notes', 'INVALID_NOTES', 'Notas: até 1000 caracteres.'))
    }
  }
  if (issues.length > before) return null
  return {
    organizationId: organizationId as string,
    customerId: customerId as string,
    validUntil: validUntil as string,
    currency,
    notes,
  }
}

const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  DRAFT: ['SENT'],
  SENT: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
}
export const canQuoteMove = (from: QuoteStatus, to: QuoteStatus): boolean =>
  QUOTE_TRANSITIONS[from].includes(to)

// --- encomendas -------------------------------------------------------------------------------------

export interface OrderHeaderValues {
  organizationId: string
  customerId: string
  orderDate: string
  currency: string
  deliveryAddress: Record<string, string> | null
}

export interface OrderHeaderInput {
  organizationId?: unknown
  customerId?: unknown
  orderDate?: unknown
  currency?: unknown
  deliveryAddress?: unknown
}

const ADDRESS_KEYS = [
  'line1',
  'line2',
  'city',
  'postalCode',
  'region',
  'countryCode',
  'recipient',
] as const

/** A morada de entrega é um instantâneo: texto simples por campo conhecido, copiado para a encomenda. */
export function normalizeAddress(value: unknown, issues: Issue[]): Record<string, string> | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push(issue('deliveryAddress', 'INVALID_ADDRESS', 'Morada: objecto com campos de texto.'))
    return null
  }
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      !(ADDRESS_KEYS as readonly string[]).includes(key) ||
      typeof raw !== 'string' ||
      raw.length > 200
    ) {
      issues.push(issue(`deliveryAddress.${key}`, 'INVALID_ADDRESS', 'Campo de morada inválido.'))
    } else if (raw.trim()) {
      result[key] = raw.trim()
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

export function normalizeOrderHeader(
  input: OrderHeaderInput,
  base: OrderHeaderValues | null,
  defaultCurrency: string,
  today: string,
  issues: Issue[]
): OrderHeaderValues | null {
  const before = issues.length
  const organizationId = base?.organizationId ?? input.organizationId
  const customerId = base?.customerId ?? input.customerId
  if (!base && typeof organizationId !== 'string') {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  if (!base && typeof customerId !== 'string') {
    issues.push(issue('customerId', 'REQUIRED', 'Indique o cliente.'))
  }
  const orderDate = input.orderDate === undefined ? (base?.orderDate ?? today) : input.orderDate
  if (!isIsoDate(orderDate)) {
    issues.push(issue('orderDate', 'INVALID_DATE', 'Data da encomenda: AAAA-MM-DD.'))
  }
  const currency = (
    input.currency === undefined ? (base?.currency ?? defaultCurrency) : input.currency
  ) as string
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda: três letras maiúsculas (ISO 4217).'))
  }
  const deliveryAddress =
    input.deliveryAddress === undefined
      ? (base?.deliveryAddress ?? null)
      : normalizeAddress(input.deliveryAddress, issues)
  if (issues.length > before) return null
  return {
    organizationId: organizationId as string,
    customerId: customerId as string,
    orderDate: orderDate as string,
    currency,
    deliveryAddress,
  }
}

/** Confirmar parte de DRAFT; cancelar de DRAFT ou CONFIRMED (com expedições lançadas não se cancela: PARTIAL/FULFILLED). */
export const canConfirm = (status: OrderStatus): boolean => status === 'DRAFT'
export const canCancel = (status: OrderStatus): boolean =>
  status === 'DRAFT' || status === 'CONFIRMED'

// --- linhas -----------------------------------------------------------------------------------------

export interface LineRequest {
  variantId: string
  quantity: string
  discountRate: string
}

export interface LineInput {
  variantId?: unknown
  quantity?: unknown
  discountRate?: unknown
}

/** Pedido de linha: variante, quantidade positiva e desconto 0..1, tudo em texto. O preço nunca vem do cliente. */
export function normalizeLineRequest(
  input: LineInput,
  base: LineRequest | null,
  issues: Issue[]
): LineRequest | null {
  const before = issues.length
  const variantId = base?.variantId ?? input.variantId
  if (!base && typeof variantId !== 'string') {
    issues.push(issue('variantId', 'REQUIRED', 'Indique a variante.'))
  }
  const quantity = input.quantity === undefined ? base?.quantity : input.quantity
  if (!isPositiveQuantity(quantity)) {
    issues.push(
      issue('quantity', 'INVALID_QUANTITY', 'Quantidade: decimal positivo em texto (até 6 casas).')
    )
  }
  const discountRate =
    input.discountRate === undefined ? (base?.discountRate ?? '0') : input.discountRate
  if (typeof discountRate !== 'string' || !RATE.test(discountRate)) {
    issues.push(
      issue(
        'discountRate',
        'INVALID_DISCOUNT',
        'Desconto: taxa entre 0 e 1 em texto (até 4 casas).'
      )
    )
  }
  if (issues.length > before) return null
  return {
    variantId: variantId as string,
    quantity: quantity as string,
    discountRate: discountRate as string,
  }
}

/** Percentagem de imposto: texto decimal não negativo com até 4 casas (a do cadastro de impostos). */
export const TAX_RATE = /^\d{1,3}(\.\d{1,4})?$/
