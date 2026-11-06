import { divRound } from '#modules/accounting/domain/decimal'

/**
 * Activos fixos (puro): mapa de depreciação mensal e resultado do abate. Os valores são inteiros escalados (escala dos
 * montantes da empresa); o mapa soma sempre exactamente custo − residual, sem resíduos de arredondamento.
 *
 * Convenção: mês inteiro no mês de início da depreciação, nada no mês do abate. Os métodos são os de cálculo
 * financeiro habituais; taxas e vidas úteis fiscais não são assumidas aqui — vêm do que a empresa configura.
 */
export const METHODS = ['STRAIGHT_LINE', 'DECLINING_BALANCE'] as const
export type Method = (typeof METHODS)[number]
export const FACTOR_SCALE = 2

export interface DepreciationBasis {
  cost: bigint
  residual: bigint
  lifeMonths: number
  method: Method
  /** Coeficiente do método degressivo (escala 2, p. ex. 200 = 2,00). */
  factor: bigint | null
  /** Primeiro mês de depreciação, AAAA-MM. */
  startMonth: string
}

export interface ScheduleRow {
  month: string
  amount: bigint
  accumulated: bigint
  bookValue: bigint
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

export const isMonth = (v: unknown): v is string => typeof v === 'string' && MONTH.test(v)

/** Soma `n` meses a AAAA-MM. */
export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number)
  const index = y * 12 + (m - 1) + n
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** Meses de `from` até `to` (inclusive); 0 se `to` < `from`. */
export function monthsBetween(from: string, to: string) {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return Math.max(0, ty * 12 + tm - (fy * 12 + fm) + 1)
}

/** Último dia do mês (AAAA-MM-DD). */
export function monthEnd(month: string) {
  const [y, m] = month.split('-').map(Number)
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(day).padStart(2, '0')}`
}

/**
 * Mapa de depreciação completo.
 * - Linha recta: acumulado do mês k = arredondamento de (custo − residual) × k / vida; a quota é a diferença, por isso
 *   a soma é exacta e as quotas diferem no máximo numa unidade.
 * - Degressivo: em cada bloco de 12 meses, quota mensal = valor líquido no início do bloco × coeficiente / vida (em
 *   meses), passando à linha recta sobre o que falta quando esta for maior; nunca abaixo do residual e o último mês
 *   leva o que faltar.
 */
export function buildSchedule(b: DepreciationBasis): ScheduleRow[] {
  const depreciable = b.cost - b.residual
  const rows: ScheduleRow[] = []
  if (depreciable <= 0n || b.lifeMonths < 1) return rows
  const life = BigInt(b.lifeMonths)
  let accumulated = 0n
  let monthly = 0n
  for (let k = 0; k < b.lifeMonths; k++) {
    let amount: bigint
    if (b.method === 'STRAIGHT_LINE') {
      amount = divRound(depreciable * BigInt(k + 1), life, 'HALF_UP') - accumulated
    } else {
      const remaining = depreciable - accumulated
      if (k % 12 === 0) {
        const bookValue = b.cost - accumulated
        const declining = divRound(bookValue * (b.factor ?? 200n), life * 100n, 'HALF_UP')
        const straight = divRound(remaining, BigInt(b.lifeMonths - k), 'HALF_UP')
        monthly = declining > straight ? declining : straight
      }
      amount = k === b.lifeMonths - 1 || monthly > remaining ? remaining : monthly
    }
    accumulated += amount
    rows.push({
      month: addMonths(b.startMonth, k),
      amount,
      accumulated,
      bookValue: b.cost - accumulated,
    })
    if (accumulated === depreciable) break
  }
  return rows
}

/**
 * Abate: sai o custo (crédito do activo), sai a depreciação acumulada (débito das amortizações acumuladas), entra o
 * valor de venda (débito da contrapartida) e a diferença é ganho (crédito) ou perda (débito). Sempre equilibrado.
 */
export function disposalResult(cost: bigint, accumulated: bigint, proceeds: bigint) {
  const bookValue = cost - accumulated
  const result = proceeds - bookValue
  return { bookValue, gain: result > 0n ? result : 0n, loss: result < 0n ? -result : 0n }
}
