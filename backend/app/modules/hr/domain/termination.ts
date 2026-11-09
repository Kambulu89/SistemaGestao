import type { ErrorDetail } from '#shared/http/api_error'

/**
 * Regras puras da cessação (7.11). Nenhum valor legal está aqui: dias de aviso, fórmula de indemnização e valor diário
 * são indicados pela empresa, com a fonte; o sistema calcula só contagens de datas e verifica coerência.
 */

export const TERMINATION_REASONS = [
  'RESIGNATION',
  'MUTUAL_AGREEMENT',
  'DISMISSAL_DISCIPLINARY',
  'DISMISSAL_OBJECTIVE',
  'END_OF_TERM',
  'PROBATION',
  'RETIREMENT',
  'DEATH',
  'OTHER',
] as const
export type TerminationReason = (typeof TERMINATION_REASONS)[number]

export const TERMINATION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SETTLED',
  'CANCELLED',
] as const

/** Quem tomou a iniciativa (para relatórios de rotatividade): derivado do motivo. */
export function initiativeOf(reason: TerminationReason) {
  switch (reason) {
    case 'RESIGNATION':
      return 'EMPLOYEE' as const
    case 'MUTUAL_AGREEMENT':
      return 'MUTUAL' as const
    case 'DISMISSAL_DISCIPLINARY':
    case 'DISMISSAL_OBJECTIVE':
    case 'PROBATION':
      return 'EMPLOYER' as const
    default:
      return 'OTHER' as const
  }
}

/** Linhas da liquidação: abonos (componente EARNING) e descontos (componente DEDUCTION). */
export const SETTLEMENT_EARNINGS = [
  'UNUSED_VACATION',
  'PROPORTIONAL_VACATION',
  'PROPORTIONAL_ALLOWANCE',
  'NOTICE_PAY',
  'INDEMNITY',
  'OTHER_EARNING',
] as const
export const SETTLEMENT_DEDUCTIONS = ['NOTICE_DEDUCTION', 'OTHER_DEDUCTION'] as const
export const SETTLEMENT_KINDS = [...SETTLEMENT_EARNINGS, ...SETTLEMENT_DEDUCTIONS] as const
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number]
export const VACATION_KINDS: SettlementKind[] = ['UNUSED_VACATION', 'PROPORTIONAL_VACATION']

export const TASK_CATEGORIES = ['ACCESS', 'EQUIPMENT', 'DOCUMENTS', 'FINANCE', 'OTHER'] as const
export const TASK_STATUSES = ['PENDING', 'DONE', 'NOT_APPLICABLE'] as const

const DAY = 86_400_000
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`)

/** Dias de calendário de `from` a `to` (exclusivo de `from`: 1 de Março → 31 de Março = 30). */
export function daysBetween(from: string, to: string) {
  return Math.round((utc(to) - utc(from)) / DAY)
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Antiguidade de `start` até `end` (inclusive) em anos, meses e dias completos. */
export function serviceLength(start: string, end: string) {
  const [y1, m1, d1] = start.split('-').map(Number)
  const next = new Date(utc(end) + DAY)
  let years = next.getUTCFullYear() - y1
  let months = next.getUTCMonth() + 1 - m1
  let days = next.getUTCDate() - d1
  if (days < 0) {
    months -= 1
    // Dias do mês anterior ao dia seguinte ao fim.
    days += new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 0)).getUTCDate()
  }
  if (months < 0) {
    years -= 1
    months += 12
  }
  return { years, months, days, totalDays: daysBetween(start, end) + 1 }
}

/**
 * Aviso prévio: dias dados (do aviso ao último dia, inclusive) contra os dias exigidos indicados pela empresa; a falta
 * é só informação para a liquidação (compensação ou desconto, consoante quem faltou ao aviso).
 */
export function noticeFacts(
  noticeGivenOn: string | null,
  lastDay: string,
  required: number | null
) {
  const given = noticeGivenOn ? daysBetween(noticeGivenOn, lastDay) + 1 : null
  const shortfall = required === null ? null : Math.max(0, required - (given === null ? 0 : given))
  return { required, given, shortfall }
}

/**
 * Fracção do ano de cessação trabalhada (do início do ano, ou da admissão, até ao último dia, inclusive), como
 * numerador/denominador em dias. Base para a sugestão de férias proporcionais; a regra aplicável é confirmada pela
 * empresa.
 */
export function yearFraction(hireDate: string, lastDay: string) {
  const year = Number(lastDay.slice(0, 4))
  const start = hireDate > `${year}-01-01` ? hireDate : `${year}-01-01`
  const worked = start > lastDay ? 0 : daysBetween(start, lastDay) + 1
  return { worked, total: isLeap(year) ? 366 : 365 }
}

/** `value × worked / total`, arredondado ao cêntimo (meio para cima). `value` em cêntimos. */
export function prorate(value: bigint, worked: number, total: number) {
  if (total <= 0) return 0n
  const n = value * BigInt(worked)
  const d = BigInt(total)
  return n >= 0n ? (n * 2n + d) / (2n * d) : -((-n * 2n + d) / (2n * d))
}

/** Decimal positivo com até `scale` casas → inteiro escalado; `null` se inválido. */
export function scaled(raw: unknown, scale: number): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!new RegExp(`^\\d{1,14}(\\.\\d{1,${scale}})?$`).test(t)) return null
  const [int, frac = ''] = t.split('.')
  return BigInt(int) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0') || '0')
}

/** Texto de um inteiro escalado (`scale` casas). */
export function scaledText(v: bigint, scale: number) {
  const s = v.toString().padStart(scale + 1, '0')
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`
}

/** Quantidade (2 casas) × valor unitário (4 casas) → cêntimos, meio para cima. */
export function lineAmount(quantity: bigint, rate: bigint) {
  // quantity em 1e-2 e rate em 1e-4 → produto em 1e-6; cêntimos = produto / 1e4.
  const p = quantity * rate
  return (p * 2n + 10_000n) / 20_000n
}

/**
 * Coerência de uma linha: tipo e componente compatíveis (abono/desconto), quantidade e valor unitário juntos e, quando
 * presentes, o montante igual a quantidade × valor unitário (ao cêntimo).
 */
export function settlementLineIssues(v: {
  kind: unknown
  componentKind: string | null
  quantity: bigint | null
  rate: bigint | null
  amount: bigint | null
  indemnityApplicable: boolean
}): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  if (!SETTLEMENT_KINDS.includes(v.kind as SettlementKind)) {
    issues.push({ path: 'kind', code: 'INVALID', message: 'Tipo de linha inválido.' })
    return issues
  }
  const earning = (SETTLEMENT_EARNINGS as readonly string[]).includes(v.kind as string)
  if (v.componentKind && v.componentKind !== (earning ? 'EARNING' : 'DEDUCTION'))
    issues.push({
      path: 'componentId',
      code: 'KIND_MISMATCH',
      message: earning
        ? 'Esta linha é um abono: escolha um componente de abono.'
        : 'Esta linha é um desconto: escolha um componente de desconto.',
    })
  if (v.kind === 'INDEMNITY' && !v.indemnityApplicable)
    issues.push({
      path: 'kind',
      code: 'INDEMNITY_NOT_APPLICABLE',
      message: 'Indique primeiro que há indemnização aplicável, com a base legal.',
    })
  if ((v.quantity === null) !== (v.rate === null))
    issues.push({
      path: v.quantity === null ? 'quantity' : 'rate',
      code: 'PAIR',
      message: 'Indique a quantidade e o valor unitário, ou nenhum.',
    })
  if (v.amount !== null && v.amount <= 0n)
    issues.push({ path: 'amount', code: 'POSITIVE', message: 'O montante tem de ser positivo.' })
  if (v.quantity !== null && v.rate !== null && v.amount !== null) {
    const expected = lineAmount(v.quantity, v.rate)
    if (expected !== v.amount)
      issues.push({
        path: 'amount',
        code: 'AMOUNT_MISMATCH',
        message: `O montante tem de ser quantidade × valor unitário (${scaledText(expected, 2)}).`,
      })
  }
  return issues
}

/** Totais da liquidação (antes de IRT/INSS, que o processamento calcula). */
export function settlementTotals(lines: { kind: string; amount: string }[]) {
  let earnings = 0n
  let deductions = 0n
  for (const l of lines) {
    const c = scaled(l.amount, 2) ?? 0n
    if ((SETTLEMENT_EARNINGS as readonly string[]).includes(l.kind)) earnings += c
    else deductions += c
  }
  return { earnings, deductions, net: earnings - deductions }
}
