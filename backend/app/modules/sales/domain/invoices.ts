import { createHash } from 'node:crypto'
import type { ErrorDetail } from '#shared/http/api_error'
import {
  divRound,
  parseScaled,
  PCT_SCALE,
  PRICE_SCALE,
  QTY_SCALE,
  scaledText,
} from '#modules/sales/domain/pricing'

/*
 * Facturas de venda (10.6) — regras puras.
 *
 *  - Estados distintos: negócio (rascunho → emitida → corrigida; rascunho descartado), fiscal (pendente na emissão;
 *    aceite, rejeitada ou contingência pela integração do 10.9) e cobrança (por pagar → parcial → paga, pelos recibos
 *    do 10.7). "Vencida" calcula-se: emitida, não paga e com o vencimento ultrapassado.
 *  - Emitida é imutável (gatilho): a correcção faz-se por nota de crédito/débito (10.8).
 *  - Produtos de stock só se facturam a partir de uma encomenda (o que foi expedido e ainda não facturado); sem
 *    encomenda, só serviços — assim o stock nunca fica por movimentar nem é movimentado duas vezes.
 *  - Valores: preço unitário com 4 casas, quantidade com 6, valor da linha = quantidade × preço arredondado a 2 casas.
 */

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'CORRECTED', 'DISCARDED'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
export const FISCAL_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'CONTINGENCY'] as const
export const COLLECTION_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE'] as const

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const optional = (v: unknown) => {
  const t = text(v)
  return t === '' || t === undefined || t === null ? null : t
}

export function normalizeInvoiceHeader(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  for (const k of ['legalEntityId', 'customerId'] as const)
    if (k in input || creating) {
      if (typeof input[k] !== 'string' || !UUID.test(input[k] as string))
        issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      else v[k] = input[k]
    }
  if ('branchId' in input) {
    const b = optional(input.branchId)
    if (b !== null && (typeof b !== 'string' || !UUID.test(b)))
      issues.push({ path: 'branchId', code: 'INVALID', message: 'Estabelecimento inválido.' })
    else v.branchId = b
  }
  if ('invoiceDate' in input || creating) {
    if (typeof input.invoiceDate !== 'string' || !DATE.test(input.invoiceDate))
      issues.push({ path: 'invoiceDate', code: 'INVALID', message: 'Data obrigatória.' })
    else v.invoiceDate = input.invoiceDate
  }
  if ('currency' in input) {
    const c = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
    if (!/^[A-Z]{3}$/.test(c))
      issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: código ISO de 3 letras.' })
    else v.currency = c
  }
  if ('paymentTermsDays' in input) {
    const n = Number(input.paymentTermsDays)
    if (!Number.isInteger(n) || n < 0 || n > 365)
      issues.push({ path: 'paymentTermsDays', code: 'INVALID', message: 'Prazo de 0 a 365 dias.' })
    else v.paymentTermsDays = n
  }
  for (const [k, max] of [
    ['customerReference', 60],
    ['notes', 2000],
  ] as const)
    if (k in input) {
      const x = optional(input[k])
      if (x !== null && (typeof x !== 'string' || x.length > max))
        issues.push({ path: k, code: 'LENGTH', message: `Até ${max} caracteres.` })
      else v[k] = x
    }
  return { v, issues }
}

export interface InvoiceLineInput {
  productId: string
  variantId: string | null
  description: string | null
  quantity: string
  manualDiscountPct: string | null
  manualUnitPrice: string | null
  taxCodeIds: string[]
  exemptionCode: string | null
  orderLineId: string | null
}

/** Linhas (substituem as anteriores em rascunho). `fromOrder`: cada linha traz a linha da encomenda. */
export function normalizeInvoiceLines(raw: unknown, fromOrder: boolean) {
  const issues: ErrorDetail[] = []
  const lines: InvoiceLineInput[] = []
  if (!Array.isArray(raw) || raw.length > 200) {
    issues.push({ path: 'lines', code: 'INVALID', message: 'Até 200 linhas.' })
    return { lines, issues }
  }
  raw.forEach((l: any, i) => {
    const p = (k: string) => `lines.${i}.${k}`
    const at = issues.length
    const orderLineId = optional(l?.orderLineId)
    if (fromOrder && (typeof orderLineId !== 'string' || !UUID.test(orderLineId)))
      issues.push({ path: p('orderLineId'), code: 'REQUIRED', message: 'Linha da encomenda.' })
    if (!fromOrder && orderLineId !== null)
      issues.push({
        path: p('orderLineId'),
        code: 'NOT_ALLOWED',
        message: 'Sem encomenda de origem.',
      })
    if (!fromOrder && (typeof l?.productId !== 'string' || !UUID.test(l.productId)))
      issues.push({
        path: p('productId'),
        code: 'REQUIRED',
        message: 'Escolha o produto ou serviço.',
      })
    const variantId = optional(l?.variantId)
    if (variantId !== null && (typeof variantId !== 'string' || !UUID.test(variantId)))
      issues.push({ path: p('variantId'), code: 'INVALID', message: 'Variante inválida.' })
    const description = optional(l?.description)
    if (description !== null && (typeof description !== 'string' || description.length > 300))
      issues.push({ path: p('description'), code: 'LENGTH', message: 'Até 300 caracteres.' })
    const q = parseScaled(l?.quantity, QTY_SCALE)
    if (q === null || q === 0n)
      issues.push({
        path: p('quantity'),
        code: 'INVALID',
        message: 'Quantidade maior que 0, até 6 casas.',
      })
    const md = fromOrder ? null : optional(l?.manualDiscountPct)
    const mdv = md === null ? null : parseScaled(md, PCT_SCALE)
    if (md !== null && (mdv === null || mdv > 10_000n))
      issues.push({
        path: p('manualDiscountPct'),
        code: 'INVALID',
        message: 'Desconto de 0 a 100, 2 casas.',
      })
    const mp = fromOrder ? null : optional(l?.manualUnitPrice)
    const mpv = mp === null ? null : parseScaled(mp, PRICE_SCALE)
    if (mp !== null && mpv === null)
      issues.push({
        path: p('manualUnitPrice'),
        code: 'INVALID',
        message: 'Preço ≥ 0, até 4 casas.',
      })
    if (md !== null && mp !== null)
      issues.push({
        path: p('manualUnitPrice'),
        code: 'INVALID',
        message: 'Desconto ou preço manual, não os dois.',
      })
    const codes = Array.isArray(l?.taxCodeIds) ? [...new Set(l.taxCodeIds as unknown[])] : []
    if (
      !codes.length ||
      codes.length > 5 ||
      codes.some((c) => typeof c !== 'string' || !UUID.test(c))
    )
      issues.push({
        path: p('taxCodeIds'),
        code: 'REQUIRED',
        message: 'Indique o imposto da linha (até 5).',
      })
    const ex = optional(l?.exemptionCode)
    if (ex !== null && (typeof ex !== 'string' || ex.length > 20))
      issues.push({
        path: p('exemptionCode'),
        code: 'INVALID',
        message: 'Código de isenção inválido.',
      })
    if (issues.length > at) return
    lines.push({
      productId: l?.productId ?? null,
      variantId: variantId as string | null,
      description: description as string | null,
      quantity: scaledText(q!, QTY_SCALE),
      manualDiscountPct: mdv === null ? null : scaledText(mdv, PCT_SCALE),
      manualUnitPrice: mpv === null ? null : scaledText(mpv, PRICE_SCALE),
      taxCodeIds: codes as string[],
      exemptionCode: ex === null ? null : (ex as string).toUpperCase(),
      orderLineId: orderLineId as string | null,
    })
  })
  return { lines, issues }
}

/** Valor da linha: quantidade × preço unitário, a 2 casas. */
export function lineNet(quantity: string, unitPrice: string) {
  const q = parseScaled(quantity, QTY_SCALE)!
  const p = parseScaled(unitPrice, PRICE_SCALE)!
  return scaledText(divRound(q * p, 10n ** BigInt(QTY_SCALE + PRICE_SCALE - 2)), 2)
}

/** Desconto total em percentagem (4 casas) entre o preço base e o líquido. */
export function effectiveDiscount(basePrice: string | null, netUnitPrice: string) {
  if (basePrice === null) return '0.0000'
  const b = parseScaled(basePrice, PRICE_SCALE)!
  const n = parseScaled(netUnitPrice, PRICE_SCALE)!
  if (b === 0n || n >= b) return '0.0000'
  return scaledText(divRound((b - n) * 1_000_000n, b), 4)
}

export const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`)
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}

/** Estado de cobrança mostrado (vencida calcula-se na data). */
export function collectionView(
  status: string,
  collection: string | null,
  dueDate: string | null,
  today: string
) {
  if (status !== 'ISSUED' && status !== 'CORRECTED') return null
  if (collection !== 'PAID' && dueDate && dueDate < today) return 'OVERDUE'
  return collection
}

/** Impressão digital do conteúdo emitido (JSON canónico, chaves ordenadas): controlo interno de integridade. */
export function documentHash(content: unknown) {
  const canon = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(canon)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x as object)
              .sort()
              .map((k) => [k, canon((x as any)[k])])
          )
        : x
  return createHash('sha256')
    .update(JSON.stringify(canon(content)))
    .digest('hex')
}
