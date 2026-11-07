import { addMonths, monthsBetween } from '#modules/accounting/domain/fixed_assets'
import { divRound, multiply, type Rounding } from '#modules/accounting/domain/decimal'

/**
 * Regularizações (puro): meses devidos de um plano (recorrência, acréscimo ou diferimento), repartição exacta de um
 * total por meses e cálculo das diferenças cambiais (não realizadas e realizadas) por saldo em moeda estrangeira.
 */
export const SCHEDULE_KINDS = ['RECURRING', 'ACCRUAL', 'DEFERRAL'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]
export const FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const
export type Frequency = (typeof FREQUENCIES)[number]
const STEP: Record<Frequency, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 }

export interface SchedulePlan {
  kind: ScheduleKind
  frequency: Frequency
  /** AAAA-MM */
  startMonth: string
  /** AAAA-MM (recorrência) — sem fim se null. */
  endMonth: string | null
  /** N.º de meses (acréscimo/diferimento). */
  months: number | null
}

/**
 * Meses devidos até `upTo` (inclusive). Recorrência: do início, de `frequency` em `frequency`, até ao fim (se houver);
 * acréscimo/diferimento: `months` meses seguidos a partir do início.
 */
export function dueMonths(p: SchedulePlan, upTo: string): string[] {
  const out: string[] = []
  if (p.kind === 'RECURRING') {
    const last = p.endMonth && p.endMonth < upTo ? p.endMonth : upTo
    for (let m = p.startMonth; m <= last; m = addMonths(m, STEP[p.frequency])) out.push(m)
    return out
  }
  const n = p.months ?? 0
  for (let k = 0; k < n; k++) {
    const m = addMonths(p.startMonth, k)
    if (m > upTo) break
    out.push(m)
  }
  return out
}

/** Último mês de um acréscimo/diferimento (AAAA-MM). */
export const lastMonth = (startMonth: string, months: number) => addMonths(startMonth, months - 1)

/**
 * Parte do mês k (1..n) de um total repartido em n meses: acumulado arredondado mês a mês, por isso as partes diferem
 * no máximo numa unidade e somam exactamente o total.
 */
export function evenShare(total: bigint, n: number, k: number, mode: Rounding = 'HALF_UP') {
  const N = BigInt(n)
  return divRound(total * BigInt(k), N, mode) - divRound(total * BigInt(k - 1), N, mode)
}

/** Posição (1..n) de um mês num plano de acréscimo/diferimento. */
export const monthIndex = (startMonth: string, month: string) => monthsBetween(startMonth, month)

export interface FxBalance {
  accountId: string
  currency: string
  thirdPartyRef: string | null
  /** Saldo devedor − credor na moeda estrangeira (escala dos montantes). */
  foreign: bigint
  /** Saldo funcional contabilizado, incluindo actualizações cambiais anteriores (escala dos montantes). */
  functional: bigint
}

export interface FxResult extends FxBalance {
  kind: 'UNREALIZED' | 'REALIZED'
  /** Câmbio usado (escala `rateScale`); null quando o saldo em moeda está liquidado. */
  rate: bigint | null
  functionalAfter: bigint
  /** Acerto a lançar no saldo funcional: > 0 aumenta o saldo devedor (débito na conta), < 0 crédito. */
  difference: bigint
}

/**
 * Diferenças cambiais de cada saldo em moeda estrangeira à data:
 * - com saldo em moeda ≠ 0: não realizada — o saldo funcional passa a moeda × câmbio de fecho;
 * - com saldo em moeda = 0 mas funcional ≠ 0: realizada — o resíduo funcional é a diferença da liquidação.
 * Saldos sem diferença não aparecem. Sem câmbio para a moeda, o saldo vai para `missingRates`.
 */
export function revalue(
  balances: FxBalance[],
  rates: Map<string, bigint>,
  scale: number,
  rateScale: number,
  mode: Rounding
) {
  const results: FxResult[] = []
  const missingRates = new Set<string>()
  for (const b of balances) {
    if (b.foreign === 0n) {
      if (b.functional !== 0n)
        results.push({
          ...b,
          kind: 'REALIZED',
          rate: null,
          functionalAfter: 0n,
          difference: -b.functional,
        })
      continue
    }
    const rate = rates.get(b.currency)
    if (rate === undefined) {
      missingRates.add(b.currency)
      continue
    }
    const after = multiply(b.foreign, scale, rate, rateScale, scale, mode)
    if (after !== b.functional)
      results.push({
        ...b,
        kind: 'UNREALIZED',
        rate,
        functionalAfter: after,
        difference: after - b.functional,
      })
  }
  return { results, missingRates: [...missingRates].sort() }
}
