import type { ErrorDetail } from '#shared/http/api_error'
import { parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Analítica (pura): percentagens com 4 casas que somam exactamente 100 e repartição exacta de um montante pelas
 * percentagens (maior resto), para que a soma das partes seja sempre igual ao valor da linha — nunca mais, nunca menos.
 */
export const PERCENT_SCALE = 4
export const HUNDRED = 100n * 10n ** BigInt(PERCENT_SCALE)

export function checkPercents(raw: unknown[], path = 'allocations') {
  const issues: ErrorDetail[] = []
  const percents: bigint[] = []
  raw.forEach((v, i) => {
    const p = parseDecimal(typeof v === 'number' ? String(v) : v, PERCENT_SCALE)
    if (p === null || p <= 0n || p > HUNDRED)
      issues.push({
        path: `${path}.${i}.percent`,
        code: 'INVALID_PERCENT',
        message: 'Percentagem entre 0 e 100 (até 4 casas).',
      })
    percents.push(p ?? 0n)
  })
  const total = percents.reduce((a, b) => a + b, 0n)
  if (issues.length === 0 && total !== HUNDRED)
    issues.push({
      path,
      code: 'NOT_100',
      message: `As percentagens somam ${Number(total) / 10 ** PERCENT_SCALE}% — têm de somar 100%.`,
    })
  return { issues, percents }
}

/**
 * Reparte `amount` (inteiro escalado, com sinal) pelas percentagens (escala 4, somam 100). Cada parte é arredondada
 * para baixo em valor absoluto e as unidades que sobram vão para as maiores fracções (empate: a primeira). A soma das
 * partes é exactamente `amount`.
 */
export function distribute(amount: bigint, percents: bigint[]): bigint[] {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const exact = percents.map((p) => abs * p)
  const parts = exact.map((x) => x / HUNDRED)
  let rest = abs - parts.reduce((a, b) => a + b, 0n)
  const order = exact
    .map((x, i) => ({ i, r: x % HUNDRED }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  for (const { i } of order) {
    if (rest === 0n) break
    parts[i] += 1n
    rest -= 1n
  }
  return negative ? parts.map((p) => -p) : parts
}
