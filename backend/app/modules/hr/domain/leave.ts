import type { ErrorDetail } from '#shared/http/api_error'
import { cents } from '#modules/hr/domain/recruitment'

/**
 * Férias e ausências (7.4): regras puras. Nenhum valor legal está fixado aqui — dias anuais, regra do primeiro ano,
 * arredondamento e transporte vêm da política configurada pela empresa (com a fonte legal indicada).
 */

export const LEAVE_CATEGORIES = [
  'VACATION',
  'SICK',
  'MATERNITY',
  'PATERNITY',
  'BEREAVEMENT',
  'MARRIAGE',
  'UNPAID',
  'OTHER',
] as const
export const COUNTING = ['WORKING_DAYS', 'CALENDAR_DAYS'] as const
export const FIRST_YEAR_RULES = ['FULL', 'PROPORTIONAL_MONTHS', 'DAYS_PER_MONTH'] as const
export type FirstYearRule = (typeof FIRST_YEAR_RULES)[number]
export const ROUNDING = ['NONE', 'HALF_DAY_UP', 'DAY_UP'] as const
export type Rounding = (typeof ROUNDING)[number]
export const LEDGER_KINDS = [
  'ACCRUAL',
  'CARRYOVER',
  'EXPIRY',
  'ADJUSTMENT',
  'TAKEN',
  'REVERSAL',
] as const

/** Cêntimos de dia → texto com 2 casas (ex.: 2150n → "21.50", -50n → "-0.50"). */
export function daysText(c: bigint): string {
  const neg = c < 0n
  const s = (neg ? -c : c).toString().padStart(3, '0')
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`
}

/** Texto com até 2 casas, com sinal opcional → cêntimos de dia; `null` se inválido. */
export function daysCents(raw: unknown): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string') return null
  const t = v.trim()
  const neg = t.startsWith('-')
  const c = cents(neg ? t.slice(1) : t)
  return c === null ? null : neg ? -c : c
}

function roundCents(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  // Valor exacto = numerator / denominator (em cêntimos de dia).
  const step = rounding === 'DAY_UP' ? 100n : rounding === 'HALF_DAY_UP' ? 50n : 1n
  if (step === 1n) return (numerator * 2n + denominator) / (2n * denominator) // meio para cima
  const units = numerator / (denominator * step)
  return (numerator % (denominator * step) === 0n ? units : units + 1n) * step
}

/** Meses completos de serviço no ano de admissão (o mês da admissão conta se começou no dia 1). */
export function serviceMonthsInHireYear(hireDate: string): number {
  const month = Number(hireDate.slice(5, 7))
  const day = Number(hireDate.slice(8, 10))
  return 12 - month + (day === 1 ? 1 : 0)
}

export interface PolicyRules {
  annualDays: string
  firstYearRule: FirstYearRule
  firstYearDaysPerMonth: string | null
  rounding: Rounding
}

/**
 * Direito a férias do ano para um colaborador: o valor anual da política; no ano de admissão, segundo a regra do
 * primeiro ano (proporcional aos meses completos, ou dias por mês completo), nunca acima do valor anual. Admitido
 * depois do ano → 0. Devolve cêntimos de dia.
 */
export function entitlementFor(rules: PolicyRules, hireDate: string, year: number): bigint {
  const hireYear = Number(hireDate.slice(0, 4))
  const annual = daysCents(rules.annualDays) ?? 0n
  if (hireYear > year) return 0n
  if (hireYear < year || rules.firstYearRule === 'FULL') return annual
  const months = BigInt(serviceMonthsInHireYear(hireDate))
  if (rules.firstYearRule === 'PROPORTIONAL_MONTHS')
    return roundCents(annual * months, 12n, rules.rounding)
  const perMonth = daysCents(rules.firstYearDaysPerMonth) ?? 0n
  const value = roundCents(perMonth * months, 1n, rules.rounding)
  return value > annual ? annual : value
}

/** Transporte para o ano seguinte: o saldo positivo até ao máximo; o resto expira. */
export function carryover(balance: bigint, maxDays: string) {
  const max = daysCents(maxDays) ?? 0n
  if (balance <= 0n) return { carry: 0n, expire: 0n }
  const carry = balance < max ? balance : max
  return { carry, expire: balance - carry }
}

/** Regras do pedido que não dependem da base de dados. */
export function requestIssues(start: unknown, end: unknown): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  const iso = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  if (!iso(start))
    issues.push({ path: 'startDate', code: 'INVALID_DATE', message: 'Data inválida.' })
  if (!iso(end)) issues.push({ path: 'endDate', code: 'INVALID_DATE', message: 'Data inválida.' })
  if (issues.length) return issues
  if ((end as string) < (start as string))
    issues.push({ path: 'endDate', code: 'BEFORE_START', message: 'O fim é anterior ao início.' })
  else if ((start as string).slice(0, 4) !== (end as string).slice(0, 4))
    issues.push({
      path: 'endDate',
      code: 'CROSS_YEAR',
      message: 'Um pedido não atravessa o ano: divida-o em dois.',
    })
  return issues
}

/** Dias de calendário entre duas datas, inclusive. */
export function calendarDays(start: string, end: string) {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  )
}

export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const
