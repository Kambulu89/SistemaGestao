import type { ErrorDetail } from '#shared/http/api_error'
import { divRound, isDate, parseScaled } from '#modules/procurement/domain/requisitions'

/*
 * Facturas de fornecedor e conferência a três (9.8) — regras puras.
 *
 *  Estados: rascunho → (validar) → validada, se não há divergências; senão → com excepção pendente → validada (outra
 *  pessoa autoriza, com motivo) | de volta a rascunho (excepção recusada). Recusada (factura devolvida ao fornecedor) e
 *  anulada são finais. Validada não muda: corrige-se por nota de crédito (9.9).
 *
 *  Conferência por linha da ordem (na unidade da ordem):
 *   - QTY_OVER_RECEIVED: já facturado + esta quantidade > recebido/aceite × (1 + tolerância de quantidade);
 *   - PRICE_OVER_ORDER: preço líquido unitário (com desconto) acima do da ordem, para lá da tolerância (percentagem
 *     OU valor da linha — basta uma das duas para aceitar);
 *   - TAX_MISMATCH: taxa de imposto diferente da da ordem;
 *   - UNMATCHED_LINE: encargo sem linha da ordem.
 *  Cabeçalho: TOTAL_MISMATCH quando |total declarado − soma das linhas| > tolerância de total.
 *  Preço abaixo do da ordem e quantidade abaixo do recebido não são divergências.
 */

export const INVOICE_STATUSES = [
  'DRAFT',
  'PENDING_EXCEPTION',
  'VALIDATED',
  'REJECTED',
  'CANCELLED',
] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
export const INVOICE_SERIES_TYPE = 'PURCHASE_INVOICE'
export const DIVERGENCE_CODES = [
  'QTY_OVER_RECEIVED',
  'PRICE_OVER_ORDER',
  'TAX_MISMATCH',
  'UNMATCHED_LINE',
  'TOTAL_MISMATCH',
] as const
export type DivergenceCode = (typeof DIVERGENCE_CODES)[number]

export interface Tolerances {
  pricePct: bigint // 3 casas (2,5% = 2 500)
  priceAmount: bigint // cêntimos
  qtyPct: bigint // 3 casas
  totalAmount: bigint // cêntimos
}
export const NO_TOLERANCE: Tolerances = {
  pricePct: 0n,
  priceAmount: 0n,
  qtyPct: 0n,
  totalAmount: 0n,
}

export function normalizeTolerances(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const pct = (k: string) => {
    const v = parseScaled(input[k] ?? '0', 3)
    if (v === null || v > 100_000n) {
      issues.push({ path: k, code: 'INVALID', message: 'Percentagem de 0 a 100, até 3 casas.' })
      return 0n
    }
    return v
  }
  const amount = (k: string) => {
    const v = parseScaled(input[k] ?? '0', 2)
    if (v === null) {
      issues.push({ path: k, code: 'INVALID', message: 'Valor ≥ 0, até 2 casas, em texto.' })
      return 0n
    }
    return v
  }
  return {
    tolerances: {
      pricePct: pct('pricePct'),
      priceAmount: amount('priceAmount'),
      qtyPct: pct('qtyPct'),
      totalAmount: amount('totalAmount'),
    } satisfies Tolerances,
    issues,
  }
}

/** Chave do número externo para a unicidade: maiúsculas, sem espaços. */
export const invoiceNumberKey = (n: string) => n.trim().toUpperCase().replace(/\s+/g, '')

const Q = 10n ** 6n

/** Preço líquido unitário (6 casas) a partir do líquido da linha (cêntimos) e da quantidade (6 casas). */
export const netUnit = (netCents: bigint, quantity: bigint) =>
  quantity === 0n ? 0n : divRound(netCents * 10_000n * Q, quantity)

export interface Divergence {
  code: DivergenceCode
  lineNo: number | null
  message: string
  details: Record<string, string>
}

export interface LineFacts {
  lineNo: number
  orderLineId: string | null
  quantity: bigint
  netCents: bigint
  taxRate: bigint
  order: {
    quantity: bigint
    received: bigint
    invoiced: bigint
    netCents: bigint
    taxRate: bigint
  } | null
}

const txt6 = (v: bigint) => {
  const neg = v < 0n
  const a = neg ? -v : v
  const s = `${a / Q}.${(a % Q).toString().padStart(6, '0')}`
  return neg ? `-${s}` : s
}
const txt2 = (v: bigint) => {
  const neg = v < 0n
  const a = neg ? -v : v
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
  return neg ? `-${s}` : s
}

/** Conferência a três de uma linha. */
export function matchLine(l: LineFacts, tol: Tolerances): Divergence[] {
  const out: Divergence[] = []
  if (!l.order) {
    out.push({
      code: 'UNMATCHED_LINE',
      lineNo: l.lineNo,
      message: `Linha ${l.lineNo}: encargo sem linha na ordem.`,
      details: { amount: txt2(l.netCents) },
    })
    return out
  }
  const allowed = l.order.received + divRound(l.order.received * tol.qtyPct, 100_000n)
  if (l.order.invoiced + l.quantity > allowed)
    out.push({
      code: 'QTY_OVER_RECEIVED',
      lineNo: l.lineNo,
      message: `Linha ${l.lineNo}: facturado ${txt6(l.order.invoiced + l.quantity)} acima do recebido ${txt6(l.order.received)}.`,
      details: {
        received: txt6(l.order.received),
        invoicedBefore: txt6(l.order.invoiced),
        quantity: txt6(l.quantity),
      },
    })
  const invUnit = netUnit(l.netCents, l.quantity)
  const poUnit = netUnit(l.order.netCents, l.order.quantity)
  const diff = invUnit - poUnit
  if (diff > 0n) {
    const pctOk = poUnit > 0n && diff * 100_000n <= poUnit * tol.pricePct
    // Diferença da linha em cêntimos: diferença unitária (6 casas) × quantidade (6 casas) → cêntimos.
    const lineDiff = divRound(diff * l.quantity, Q * 10_000n)
    const amountOk = tol.priceAmount > 0n && lineDiff <= tol.priceAmount
    if (!pctOk && !amountOk)
      out.push({
        code: 'PRICE_OVER_ORDER',
        lineNo: l.lineNo,
        message: `Linha ${l.lineNo}: preço ${txt6(invUnit)} acima do da ordem ${txt6(poUnit)}.`,
        details: {
          invoiceUnit: txt6(invUnit),
          orderUnit: txt6(poUnit),
          lineDifference: txt2(lineDiff),
        },
      })
  }
  if (l.taxRate !== l.order.taxRate)
    out.push({
      code: 'TAX_MISMATCH',
      lineNo: l.lineNo,
      message: `Linha ${l.lineNo}: imposto diferente do da ordem.`,
      details: {
        invoiceRate: (Number(l.taxRate) / 1000).toFixed(3),
        orderRate: (Number(l.order.taxRate) / 1000).toFixed(3),
      },
    })
  return out
}

/** Conferência do cabeçalho: total declarado contra a soma das linhas. */
export function matchTotal(declared: bigint, computed: bigint, tol: Tolerances): Divergence[] {
  const diff = declared > computed ? declared - computed : computed - declared
  return diff > tol.totalAmount
    ? [
        {
          code: 'TOTAL_MISMATCH',
          lineNo: null,
          message: `O total declarado (${txt2(declared)}) difere da soma das linhas (${txt2(computed)}).`,
          details: { declared: txt2(declared), computed: txt2(computed) },
        },
      ]
    : []
}

export interface InvoiceLineInput {
  orderLineId: string | null
  description: string
  quantity: bigint
  unitPrice: bigint
  discountRate: bigint
  taxRate: bigint
}

const uuid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)

export function normalizeInvoiceLines(raw: unknown) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  if (list.length > 300)
    issues.push({ path: 'lines', code: 'TOO_MANY', message: 'Até 300 linhas.' })
  const seen = new Set<string>()
  const lines: InvoiceLineInput[] = list.map((l: any, i: number) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${f}`, code, message })
    const orderLineId = uuid(l?.orderLineId)
    if (orderLineId) {
      if (seen.has(orderLineId))
        at('orderLineId', 'DUPLICATE', 'A mesma linha da ordem só uma vez.')
      seen.add(orderLineId)
    }
    const q = parseScaled(l?.quantity, 6)
    if (q === null || q <= 0n) at('quantity', 'INVALID', 'Quantidade maior que zero, até 6 casas.')
    const p = parseScaled(l?.unitPrice ?? '', 6)
    if (p === null) at('unitPrice', 'INVALID', 'Preço ≥ 0, até 6 casas, em texto.')
    const d = parseScaled(l?.discountRate ?? '0', 3)
    if (d === null || d > 100_000n) at('discountRate', 'INVALID', 'Desconto entre 0 e 100%.')
    const t = parseScaled(l?.taxRate ?? '0', 3)
    if (t === null || t > 100_000n) at('taxRate', 'INVALID', 'Imposto entre 0 e 100%.')
    const description = typeof l?.description === 'string' ? l.description.trim() : ''
    if (!orderLineId && description.length < 3)
      at('description', 'REQUIRED', 'Descreva o encargo (3 a 300 caracteres).')
    if (description.length > 300) at('description', 'LENGTH', 'Até 300 caracteres.')
    return {
      orderLineId,
      description,
      quantity: q ?? 0n,
      unitPrice: p ?? 0n,
      discountRate: d ?? 0n,
      taxRate: t ?? 0n,
    }
  })
  return { lines, issues }
}

/** Vencimento: data da factura + prazo de pagamento (dias). */
export function dueDate(invoiceDate: string, days: number) {
  const d = new Date(`${invoiceDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export { isDate }
