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
 * Orçamentos e propostas (10.3) — regras puras.
 *
 * Ciclo: rascunho → submetido. Sem linhas acima do limite de desconto (nem preço manual), fica aprovado logo; com elas,
 * fica para aprovação de outra pessoa (`sales.quotes.approve`), que aprova ou devolve com motivo. Aprovado → enviado
 * (recebe número na primeira vez e a versão enviada fica fotografada) → aceite ou recusado pelo cliente. Uma revisão
 * (de aprovado, enviado ou recusado) volta a rascunho com a versão seguinte, mantendo o número. Anula-se com motivo
 * antes de aceite. Aceite → convertido numa encomenda, uma única vez (10.4).
 *
 * Imposto por linha (taxa e motivo de isenção quando 0 %) até ao motor fiscal do 10.5: imposto = valor líquido × taxa,
 * arredondado a 2 casas por linha; totais = soma das linhas.
 */

export const QUOTE_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'CANCELLED',
  'CONVERTED',
] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]
export const SEND_CHANNELS = ['EMAIL', 'HAND', 'PORTAL', 'OTHER'] as const
export const SERIES_TYPE = 'SALES_QUOTE'
export const MAX_LINES = 200

/** Estados de onde cada acção parte. */
export const CAN: Record<string, readonly QuoteStatus[]> = {
  edit: ['DRAFT'],
  submit: ['DRAFT'],
  approve: ['PENDING_APPROVAL'],
  reject: ['PENDING_APPROVAL'],
  send: ['APPROVED', 'SENT'],
  accept: ['SENT'],
  decline: ['SENT'],
  revise: ['APPROVED', 'SENT', 'DECLINED'],
  cancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'],
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const optional = (v: unknown) => {
  const t = text(v)
  return t === '' || t === undefined || t === null ? null : t
}

/** Expirado: enviado e com a validade ultrapassada na data dada (o estado guardado continua "enviado"). */
export const isExpired = (status: string, validUntil: string, today: string) =>
  status === 'SENT' && validUntil < today

/** Cabeçalho (só os campos enviados; ao criar, os obrigatórios). */
export function normalizeHeader(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  for (const k of ['legalEntityId', 'customerId'] as const)
    if (k in input || creating) {
      if (typeof input[k] !== 'string' || !UUID.test(input[k] as string))
        issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      else v[k] = input[k]
    }
  if ('salespersonMembershipId' in input) {
    const s = optional(input.salespersonMembershipId)
    if (s !== null && (typeof s !== 'string' || !UUID.test(s)))
      issues.push({
        path: 'salespersonMembershipId',
        code: 'INVALID',
        message: 'Comercial inválido.',
      })
    else v.salespersonMembershipId = s
  }
  for (const k of ['quoteDate', 'validUntil'] as const)
    if (k in input || creating) {
      if (typeof input[k] !== 'string' || !DATE.test(input[k] as string))
        issues.push({ path: k, code: 'INVALID', message: 'Data obrigatória.' })
      else v[k] = input[k]
    }
  if (v.quoteDate && v.validUntil && (v.validUntil as string) < (v.quoteDate as string))
    issues.push({
      path: 'validUntil',
      code: 'INVALID',
      message: 'A validade não pode ser antes da data.',
    })
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
  if ('customerReference' in input) {
    const r = optional(input.customerReference)
    if (r !== null && (typeof r !== 'string' || r.length > 60))
      issues.push({ path: 'customerReference', code: 'LENGTH', message: 'Até 60 caracteres.' })
    else v.customerReference = r
  }
  if ('notes' in input) {
    const n = optional(input.notes)
    if (n !== null && (typeof n !== 'string' || n.length > 2000))
      issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 2000 caracteres.' })
    else v.notes = n
  }
  return { v, issues }
}

export interface LineInput {
  productId: string
  variantId: string | null
  description: string | null
  quantity: string
  manualDiscountPct: string | null
  manualUnitPrice: string | null
  taxRate: string
  taxExemptionReason: string | null
}

/** Linhas completas (substituem as anteriores em rascunho). */
export function normalizeLines(raw: unknown) {
  const issues: ErrorDetail[] = []
  const lines: LineInput[] = []
  if (!Array.isArray(raw) || raw.length > MAX_LINES) {
    issues.push({ path: 'lines', code: 'INVALID', message: `Até ${MAX_LINES} linhas.` })
    return { lines, issues }
  }
  raw.forEach((l: any, i) => {
    const p = (k: string) => `lines.${i}.${k}`
    const at = issues.length
    if (typeof l?.productId !== 'string' || !UUID.test(l.productId))
      issues.push({ path: p('productId'), code: 'REQUIRED', message: 'Escolha o produto.' })
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
    const md = optional(l?.manualDiscountPct)
    const mdv = md === null ? null : parseScaled(md, PCT_SCALE)
    if (md !== null && (mdv === null || mdv > 10_000n))
      issues.push({
        path: p('manualDiscountPct'),
        code: 'INVALID',
        message: 'Desconto de 0 a 100, 2 casas.',
      })
    const mp = optional(l?.manualUnitPrice)
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
    const t = parseScaled(l?.taxRate, PCT_SCALE)
    if (t === null || t > 10_000n)
      issues.push({
        path: p('taxRate'),
        code: 'INVALID',
        message: 'Taxa de imposto de 0 a 100, 2 casas.',
      })
    const ex = optional(l?.taxExemptionReason)
    if (t === 0n && (typeof ex !== 'string' || ex.length < 3))
      issues.push({
        path: p('taxExemptionReason'),
        code: 'REQUIRED',
        message: 'Sem imposto: indique o motivo da isenção.',
      })
    if (ex !== null && (typeof ex !== 'string' || ex.length > 300))
      issues.push({ path: p('taxExemptionReason'), code: 'LENGTH', message: 'Até 300 caracteres.' })
    if (issues.length > at) return
    lines.push({
      productId: l.productId,
      variantId: variantId as string | null,
      description: description as string | null,
      quantity: scaledText(q!, QTY_SCALE),
      manualDiscountPct: mdv === null ? null : scaledText(mdv, PCT_SCALE),
      manualUnitPrice: mpv === null ? null : scaledText(mpv, PRICE_SCALE),
      taxRate: scaledText(t!, PCT_SCALE),
      taxExemptionReason: t === 0n ? (ex as string) : null,
    })
  })
  return { lines, issues }
}

/** Imposto e total de uma linha (valores em texto com 2 casas). */
export function lineTotals(netAmount: string | null, taxRate: string) {
  const net = netAmount === null ? 0n : parseScaled(netAmount, 2)!
  const rate = parseScaled(taxRate, PCT_SCALE)!
  const tax = divRound(net * rate, 10_000n)
  return { net: scaledText(net, 2), tax: scaledText(tax, 2), gross: scaledText(net + tax, 2) }
}

/** Soma de valores com 2 casas. */
export function sum(values: string[]) {
  return scaledText(
    values.reduce((a, v) => a + parseScaled(v, 2)!, 0n),
    2
  )
}

export function normalizeSend(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const channel = input.channel
  if (!(SEND_CHANNELS as readonly unknown[]).includes(channel))
    issues.push({
      path: 'channel',
      code: 'INVALID',
      message: 'Canal: e-mail, em mão, portal ou outro.',
    })
  const sentTo = optional(input.sentTo)
  if (sentTo !== null && (typeof sentTo !== 'string' || sentTo.length > 200))
    issues.push({ path: 'sentTo', code: 'LENGTH', message: 'Até 200 caracteres.' })
  if (
    channel === 'EMAIL' &&
    (typeof sentTo !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sentTo))
  )
    issues.push({ path: 'sentTo', code: 'INVALID', message: 'Indique o e-mail do destinatário.' })
  const seriesId = optional(input.seriesId)
  if (seriesId !== null && (typeof seriesId !== 'string' || !UUID.test(seriesId)))
    issues.push({ path: 'seriesId', code: 'INVALID', message: 'Série inválida.' })
  return {
    channel: channel as string,
    sentTo: sentTo as string | null,
    seriesId: seriesId as string | null,
    issues,
  }
}

export function normalizeDecision(input: Record<string, unknown>, accept: boolean) {
  const issues: ErrorDetail[] = []
  const name = optional(input.decidedByName)
  if (typeof name !== 'string' || name.length < 2 || name.length > 120)
    issues.push({
      path: 'decidedByName',
      code: 'REQUIRED',
      message: 'Quem decidiu, do lado do cliente (2 a 120).',
    })
  const reason = optional(input.reason)
  if (!accept && (typeof reason !== 'string' || reason.length < 3))
    issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo da recusa.' })
  if (reason !== null && (typeof reason !== 'string' || reason.length > 500))
    issues.push({ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' })
  const ref = optional(input.customerReference)
  if (ref !== null && (typeof ref !== 'string' || ref.length > 60))
    issues.push({ path: 'customerReference', code: 'LENGTH', message: 'Até 60 caracteres.' })
  const version = Number(input.versionNo)
  if (!Number.isInteger(version) || version < 1)
    issues.push({
      path: 'versionNo',
      code: 'REQUIRED',
      message: 'Versão a que a decisão se refere.',
    })
  return {
    name: name as string,
    reason: reason as string | null,
    customerReference: ref as string | null,
    versionNo: version,
    issues,
  }
}
