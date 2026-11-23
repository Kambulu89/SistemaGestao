import type { ErrorDetail } from '#shared/http/api_error'
import { isDate } from '#modules/procurement/domain/requisitions'

/*
 * Avaliação de fornecedores (9.11) — regras puras. Notas em centésimas de ponto (0 a 10 000 = 0,00 a 100,00).
 *
 *  - Qualidade: por linha de recepção confirmada no período, (aceite − devolvido do aceite) ÷ (aceite + recusado);
 *    média das linhas (cada linha conta igual, para não misturar unidades).
 *  - Prazo: linhas de recepção com data prevista (da linha ou da ordem) recebidas até essa data ÷ linhas com data.
 *  - Conformidade: facturas validadas sem excepção ÷ (validadas + devolvidas ao fornecedor).
 *  - Custo: por linha de pedido de cotação aberto no período em que o fornecedor propôs, menor preço proposto na mesma
 *    moeda ÷ preço do fornecedor; média das linhas (100 = foi sempre o mais barato).
 *  Um critério sem provas não conta: os pesos dos restantes são reescalados. Sem provas nenhumas, não há nota.
 *  Classes: A ≥ 85, B ≥ 70, C ≥ 50, D abaixo.
 */

export const CRITERIA = ['quality', 'delivery', 'compliance', 'cost'] as const
export type Criterion = (typeof CRITERIA)[number]
export type Weights = Record<Criterion, number>
export const DEFAULT_WEIGHTS: Weights = { quality: 30, delivery: 30, compliance: 20, cost: 20 }
export const RATINGS = ['A', 'B', 'C', 'D'] as const
export type Rating = (typeof RATINGS)[number]

export interface Indicator {
  /** Centésimas de ponto (0–10 000) ou `null` sem provas. */
  score: number | null
  evidence: number
}
export type Indicators = Record<Criterion, Indicator>

export function normalizeWeights(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const w = {} as Weights
  for (const c of CRITERIA) {
    const v = input[c]
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN
    if (!Number.isInteger(n) || n < 0 || n > 100)
      issues.push({ path: c, code: 'INVALID', message: 'Peso inteiro de 0 a 100.' })
    w[c] = Number.isInteger(n) ? n : 0
  }
  if (!issues.length && CRITERIA.reduce((s, c) => s + w[c], 0) !== 100)
    issues.push({ path: 'weights', code: 'SUM', message: 'Os pesos têm de somar 100.' })
  return { weights: w, issues }
}

/** a ÷ b em centésimas de ponto, arredondado (b > 0). */
const pct = (a: bigint, b: bigint) => Number((a * 10_000n * 2n + b) / (b * 2n))
const mean = (xs: number[]) =>
  xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null

export function qualityIndicator(
  lines: { accepted: bigint; rejected: bigint; returned: bigint }[]
): Indicator {
  const scores: number[] = []
  for (const l of lines) {
    const delivered = l.accepted + l.rejected
    if (delivered <= 0n) continue
    const good = l.accepted - l.returned
    scores.push(pct(good > 0n ? good : 0n, delivered))
  }
  return { score: mean(scores), evidence: scores.length }
}

export function deliveryIndicator(
  lines: { received: string; expected: string | null }[]
): Indicator {
  const dated = lines.filter((l) => l.expected)
  if (!dated.length) return { score: null, evidence: 0 }
  const onTime = dated.filter((l) => l.received <= l.expected!).length
  return { score: pct(BigInt(onTime), BigInt(dated.length)), evidence: dated.length }
}

export function complianceIndicator(invoices: { clean: boolean }[]): Indicator {
  if (!invoices.length) return { score: null, evidence: 0 }
  const clean = invoices.filter((i) => i.clean).length
  return { score: pct(BigInt(clean), BigInt(invoices.length)), evidence: invoices.length }
}

/** Preços unitários com 6 casas: o menor da linha (na mesma moeda) ÷ o do fornecedor. */
export function costIndicator(lines: { own: bigint; best: bigint }[]): Indicator {
  const scores = lines.filter((l) => l.own > 0n).map((l) => pct(l.best, l.own))
  return { score: mean(scores), evidence: scores.length }
}

export function ratingOf(score: number): Rating {
  if (score >= 8_500) return 'A'
  if (score >= 7_000) return 'B'
  if (score >= 5_000) return 'C'
  return 'D'
}

/** Nota ponderada: só os critérios com provas (e peso) contam; os pesos reescalam-se. */
export function combine(
  weights: Weights,
  ind: Indicators
): { score: number | null; rating: Rating | null } {
  let w = 0
  let sum = 0
  for (const c of CRITERIA) {
    const s = ind[c].score
    if (s === null || weights[c] <= 0) continue
    w += weights[c]
    sum += s * weights[c]
  }
  if (!w) return { score: null, rating: null }
  const score = Math.round(sum / w)
  return { score, rating: ratingOf(score) }
}

export const scoreText = (s: number | null) => (s === null ? null : (s / 100).toFixed(2))

/**
 * SLA de contrato medido no período: prazo (dias da emissão da ordem à recepção, média ≤ alvo), taxa de entrega
 * (recebido ÷ encomendado em %, ≥ alvo) e taxa de qualidade (indicador de qualidade, ≥ alvo). As restantes métricas
 * não se medem automaticamente.
 */
export function slaMet(metric: string, target: number, actual: number | null): boolean | null {
  if (actual === null) return null
  if (metric === 'DELIVERY_DAYS') return actual <= target
  if (metric === 'FILL_RATE' || metric === 'QUALITY_RATE') return actual >= target
  return null
}

export function normalizePeriod(input: Record<string, unknown>, today: string) {
  const issues: ErrorDetail[] = []
  const from = input.from
  const to = input.to ?? today
  if (!isDate(from)) issues.push({ path: 'from', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  if (!isDate(to)) issues.push({ path: 'to', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  if (!issues.length && (to as string) < (from as string))
    issues.push({ path: 'to', code: 'BEFORE_FROM', message: 'O fim é anterior ao início.' })
  if (!issues.length && (to as string) > today)
    issues.push({ path: 'to', code: 'FUTURE', message: 'O período não pode acabar no futuro.' })
  if (
    !issues.length &&
    (new Date(to as string).getTime() - new Date(from as string).getTime()) / 86_400_000 > 731
  )
    issues.push({ path: 'from', code: 'TOO_LONG', message: 'Até dois anos por avaliação.' })
  return { period: { from: from as string, to: to as string }, issues }
}
