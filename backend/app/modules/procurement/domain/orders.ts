import type { ErrorDetail } from '#shared/http/api_error'
import { divRound, isDate, parseScaled } from '#modules/procurement/domain/requisitions'

/*
 * Ordens de compra (9.5) — regras puras.
 *
 *  Três estados independentes:
 *   - aprovação: rascunho → em aprovação (câmbio e etapas fixados pelo total funcional) → aprovada | recusada (volta a
 *     editar-se); anulada é final. Uma revisão de uma ordem emitida volta a rascunho com a revisão seguinte.
 *   - recepção: não recebida → parcialmente recebida → recebida (pelas quantidades recebidas + canceladas; 9.7).
 *   - facturação: não facturada → parcialmente facturada → facturada (9.8).
 *  Emissão: só aprovada; a primeira dá o número; cada revisão aprovada volta a emitir-se com o mesmo número.
 *
 *  Valores da linha (exactos, meio para cima ao cêntimo): bruto = quantidade × preço; desconto = bruto × taxa;
 *  líquido = bruto − desconto; imposto = líquido × taxa de imposto; total = líquido + imposto.
 */

export const APPROVAL_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export const RECEIPT_STATUSES = ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIVED'] as const
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]
export const INVOICE_STATUSES = ['NOT_INVOICED', 'PARTIALLY_INVOICED', 'INVOICED'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
export const PAYMENT_METHODS = ['TRANSFER', 'CHEQUE', 'CASH', 'OTHER'] as const
export const ORDER_SERIES_TYPE = 'PURCHASE_ORDER'

export const EDITABLE: readonly ApprovalStatus[] = ['DRAFT', 'REJECTED']

const Q = 10n ** 6n

export function orderLineAmounts(
  quantity: bigint,
  unitPrice: bigint,
  discountRate: bigint,
  taxRate: bigint
) {
  const gross = divRound(quantity * unitPrice * 100n, Q * Q)
  const discount = divRound(gross * discountRate, 100_000n)
  const net = gross - discount
  const tax = divRound(net * taxRate, 100_000n)
  return { gross, discount, net, tax, total: net + tax }
}

/** Estado de recepção pelas linhas: recebida quando recebido + cancelado cobre tudo e algo foi recebido. */
export function receiptStatus(
  lines: { quantity: bigint; received: bigint; cancelled: bigint }[]
): ReceiptStatus {
  const any = lines.some((l) => l.received > 0n)
  if (!any) return 'NOT_RECEIVED'
  return lines.every((l) => l.received + l.cancelled >= l.quantity)
    ? 'RECEIVED'
    : 'PARTIALLY_RECEIVED'
}

/** Estado de facturação: facturada quando o facturado cobre o que é devido (encomendado − cancelado). */
export function invoiceStatus(
  lines: { quantity: bigint; invoiced: bigint; cancelled: bigint }[]
): InvoiceStatus {
  const any = lines.some((l) => l.invoiced > 0n)
  if (!any) return 'NOT_INVOICED'
  return lines.every((l) => l.invoiced >= l.quantity - l.cancelled)
    ? 'INVOICED'
    : 'PARTIALLY_INVOICED'
}

/** O que pode fazer-se a seguir, pelos três estados. */
export function orderCan(o: {
  approval: ApprovalStatus
  issuedRevision: number | null
  revision: number
  receipt: ReceiptStatus
  invoice: InvoiceStatus
  closed: boolean
  hasMovement: boolean
}) {
  const issuedCurrent = o.issuedRevision !== null && o.issuedRevision === o.revision
  const live = o.approval !== 'CANCELLED' && !o.closed
  return {
    edit: live && EDITABLE.includes(o.approval),
    submit: live && EDITABLE.includes(o.approval),
    decide: live && o.approval === 'PENDING_APPROVAL',
    issue: live && o.approval === 'APPROVED' && !issuedCurrent,
    revise: live && o.approval === 'APPROVED' && issuedCurrent && o.receipt !== 'RECEIVED',
    close: live && o.approval === 'APPROVED' && issuedCurrent && o.receipt === 'PARTIALLY_RECEIVED',
    cancel: live && !o.hasMovement && o.invoice === 'NOT_INVOICED',
  }
}

export interface OrderLineInput {
  id: string | null
  productId: string | null
  variantId: string | null
  description: string
  uomId: string | null
  quantity: bigint
  unitPrice: bigint
  discountRate: bigint
  taxRate: bigint
  expectedDate: string | null
  requisitionLineId: string | null
  notes: string | null
}

/** Validação de forma das linhas (o que depende da base — produtos, unidades, requisições — é do serviço). */
export function normalizeOrderLines(raw: unknown) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  if (list.length > 300)
    issues.push({ path: 'lines', code: 'TOO_MANY', message: 'Até 300 linhas.' })
  const uuid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)
  const lines: OrderLineInput[] = list.map((l: any, i: number) => {
    const at = (field: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${field}`, code, message })
    const q = parseScaled(l?.quantity, 6)
    if (q === null || q <= 0n) at('quantity', 'INVALID', 'Quantidade maior que zero, até 6 casas.')
    const p = parseScaled(l?.unitPrice ?? '', 6)
    if (p === null) at('unitPrice', 'INVALID', 'Preço ≥ 0, até 6 casas, em texto.')
    const d = parseScaled(l?.discountRate ?? '0', 3)
    if (d === null || d > 100_000n) at('discountRate', 'INVALID', 'Desconto entre 0 e 100%.')
    const t = parseScaled(l?.taxRate ?? '0', 3)
    if (t === null || t > 100_000n) at('taxRate', 'INVALID', 'Imposto entre 0 e 100%.')
    const exp = l?.expectedDate ? l.expectedDate : null
    if (exp !== null && !isDate(exp)) at('expectedDate', 'INVALID', 'Data AAAA-MM-DD.')
    const description = typeof l?.description === 'string' ? l.description.trim() : ''
    if (description.length > 300) at('description', 'LENGTH', 'Até 300 caracteres.')
    const notes = typeof l?.notes === 'string' && l.notes.trim() ? l.notes.trim() : null
    if (notes && notes.length > 500) at('notes', 'LENGTH', 'Até 500 caracteres.')
    return {
      id: uuid(l?.id),
      productId: uuid(l?.productId),
      variantId: uuid(l?.variantId),
      description,
      uomId: uuid(l?.uomId),
      quantity: q ?? 0n,
      unitPrice: p ?? 0n,
      discountRate: d ?? 0n,
      taxRate: t ?? 0n,
      expectedDate: exp,
      requisitionLineId: uuid(l?.requisitionLineId),
      notes,
    }
  })
  const ids = lines.map((l) => l.id).filter((x): x is string => !!x)
  if (new Set(ids).size !== ids.length)
    issues.push({ path: 'lines', code: 'DUPLICATE', message: 'A mesma linha só uma vez.' })
  return { lines, issues }
}

/** Afectação à requisição a acertar na emissão: o encomendado em vigor (quantidade − cancelado) menos o já afectado. */
export const allocationDelta = (quantity: bigint, cancelled: bigint, allocated: bigint) =>
  quantity - cancelled - allocated
