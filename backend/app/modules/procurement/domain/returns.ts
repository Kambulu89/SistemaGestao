import type { ErrorDetail } from '#shared/http/api_error'
import { divRound, isDate, parseScaled } from '#modules/procurement/domain/requisitions'

/*
 * Devoluções a fornecedor, não conformidades e notas de crédito (9.9) — regras puras.
 *
 *  Devolução (não conformidade de uma recepção confirmada): rascunho → confirmada (com evidência) | anulada. Por linha
 *  da recepção devolve-se o que foi **aceite** (estava em stock: sai pelo Inventário; deixa de contar como recebido) ou
 *  o que foi **recusado** na conferência (nunca entrou: só fica registado). Solução: substituição (a ordem volta a
 *  esperar a quantidade) ou crédito (a quantidade deixa de ser esperada; o que já estava facturado fica por creditar).
 *
 *  Nota de crédito (do fornecedor, sobre uma factura validada): por linha da factura, quantidade devolvida ao preço da
 *  factura (abate a quantidade facturada da ordem e, se ligada, o crédito pendente da devolução) ou ajuste de valor
 *  (só valor). O creditado nunca passa o facturado da linha (quantidade e valor).
 */

export const RETURN_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]
export const CREDIT_STATUSES = ['NOT_REQUIRED', 'PENDING', 'CREDITED'] as const
export type CreditStatus = (typeof CREDIT_STATUSES)[number]
export const RETURN_REASONS = [
  'QUALITY',
  'DAMAGED',
  'WRONG_ITEM',
  'EXPIRED',
  'QUANTITY',
  'DOCUMENTATION',
  'OTHER',
] as const
export type ReturnReason = (typeof RETURN_REASONS)[number]
export const REMEDIES = ['REPLACEMENT', 'CREDIT'] as const
export type Remedy = (typeof REMEDIES)[number]
export const RETURN_SOURCES = ['ACCEPTED', 'REFUSED'] as const
export type ReturnSource = (typeof RETURN_SOURCES)[number]
export const STOCK_BUCKETS = ['UNRESTRICTED', 'BLOCKED', 'QUARANTINE'] as const
export type StockBucket = (typeof STOCK_BUCKETS)[number]
export const RETURN_SERIES_TYPE = 'PURCHASE_RETURN'

export const CREDIT_NOTE_STATUSES = ['DRAFT', 'VALIDATED', 'CANCELLED'] as const
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number]
export const CREDIT_KINDS = ['QUANTITY', 'PRICE'] as const
export type CreditKind = (typeof CREDIT_KINDS)[number]
export const CREDIT_NOTE_SERIES_TYPE = 'PURCHASE_CREDIT_NOTE'

const uuid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)
const includes = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

export interface ReturnLineInput {
  receiptLineId: string
  source: ReturnSource
  quantity: bigint
  locationId: string | null
  bucket: StockBucket
  serials: string[]
  notes: string | null
}

/** Forma das linhas (a pertença à recepção e as quantidades disponíveis verificam-se no serviço). */
export function normalizeReturnLines(raw: unknown) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  if (list.length > 300)
    issues.push({ path: 'lines', code: 'TOO_MANY', message: 'Até 300 linhas.' })
  const seen = new Set<string>()
  const lines: ReturnLineInput[] = list.map((l: any, i: number) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${f}`, code, message })
    const receiptLineId = uuid(l?.receiptLineId)
    if (!receiptLineId) at('receiptLineId', 'REQUIRED', 'Linha da recepção.')
    const source: ReturnSource = includes(RETURN_SOURCES, l?.source) ? l.source : 'ACCEPTED'
    if (l?.source !== undefined && !includes(RETURN_SOURCES, l.source))
      at('source', 'INVALID', 'Aceite (estava em stock) ou recusada na conferência.')
    const k = `${receiptLineId}|${source}`
    if (receiptLineId && seen.has(k))
      at('receiptLineId', 'DUPLICATE', 'A mesma linha da recepção só uma vez por origem.')
    seen.add(k)
    const q = parseScaled(l?.quantity, 6)
    if (q === null || q <= 0n) at('quantity', 'INVALID', 'Quantidade maior que zero, até 6 casas.')
    const bucket: StockBucket = includes(STOCK_BUCKETS, l?.bucket) ? l.bucket : 'UNRESTRICTED'
    if (l?.bucket !== undefined && l?.bucket !== null && !includes(STOCK_BUCKETS, l.bucket))
      at('bucket', 'INVALID', 'Sai do livre, do bloqueado ou da quarentena.')
    const serials = Array.isArray(l?.serials)
      ? l.serials.map((s: unknown) => String(s).trim()).filter(Boolean)
      : []
    if (new Set(serials).size !== serials.length) at('serials', 'DUPLICATE', 'Séries repetidas.')
    const notes = typeof l?.notes === 'string' && l.notes.trim() ? l.notes.trim() : null
    if (notes && notes.length > 500) at('notes', 'LENGTH', 'Até 500 caracteres.')
    return {
      receiptLineId: receiptLineId ?? '',
      source,
      quantity: q ?? 0n,
      locationId: uuid(l?.locationId),
      bucket,
      serials,
      notes,
    }
  })
  return { lines, issues }
}

export function normalizeReturnHeader(input: Record<string, unknown>, today: string) {
  const issues: ErrorDetail[] = []
  const returnDate =
    input.returnDate === undefined || input.returnDate === '' ? today : input.returnDate
  if (!isDate(returnDate))
    issues.push({ path: 'returnDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  else if ((returnDate as string) > today)
    issues.push({
      path: 'returnDate',
      code: 'FUTURE',
      message: 'A devolução não pode ter data futura.',
    })
  const reasonCode = input.reasonCode
  if (!includes(RETURN_REASONS, reasonCode))
    issues.push({ path: 'reasonCode', code: 'REQUIRED', message: 'Indique o motivo.' })
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (description.length < 5 || description.length > 2000)
    issues.push({
      path: 'description',
      code: 'REQUIRED',
      message: 'Descreva a não conformidade (5 a 2000 caracteres).',
    })
  const remedy = input.remedy
  if (!includes(REMEDIES, remedy))
    issues.push({ path: 'remedy', code: 'REQUIRED', message: 'Substituição ou crédito.' })
  const carrierRef =
    typeof input.carrierRef === 'string' && input.carrierRef.trim() ? input.carrierRef.trim() : null
  if (carrierRef && carrierRef.length > 60)
    issues.push({ path: 'carrierRef', code: 'LENGTH', message: 'Até 60 caracteres.' })
  return {
    header: {
      returnDate: returnDate as string,
      reasonCode: reasonCode as ReturnReason,
      description,
      remedy: remedy as Remedy,
      carrierRef,
    },
    issues,
  }
}

/** Ainda devolvível de uma linha da recepção: aceite (ou recusado) menos o que outras devoluções já levaram. */
export const returnable = (received: bigint, alreadyReturned: bigint) =>
  received > alreadyReturned ? received - alreadyReturned : 0n

/**
 * Quanto de uma linha devolvida a crédito fica por creditar: o que, depois da devolução, está facturado acima do
 * recebido, até à quantidade devolvida. Substituição não fica por creditar (a mercadoria volta).
 */
export function creditNeed(p: {
  remedy: Remedy
  quantity: bigint
  invoiced: bigint
  receivedAfter: bigint
}) {
  if (p.remedy !== 'CREDIT') return 0n
  const over = p.invoiced - p.receivedAfter
  if (over <= 0n) return 0n
  return over < p.quantity ? over : p.quantity
}

/** Quanto deixa de ser esperado na ordem a crédito: a devolução toda, até ao que ainda falta receber. */
export function cancelOnCredit(p: { remedy: Remedy; quantity: bigint; openAfter: bigint }) {
  if (p.remedy !== 'CREDIT' || p.openAfter <= 0n) return 0n
  return p.openAfter < p.quantity ? p.openAfter : p.quantity
}

export function creditStatusOf(
  lines: { creditQuantity: bigint; credited: bigint }[]
): CreditStatus {
  const need = lines.some((l) => l.creditQuantity > 0n)
  if (!need) return 'NOT_REQUIRED'
  return lines.every((l) => l.credited >= l.creditQuantity) ? 'CREDITED' : 'PENDING'
}

export interface CreditLineInput {
  invoiceLineId: string
  kind: CreditKind
  quantity: bigint
  netAmount: bigint // cêntimos (só no ajuste de valor)
  returnLineId: string | null
}

export function normalizeCreditLines(raw: unknown) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  if (list.length > 300)
    issues.push({ path: 'lines', code: 'TOO_MANY', message: 'Até 300 linhas.' })
  const lines: CreditLineInput[] = list.map((l: any, i: number) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${f}`, code, message })
    const invoiceLineId = uuid(l?.invoiceLineId)
    if (!invoiceLineId) at('invoiceLineId', 'REQUIRED', 'Linha da factura.')
    const kind: CreditKind = includes(CREDIT_KINDS, l?.kind) ? l.kind : 'QUANTITY'
    if (l?.kind !== undefined && !includes(CREDIT_KINDS, l.kind))
      at('kind', 'INVALID', 'Quantidade devolvida ou ajuste de valor.')
    let quantity = 0n
    let netAmount = 0n
    if (kind === 'QUANTITY') {
      const q = parseScaled(l?.quantity, 6)
      if (q === null || q <= 0n)
        at('quantity', 'INVALID', 'Quantidade maior que zero, até 6 casas.')
      quantity = q ?? 0n
    } else {
      const v = parseScaled(l?.netAmount, 2)
      if (v === null || v <= 0n)
        at('netAmount', 'INVALID', 'Valor líquido maior que zero, até 2 casas.')
      netAmount = v ?? 0n
    }
    const returnLineId = uuid(l?.returnLineId)
    if (returnLineId && kind !== 'QUANTITY')
      at('returnLineId', 'NOT_ALLOWED', 'Só a quantidade devolvida se liga a uma devolução.')
    return { invoiceLineId: invoiceLineId ?? '', kind, quantity, netAmount, returnLineId }
  })
  return { lines, issues }
}

/**
 * Valores de uma linha de crédito pela linha da factura (cêntimos; taxa com 3 casas). Quantidade: líquido da factura
 * × quantidade ÷ quantidade facturada — a que fecha a linha leva o resto exacto (sem cêntimos perdidos). Imposto à taxa
 * da linha da factura; o que fecha o valor da linha leva o imposto que resta.
 */
export function creditAmounts(p: {
  kind: CreditKind
  quantity: bigint
  netAmount: bigint
  invoice: { quantity: bigint; net: bigint; tax: bigint; taxRate: bigint }
  before: { quantity: bigint; net: bigint; tax: bigint }
}) {
  let net: bigint
  if (p.kind === 'QUANTITY')
    net =
      p.before.quantity + p.quantity === p.invoice.quantity
        ? p.invoice.net - p.before.net
        : divRound(p.invoice.net * p.quantity, p.invoice.quantity)
  else net = p.netAmount
  const closes = p.before.net + net === p.invoice.net
  const raw = closes ? p.invoice.tax - p.before.tax : divRound(net * p.invoice.taxRate, 100_000n)
  const tax = raw < 0n ? 0n : raw
  return { net, tax, total: net + tax }
}

export { isDate }
