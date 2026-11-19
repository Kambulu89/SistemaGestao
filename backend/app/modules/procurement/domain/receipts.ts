import type { ErrorDetail } from '#shared/http/api_error'
import { divRound, isDate, parseScaled } from '#modules/procurement/domain/requisitions'

/*
 * Recepções de compra (9.7) — regras puras.
 *
 *  Estados: rascunho → confirmada (número; entrada única no Inventário para os bens armazenáveis; quantidades
 *  recebidas na ordem) → estornada (estorno do lançamento, quantidades devolvidas à ordem). Rascunho anulável.
 *
 *  Quantidades: na unidade da linha da ordem; nunca acima do que falta receber (encomendado − recebido − cancelado).
 *  A recusada (com motivo) não entra nem conta como recebida — fica registada para a não conformidade (9.9).
 *  Na unidade base do produto: quantidade × factor da unidade de compra (1 na unidade base).
 *
 *  Custo de entrada (por unidade base, moeda funcional, 6 casas): líquido da linha da ordem ÷ quantidade encomendada
 *  (desconto incluído, imposto excluído) × câmbio da ordem ÷ factor.
 */

export const RECEIPT_STATUSES = ['DRAFT', 'CONFIRMED', 'REVERSED', 'CANCELLED'] as const
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]
export const RECEIPT_SERIES_TYPE = 'PURCHASE_RECEIPT'

const Q = 10n ** 6n

/** Quantidade na unidade base (6 casas): quantidade × factor (factor com 6 casas; 1 000 000 = 1). */
export const toBaseQuantity = (quantity: bigint, factor: bigint) => divRound(quantity * factor, Q)

/** Custo unitário por unidade base na moeda funcional (6 casas). */
export function unitCostFunctional(
  netCents: bigint,
  orderedQuantity: bigint,
  rate: bigint,
  factor: bigint
) {
  if (orderedQuantity === 0n || factor === 0n) return 0n
  // líquido por unidade da ordem (6 casas) = cêntimos × 10^4 × 10^6 / quantidade (6 casas)
  const perUnit = divRound(netCents * 10_000n * Q, orderedQuantity)
  const functional = divRound(perUnit * rate, 10n ** 10n)
  return divRound(functional * Q, factor)
}

/** Em falta numa linha da ordem. */
export const openQuantity = (l: { quantity: bigint; received: bigint; cancelled: bigint }) =>
  l.quantity - l.received - l.cancelled

export interface ReceiptLineInput {
  orderLineId: string
  quantity: bigint
  rejectedQuantity: bigint
  rejectReason: string | null
  locationId: string | null
  lotCode: string | null
  expiryDate: string | null
  serials: string[]
  notes: string | null
}

const uuid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)

/** Forma das linhas: quantidades (aceite + recusada > 0), motivo da recusa, datas e séries. */
export function normalizeReceiptLines(raw: unknown) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  const seen = new Set<string>()
  const lines: ReceiptLineInput[] = list.map((l: any, i: number) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${f}`, code, message })
    const orderLineId = uuid(l?.orderLineId) ?? ''
    if (!orderLineId) at('orderLineId', 'REQUIRED', 'Linha da ordem.')
    else if (seen.has(orderLineId))
      at('orderLineId', 'DUPLICATE', 'A mesma linha da ordem só uma vez.')
    seen.add(orderLineId)
    const q = parseScaled(l?.quantity ?? '0', 6)
    if (q === null) at('quantity', 'INVALID', 'Quantidade ≥ 0, até 6 casas, em texto.')
    const r = parseScaled(l?.rejectedQuantity ?? '0', 6)
    if (r === null) at('rejectedQuantity', 'INVALID', 'Quantidade ≥ 0, até 6 casas, em texto.')
    if (q !== null && r !== null && q + r === 0n)
      at('quantity', 'REQUIRED', 'Indique a quantidade recebida ou recusada.')
    const rejectReason =
      typeof l?.rejectReason === 'string' && l.rejectReason.trim() ? l.rejectReason.trim() : null
    if (r !== null && r > 0n && !rejectReason)
      at('rejectReason', 'REQUIRED', 'Indique o motivo da recusa.')
    if (rejectReason && rejectReason.length > 500)
      at('rejectReason', 'LENGTH', 'Até 500 caracteres.')
    const expiryDate = l?.expiryDate ? l.expiryDate : null
    if (expiryDate !== null && !isDate(expiryDate)) at('expiryDate', 'INVALID', 'Data AAAA-MM-DD.')
    const lotCode = typeof l?.lotCode === 'string' && l.lotCode.trim() ? l.lotCode.trim() : null
    if (lotCode && lotCode.length > 60) at('lotCode', 'LENGTH', 'Até 60 caracteres.')
    const serials = Array.isArray(l?.serials)
      ? l.serials.map((s: unknown) => String(s).trim()).filter((s: string) => s)
      : []
    if (new Set(serials).size !== serials.length)
      at('serials', 'DUPLICATE', 'Números de série repetidos.')
    const notes =
      typeof l?.notes === 'string' && l.notes.trim() ? l.notes.trim().slice(0, 500) : null
    return {
      orderLineId,
      quantity: q ?? 0n,
      rejectedQuantity: r ?? 0n,
      rejectReason,
      locationId: uuid(l?.locationId),
      lotCode,
      expiryDate,
      serials,
      notes,
    }
  })
  return { lines, issues }
}

/** Entregas previstas: atrasada quando a data prevista já passou e ainda falta receber. */
export function deliveryState(expected: string | null, open: bigint, today: string) {
  if (open <= 0n) return 'DONE' as const
  if (!expected) return 'UNSCHEDULED' as const
  if (expected < today) return 'OVERDUE' as const
  if (expected === today) return 'TODAY' as const
  return 'UPCOMING' as const
}
