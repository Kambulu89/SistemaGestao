import type { ErrorDetail } from '#shared/http/api_error'
import { divRound } from '#modules/procurement/domain/requisitions'

/*
 * Comparação e adjudicação de propostas (9.4) — regras puras.
 *
 *  Moeda normalizada: cada preço é convertido para a moeda funcional da entidade com o câmbio em vigor na data da
 *  abertura das propostas (fixa: a comparação não muda com câmbios registados depois). Sem câmbio, a oferta aparece
 *  mas não é pontuada nem adjudicável.
 *
 *  Pontuação por linha do pedido (0–100, ao centésimo), entre as ofertas pontuáveis dessa linha:
 *   - preço: mais baixo / este × 100 (preço unitário líquido normalizado);
 *   - entrega: (mais curto + 1) / (este + 1) × 100; sem prazo indicado, 0;
 *   - pagamento: (este + 1) / (mais longo + 1) × 100 (prazo mais longo é melhor); sem prazo, 0;
 *   - qualidade: a nota dada ao fornecedor (0–100).
 *  Total = Σ peso × pontuação / 100, com pesos inteiros que somam 100. A melhor oferta da linha é a de total mais alto
 *  (empate: preço mais baixo, depois a principal antes das alternativas).
 */

export const AWARD_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const
export type AwardStatus = (typeof AWARD_STATUSES)[number]
export const LIVE_AWARD: readonly AwardStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED']

export interface Weights {
  price: number
  delivery: number
  quality: number
  payment: number
}
export const DEFAULT_WEIGHTS: Weights = { price: 60, delivery: 20, quality: 20, payment: 0 }
export const WEIGHT_KEYS = ['price', 'delivery', 'quality', 'payment'] as const

/** Pesos: inteiros de 0 a 100 que somam exactamente 100. */
export function normalizeWeights(raw: unknown): { weights: Weights; issues: ErrorDetail[] } {
  const issues: ErrorDetail[] = []
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const weights = { ...DEFAULT_WEIGHTS }
  if (raw !== undefined && raw !== null) {
    for (const k of WEIGHT_KEYS) {
      const v = src[k] === undefined || src[k] === null || src[k] === '' ? 0 : Number(src[k])
      if (!Number.isInteger(v) || v < 0 || v > 100)
        issues.push({ path: `weights.${k}`, code: 'INVALID', message: 'Peso inteiro de 0 a 100.' })
      else weights[k] = v
    }
  }
  if (!issues.length && WEIGHT_KEYS.reduce((s, k) => s + weights[k], 0) !== 100)
    issues.push({ path: 'weights', code: 'WEIGHTS_SUM', message: 'Os pesos têm de somar 100%.' })
  return { weights, issues }
}

/** Notas de qualidade por fornecedor (0–100, inteiras). */
export function normalizeQuality(raw: unknown, supplierIds: Set<string>) {
  const issues: ErrorDetail[] = []
  const out = new Map<string, number>()
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(src)) {
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (!supplierIds.has(k))
      issues.push({ path: `quality.${k}`, code: 'NOT_FOUND', message: 'Fornecedor sem proposta.' })
    else if (!Number.isInteger(n) || n < 0 || n > 100)
      issues.push({ path: `quality.${k}`, code: 'INVALID', message: 'Nota inteira de 0 a 100.' })
    else out.set(k, n)
  }
  return { quality: out, issues }
}

/** Preço na moeda de base (6 casas): preço (6) × câmbio (10 casas). */
export const toBase6 = (unitPrice: bigint, rate: bigint) => divRound(unitPrice * rate, 10n ** 10n)
/** Valor em cêntimos convertido (câmbio com 10 casas). */
export const toBaseCents = (cents: bigint, rate: bigint) => divRound(cents * rate, 10n ** 10n)

export interface Offer {
  id: string
  rfqLineId: string
  supplierId: string
  alternativeNo: number
  /** Preço unitário líquido na moeda de base (6 casas); `null` sem câmbio. */
  unitPriceBase: bigint | null
  deliveryDays: number | null
  paymentDays: number | null
}
export interface Score {
  price: number
  delivery: number
  quality: number
  payment: number
  total: number
  best: boolean
}

/** Razão em centésimos de ponto (0–10 000), inteira. */
const pct = (n: bigint, d: bigint) => divRound(n * 10_000n, d)

/** Pontua as ofertas por linha do pedido; as sem câmbio ficam de fora (`null`). */
export function scoreOffers(offers: Offer[], weights: Weights, quality: Map<string, number>) {
  const out = new Map<string, Score | null>()
  const byLine = new Map<string, Offer[]>()
  for (const o of offers) {
    if (o.unitPriceBase === null) {
      out.set(o.id, null)
      continue
    }
    byLine.set(o.rfqLineId, [...(byLine.get(o.rfqLineId) ?? []), o])
  }
  for (const list of byLine.values()) {
    const minPrice = list.reduce(
      (m, o) => (o.unitPriceBase! < m ? o.unitPriceBase! : m),
      list[0].unitPriceBase!
    )
    const days = list.map((o) => o.deliveryDays).filter((d): d is number => d !== null)
    const minDays = days.length ? Math.min(...days) : null
    const pays = list.map((o) => o.paymentDays).filter((d): d is number => d !== null)
    const maxPay = pays.length ? Math.max(...pays) : null
    const scored = list.map((o) => {
      const price =
        o.unitPriceBase === 0n ? 10_000n : minPrice === 0n ? 0n : pct(minPrice, o.unitPriceBase!)
      const delivery =
        o.deliveryDays === null || minDays === null
          ? 0n
          : pct(BigInt(minDays + 1), BigInt(o.deliveryDays + 1))
      const payment =
        o.paymentDays === null || maxPay === null
          ? 0n
          : pct(BigInt(o.paymentDays + 1), BigInt(maxPay + 1))
      const q = BigInt(quality.get(o.supplierId) ?? 0) * 100n
      const total = divRound(
        BigInt(weights.price) * price +
          BigInt(weights.delivery) * delivery +
          BigInt(weights.quality) * q +
          BigInt(weights.payment) * payment,
        100n
      )
      const h = (v: bigint) => Number(v) / 100
      return {
        o,
        t: total,
        s: {
          price: h(price),
          delivery: h(delivery),
          quality: h(q),
          payment: h(payment),
          total: h(total),
          best: false,
        },
      }
    })
    scored.sort(
      (a, b) =>
        (b.t > a.t ? 1 : b.t < a.t ? -1 : 0) ||
        (a.o.unitPriceBase! < b.o.unitPriceBase!
          ? -1
          : a.o.unitPriceBase! > b.o.unitPriceBase!
            ? 1
            : 0) ||
        a.o.alternativeNo - b.o.alternativeNo ||
        a.o.id.localeCompare(b.o.id)
    )
    scored[0].s.best = true
    for (const x of scored) out.set(x.o.id, x.s)
  }
  return out
}

export interface AwardLineInput {
  quoteLineId: string
  quantity: bigint
  reason: string | null
}

/**
 * Valida as linhas da adjudicação: ofertas deste pedido, pontuáveis e de propostas válidas; quantidade até à oferta e,
 * somada por linha do pedido, até à quantidade pedida; motivo quando a escolha não é a melhor da linha.
 */
export function awardLineIssues(
  lines: AwardLineInput[],
  offers: Map<string, Offer & { quantity: bigint; expired: boolean }>,
  requested: Map<string, bigint>,
  scores: Map<string, Score | null>
) {
  const issues: ErrorDetail[] = []
  if (!lines.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Adjudique pelo menos uma linha.' })
  const seen = new Set<string>()
  const perLine = new Map<string, bigint>()
  lines.forEach((l, i) => {
    const at = (field: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${field}`, code, message })
    const o = offers.get(l.quoteLineId)
    if (!o)
      return at(
        'quoteLineId',
        'NOT_FOUND',
        'Oferta que não é de uma proposta em vigor deste pedido.'
      )
    if (seen.has(l.quoteLineId)) at('quoteLineId', 'DUPLICATE', 'A mesma oferta só uma vez.')
    seen.add(l.quoteLineId)
    if (o.expired) at('quoteLineId', 'QUOTE_EXPIRED', 'A proposta já não é válida.')
    const s = scores.get(l.quoteLineId)
    if (!s) at('quoteLineId', 'NO_RATE', 'Sem câmbio para a moeda desta proposta.')
    if (l.quantity <= 0n) at('quantity', 'INVALID', 'Quantidade maior que zero.')
    else if (l.quantity > o.quantity)
      at('quantity', 'OVER_OFFER', 'Mais do que a quantidade oferecida.')
    perLine.set(o.rfqLineId, (perLine.get(o.rfqLineId) ?? 0n) + l.quantity)
    if (s && !s.best && !l.reason)
      at('reason', 'NOT_BEST', 'Não é a oferta melhor pontuada desta linha: indique o motivo.')
  })
  for (const [lineId, q] of perLine)
    if (q > (requested.get(lineId) ?? 0n))
      issues.push({
        path: 'lines',
        code: 'OVER_REQUESTED',
        message: 'A quantidade adjudicada numa linha excede a pedida.',
      })
  return issues
}

/** Pode decidir? Nunca quem submeteu. */
export const decideBlockedBy = (submittedBy: string | null, userId: string) =>
  submittedBy === userId ? 'SELF_APPROVAL' : null
