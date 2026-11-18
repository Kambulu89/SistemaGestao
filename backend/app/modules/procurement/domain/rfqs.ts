import type { ErrorDetail } from '#shared/http/api_error'
import { isDate, lineAmounts, parseScaled } from '#modules/procurement/domain/requisitions'

/*
 * Pedidos de cotação (9.3) — regras puras.
 *
 *  Estados: rascunho → aberto (emitido: número, convites, prazo) → fechado (propostas abertas) → adjudicado (9.4);
 *  anulado em qualquer fase antes da adjudicação.
 *
 *  Envelope fechado: enquanto o pedido está aberto, os valores das propostas não se mostram a ninguém (nem a quem as
 *  registou); só que chegaram, quando e de quem. A abertura (fecho do pedido) só antes do prazo se todos os convidados
 *  já responderam ou declinaram; depois do prazo, sempre. Propostas depois do prazo são recusadas.
 *
 *  Versões: uma proposta nova do mesmo fornecedor substitui a anterior (que fica); revisões do pedido (com motivo)
 *  aumentam o número da revisão e as propostas feitas a uma revisão anterior ficam assinaladas como desactualizadas.
 */

export const RFQ_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'AWARDED', 'CANCELLED'] as const
export type RfqStatus = (typeof RFQ_STATUSES)[number]
export const RFQ_SERIES_TYPE = 'RFQ'

export const RFQ_CAN: Record<string, readonly RfqStatus[]> = {
  edit: ['DRAFT'],
  invite: ['DRAFT', 'OPEN'],
  uninvite: ['DRAFT'],
  issue: ['DRAFT'],
  amend: ['OPEN'],
  quote: ['OPEN'],
  decline: ['OPEN'],
  close: ['OPEN'],
  cancel: ['DRAFT', 'OPEN', 'CLOSED'],
}

/** Os valores das propostas estão escondidos? (envelope fechado e pedido ainda aberto). */
export const pricesHidden = (r: { sealed: boolean; status: string }) =>
  r.sealed && r.status === 'OPEN'

/** Pode abrir-se já? Depois do prazo sempre; antes, só com todos os convidados respondidos ou declinados. */
export function canOpen(closesAt: Date, now: Date, invitations: { status: string }[]) {
  if (now.getTime() >= closesAt.getTime()) return true
  return invitations.length > 0 && invitations.every((i) => i.status !== 'INVITED')
}

export interface QuoteLineInput {
  rfqLineId: string
  alternativeNo: number
  description: string | null
  quantity: bigint
  unitPrice: bigint
  taxRate: bigint
  deliveryDays: number | null
  notes: string | null
}

/** Valida as linhas de uma proposta contra as linhas do pedido; calcula os totais pelas ofertas principais. */
export function quoteLines(raw: unknown, rfqLineIds: Set<string>) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  const lines: QuoteLineInput[] = []
  const seen = new Set<string>()
  list.forEach((l: any, i: number) => {
    const at = (field: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${field}`, code, message })
    const rfqLineId = typeof l?.rfqLineId === 'string' ? l.rfqLineId : ''
    if (!rfqLineIds.has(rfqLineId)) at('rfqLineId', 'NOT_FOUND', 'Linha que não é deste pedido.')
    const alt =
      l?.alternativeNo === undefined || l?.alternativeNo === null ? 0 : Number(l.alternativeNo)
    if (!Number.isInteger(alt) || alt < 0 || alt > 9)
      at('alternativeNo', 'INVALID', 'Alternativa de 0 a 9.')
    const k = `${rfqLineId}|${alt}`
    if (seen.has(k)) at('alternativeNo', 'DUPLICATE', 'A mesma linha e alternativa só uma vez.')
    seen.add(k)
    const description =
      typeof l?.description === 'string' && l.description.trim() ? l.description.trim() : null
    if (alt > 0 && !description) at('description', 'REQUIRED', 'Descreva a alternativa proposta.')
    if (description && description.length > 300) at('description', 'LENGTH', 'Até 300 caracteres.')
    const q = parseScaled(l?.quantity, 6)
    if (q === null || q <= 0n)
      at('quantity', 'INVALID', 'Quantidade maior que zero, até 6 casas, em texto.')
    const p = parseScaled(l?.unitPrice, 6)
    if (p === null) at('unitPrice', 'INVALID', 'Preço ≥ 0, até 6 casas, em texto.')
    const t = parseScaled(l?.taxRate ?? '0', 3)
    if (t === null || t > 100_000n) at('taxRate', 'INVALID', 'Taxa de imposto entre 0 e 100.')
    const d =
      l?.deliveryDays === undefined || l?.deliveryDays === null || l?.deliveryDays === ''
        ? null
        : Number(l.deliveryDays)
    if (d !== null && (!Number.isInteger(d) || d < 0 || d > 730))
      at('deliveryDays', 'INVALID', 'Prazo de 0 a 730 dias.')
    const notes =
      typeof l?.notes === 'string' && l.notes.trim() ? l.notes.trim().slice(0, 500) : null
    lines.push({
      rfqLineId,
      alternativeNo: Number.isInteger(alt) ? alt : 0,
      description,
      quantity: q ?? 0n,
      unitPrice: p ?? 0n,
      taxRate: t ?? 0n,
      deliveryDays: d,
      notes,
    })
  })
  let net = 0n
  let tax = 0n
  const amounts = lines.map((l) => {
    const a = lineAmounts(l.quantity, l.unitPrice, l.taxRate)
    if (l.alternativeNo === 0) {
      net += a.net
      tax += a.tax
    }
    return a
  })
  return { lines, amounts, totals: { net, tax, total: net + tax }, issues }
}

export { isDate }
