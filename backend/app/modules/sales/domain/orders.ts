import type { ErrorDetail } from '#shared/http/api_error'
import { parseScaled, QTY_SCALE, scaledText } from '#modules/sales/domain/pricing'

/*
 * Encomendas de venda (10.4) — regras puras.
 *
 * Estados separados:
 *  - ciclo: rascunho → confirmada (com número) → fechada (tudo entregue, ou o resto fechado com motivo); anulada
 *    (só sem entregas);
 *  - aprovação: não exigida, pendente (preço/desconto fora da política ou limite de crédito ultrapassado), aprovada
 *    (por outra pessoa) ou devolvida;
 *  - reserva: nenhuma, parcial, total (em aberto, sobre o que falta entregar das linhas de stock) ou não aplicável
 *    (só serviços);
 *  - entrega: nenhuma, parcial, total;
 *  - facturação: nenhuma, parcial, total (actualizada pela facturação, 10.6).
 *
 * Quantidades por linha (escala 6): encomendada ≥ reservada + entregue + fechada; facturada ≤ encomendada.
 */

export const ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
export const SERIES_TYPE = 'SALES_ORDER'
export const APPROVAL_REASONS = ['PRICING', 'CREDIT', 'NO_RATE'] as const

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const optional = (v: unknown) => {
  const t = text(v)
  return t === '' || t === undefined || t === null ? null : t
}
const q = (v: string | bigint) => (typeof v === 'bigint' ? v : parseScaled(v, QTY_SCALE)!)

/** Cabeçalho (só os campos enviados; ao criar, os obrigatórios). */
export function normalizeOrderHeader(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  for (const k of ['legalEntityId', 'customerId'] as const)
    if (k in input || creating) {
      if (typeof input[k] !== 'string' || !UUID.test(input[k] as string))
        issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      else v[k] = input[k]
    }
  for (const k of ['warehouseId', 'deliveryAddressId', 'salespersonMembershipId'] as const)
    if (k in input) {
      const x = optional(input[k])
      if (x !== null && (typeof x !== 'string' || !UUID.test(x)))
        issues.push({ path: k, code: 'INVALID', message: 'Referência inválida.' })
      else v[k] = x
    }
  if ('orderDate' in input || creating) {
    if (typeof input.orderDate !== 'string' || !DATE.test(input.orderDate))
      issues.push({ path: 'orderDate', code: 'INVALID', message: 'Data obrigatória.' })
    else v.orderDate = input.orderDate
  }
  if ('requestedDate' in input) {
    const d = optional(input.requestedDate)
    if (d !== null && (typeof d !== 'string' || !DATE.test(d)))
      issues.push({ path: 'requestedDate', code: 'INVALID', message: 'Data inválida.' })
    else v.requestedDate = d
  }
  if (v.orderDate && v.requestedDate && (v.requestedDate as string) < (v.orderDate as string))
    issues.push({
      path: 'requestedDate',
      code: 'INVALID',
      message: 'A entrega pedida não pode ser antes da encomenda.',
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

export interface QtyLine {
  isStock: boolean
  quantity: string | bigint
  reserved: string | bigint
  delivered: string | bigint
  invoiced: string | bigint
  closed: string | bigint
  /** Devolvido fisicamente (10.8): deixa de ser facturável. */
  returned?: string | bigint
  /** Do devolvido, o já creditado por nota ligada à devolução (10.8). */
  returnCredited?: string | bigint
}

/** O que falta entregar (encomendado − entregue − fechado). */
export const openQty = (l: QtyLine) => q(l.quantity) - q(l.delivered) - q(l.closed)

/** Estado da reserva: sobre o que falta entregar das linhas de stock. */
export function reservationStatus(lines: QtyLine[]) {
  const stock = lines.filter((l) => l.isStock && openQty(l) > 0n)
  if (!lines.some((l) => l.isStock)) return 'NOT_APPLICABLE'
  const reserved = stock.reduce((a, l) => a + q(l.reserved), 0n)
  if (reserved === 0n) return 'NONE'
  return stock.every((l) => q(l.reserved) >= openQty(l)) ? 'FULL' : 'PARTIAL'
}

export function deliveryStatus(lines: QtyLine[]) {
  const delivered = lines.reduce((a, l) => a + q(l.delivered), 0n)
  if (delivered === 0n) return 'NONE'
  return lines.every((l) => q(l.delivered) >= q(l.quantity)) ? 'FULL' : 'PARTIAL'
}

export function invoicingStatus(lines: QtyLine[]) {
  const inv = lines.reduce((a, l) => a + q(l.invoiced), 0n)
  if (inv === 0n) return 'NONE'
  return lines.every(
    (l) =>
      q(l.invoiced) - q(l.returnCredited ?? 0n) >= q(l.quantity) - q(l.closed) - q(l.returned ?? 0n)
  )
    ? 'FULL'
    : 'PARTIAL'
}

/**
 * Verificação do limite de crédito (valores na moeda do cliente, 2 casas): exposição = encomendas confirmadas por
 * facturar + esta encomenda. Sem limite definido, não há verificação; ultrapassar exige aprovação.
 */
export function creditCheck(limit: bigint | null, openOrders: bigint, thisOrder: bigint) {
  const exposure = openOrders + thisOrder
  return {
    limit: limit === null ? null : scaledText(limit, 2),
    openOrders: scaledText(openOrders, 2),
    thisOrder: scaledText(thisOrder, 2),
    exposure: scaledText(exposure, 2),
    exceeded: limit !== null && exposure > limit,
  }
}

/** Pedido de expedição: linhas da encomenda e quantidades (escala 6), chave do pedido e data. */
export function normalizeDelivery(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const key = typeof input.requestKey === 'string' ? input.requestKey.trim() : ''
  if (!/^[A-Za-z0-9:._-]{8,80}$/.test(key))
    issues.push({
      path: 'requestKey',
      code: 'INVALID',
      message: 'Chave do pedido (8 a 80 caracteres).',
    })
  const date = input.deliveryDate
  if (typeof date !== 'string' || !DATE.test(date))
    issues.push({ path: 'deliveryDate', code: 'INVALID', message: 'Data da expedição.' })
  const notes = optional(input.notes)
  if (notes !== null && (typeof notes !== 'string' || notes.length > 500))
    issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 500 caracteres.' })
  const lines: { lineId: string; quantity: bigint; serials: string[] }[] = []
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 200)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique as linhas a expedir.' })
  else
    input.lines.forEach((l: any, i: number) => {
      if (typeof l?.lineId !== 'string' || !UUID.test(l.lineId))
        issues.push({ path: `lines.${i}.lineId`, code: 'REQUIRED', message: 'Linha.' })
      const x = parseScaled(l?.quantity, QTY_SCALE)
      if (x === null || x === 0n)
        issues.push({
          path: `lines.${i}.quantity`,
          code: 'INVALID',
          message: 'Quantidade maior que 0, até 6 casas.',
        })
      const serials = Array.isArray(l?.serials)
        ? l.serials.map((s: unknown) => String(s).trim()).filter(Boolean)
        : []
      lines.push({ lineId: l?.lineId, quantity: x ?? 0n, serials })
    })
  return { key, date: date as string, notes: notes as string | null, lines, issues }
}

/** Pedido de reserva ou libertação por linha (vazio = todo o possível). */
export function normalizeQtyRequest(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const lines: { lineId: string; quantity: bigint }[] = []
  if (input.lines !== undefined && input.lines !== null) {
    if (!Array.isArray(input.lines) || input.lines.length > 200)
      issues.push({ path: 'lines', code: 'INVALID', message: 'Linhas inválidas.' })
    else
      input.lines.forEach((l: any, i: number) => {
        if (typeof l?.lineId !== 'string' || !UUID.test(l.lineId))
          issues.push({ path: `lines.${i}.lineId`, code: 'REQUIRED', message: 'Linha.' })
        const x = parseScaled(l?.quantity, QTY_SCALE)
        if (x === null || x === 0n)
          issues.push({
            path: `lines.${i}.quantity`,
            code: 'INVALID',
            message: 'Quantidade maior que 0, até 6 casas.',
          })
        lines.push({ lineId: l?.lineId, quantity: x ?? 0n })
      })
  }
  return { lines, issues }
}

export const qtyText = (v: bigint) => scaledText(v, QTY_SCALE)
