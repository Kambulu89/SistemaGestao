import { cents } from '#modules/hr/domain/recruitment'
import { moneyText } from '#modules/hr/domain/compensation'

/**
 * Adiantamentos e empréstimos (7.6): regras puras. Sem juros (o prompt não os prevê). Os limites (prestação máxima em
 * percentagem do salário base e número máximo de prestações) vêm da configuração de RH com a fonte; nada fixado aqui.
 */

export const LOAN_KINDS = ['ADVANCE', 'LOAN'] as const
export type LoanKind = (typeof LOAN_KINDS)[number]

/** Primeiro dia do mês de "AAAA-MM" ou "AAAA-MM-DD"; `null` se inválido. */
export function periodStart(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(raw.trim())
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null
  return `${m[1]}-${m[2]}-01`
}

/** Mês seguinte (n meses depois) de um primeiro dia de mês. */
export function addMonths(period: string, n: number): string {
  const y = Number(period.slice(0, 4))
  const mo = Number(period.slice(5, 7)) - 1 + n
  const year = y + Math.floor(mo / 12)
  const month = ((mo % 12) + 12) % 12
  return `${year}-${String(month + 1).padStart(2, '0')}-01`
}

/** Último dia do mês de um primeiro dia de mês. */
export function periodEnd(period: string): string {
  const d = new Date(`${addMonths(period, 1)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Plano de prestações mensais: o capital dividido em partes iguais ao cêntimo; o resto (cêntimos) vai para a última,
 * de modo que a soma é exactamente o capital.
 */
export function schedule(principal: string, count: number, firstPeriod: string) {
  const total = cents(principal) ?? 0n
  const n = BigInt(count)
  const base = total / n
  const remainder = total - base * n
  return Array.from({ length: count }, (_, i) => ({
    sequence: i + 1,
    duePeriod: addMonths(firstPeriod, i),
    amount: moneyText(i === count - 1 ? base + remainder : base),
  }))
}

/** Valor máximo de desconto mensal: percentagem (até 2 casas) do salário base, arredondado para baixo ao cêntimo. */
export function maxMonthlyDeduction(baseSalary: string, percent: string): bigint {
  const base = cents(baseSalary) ?? 0n
  const p = cents(percent) ?? 0n // percentagem em centésimas de ponto
  return (base * p) / 10000n
}

/** Montante em cêntimos para mensagens (`100 000,00`), sem `float`. */
export function moneyLabel(c: bigint): string {
  const neg = c < 0n
  const s = (neg ? -c : c).toString().padStart(3, '0')
  const int = s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${neg ? '-' : ''}${int},${s.slice(-2)}`
}

/** Percentagem para mensagens (`30`, `33,5`). */
export function percentLabel(p: string): string {
  return p.replace(/\.?0+$/, '').replace('.', ',')
}

/** Mês para mensagens (`12/2026`). */
export function monthLabel(period: string): string {
  return `${period.slice(5, 7)}/${period.slice(0, 4)}`
}
