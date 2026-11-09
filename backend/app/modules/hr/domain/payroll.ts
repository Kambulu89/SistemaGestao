import type { ErrorDetail } from '#shared/http/api_error'
import { cents } from '#modules/hr/domain/recruitment'
import { moneyText } from '#modules/hr/domain/compensation'

/**
 * Processamento salarial (7.7): cálculo puro, em cêntimos (`bigint`), sem `float`. As regras (taxas de INSS, tabela de
 * IRT, incidência do salário base, base do IRT, base de dias) chegam de um conjunto de regras versionado com fonte;
 * nada aqui é um valor legal.
 */

export const RUN_KINDS = ['REGULAR', 'EXTRA', 'RETRO'] as const
export type RunKind = (typeof RUN_KINDS)[number]
export const DAY_BASES = ['CALENDAR', 'FIXED_30'] as const
export type DayBasis = (typeof DAY_BASES)[number]

export interface Bracket {
  lower: string
  upper: string | null
  fixedAmount: string
  rate: string
  excessOver: string
}

export interface Rules {
  id: string
  inssEmployeeRate: string
  inssEmployerRate: string
  baseIrtSubject: boolean
  baseInssSubject: boolean
  irtBaseDeductsInss: boolean
  dayBasis: DayBasis
  brackets: Bracket[]
}

export interface Incidence {
  irtSubject: boolean
  irtExemptAmount: string | null
  inssSubject: boolean
}

export interface PayItem {
  componentId: string
  code: string
  name: string
  kind: 'EARNING' | 'DEDUCTION'
  amount: string
  recurring: boolean
  incidence: Incidence | null
}

export interface PayInput {
  /** Primeiro dia do mês. */
  period: string
  daysInMonth: number
  /** `null` num processamento extra (sem salário base). */
  base: { amount: string; payableDays: number } | null
  items: PayItem[]
  /** Faltas não remuneradas do mês, em dias (2 casas). */
  unpaidAbsences: { code: string; days: string }[]
  loans: { installmentId: string; loanCode: string; amount: string }[]
  rules: Rules
}

export type LineKind = 'EARNING' | 'DEDUCTION' | 'EMPLOYER'
export type LineSource =
  'BASE' | 'COMPONENT' | 'ABSENCE' | 'LOAN' | 'INSS' | 'IRT' | 'INSS_EMPLOYER'

export interface PayLine {
  code: string
  name: string
  kind: LineKind
  source: LineSource
  amount: bigint
  irtSubject: boolean
  inssSubject: boolean
  refId: string | null
}

export interface Totals {
  gross: bigint
  inssBase: bigint
  irtBase: bigint
  inssEmployee: bigint
  irt: bigint
  deductions: bigint
  loans: bigint
  net: bigint
  inssEmployer: bigint
  employerCost: bigint
}

/** Taxa percentual com até 4 casas → unidades de 1/10 000 de ponto percentual. */
export function rateUnits(rate: string): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(rate.trim())
  if (!m) return 0n
  return BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'))
}

/** Divisão com arredondamento ao cêntimo, meio para cima (valores não negativos). */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) return -divRound(-numerator, denominator)
  return (numerator * 2n + denominator) / (2n * denominator)
}

/** Montante × taxa%, arredondado ao cêntimo. */
export function applyRate(amount: bigint, rate: string): bigint {
  return divRound(amount * rateUnits(rate), 1000000n)
}

/** Proporção de um montante (`parts/whole`), arredondada ao cêntimo. */
export function prorate(amount: bigint, parts: bigint, whole: bigint): bigint {
  if (whole <= 0n) return 0n
  return divRound(amount * parts, whole)
}

/** Imposto pela tabela progressiva: parcela fixa + (base − excesso) × taxa, no escalão onde a base cabe. */
export function irtFor(base: bigint, brackets: Bracket[]): bigint | null {
  if (base <= 0n) return 0n
  for (const b of brackets) {
    const lower = cents(b.lower) ?? 0n
    const upper = b.upper === null ? null : (cents(b.upper) ?? 0n)
    if (base >= lower && (upper === null || base <= upper)) {
      const excess = base - (cents(b.excessOver) ?? 0n)
      return (cents(b.fixedAmount) ?? 0n) + applyRate(excess > 0n ? excess : 0n, b.rate)
    }
  }
  return null
}

/** Escalões contíguos, sem sobreposição, o último aberto; taxas entre 0 e 100. */
export function bracketIssues(brackets: unknown): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  if (!Array.isArray(brackets) || brackets.length === 0)
    return [{ path: 'brackets', code: 'REQUIRED', message: 'Indique pelo menos um escalão.' }]
  let previousUpper: bigint | null = null
  brackets.forEach((b: any, i: number) => {
    const at = (k: string) => `brackets.${i}.${k}`
    const lower = cents(b?.lower)
    const upper =
      b?.upper === null || b?.upper === undefined || b?.upper === '' ? null : cents(b.upper)
    const fixed = cents(b?.fixedAmount ?? '0')
    const excess = cents(b?.excessOver ?? b?.lower)
    const rate = typeof b?.rate === 'string' && /^\d{1,3}(\.\d{1,4})?$/.test(b.rate) ? b.rate : null
    if (lower === null || lower < 0n)
      issues.push({
        path: at('lower'),
        code: 'INVALID_AMOUNT',
        message: 'Limite inferior inválido.',
      })
    if (upper === null && b?.upper !== null && b?.upper !== undefined && b?.upper !== '')
      issues.push({
        path: at('upper'),
        code: 'INVALID_AMOUNT',
        message: 'Limite superior inválido.',
      })
    if (fixed === null || fixed < 0n)
      issues.push({
        path: at('fixedAmount'),
        code: 'INVALID_AMOUNT',
        message: 'Parcela fixa inválida.',
      })
    if (excess === null || excess < 0n)
      issues.push({ path: at('excessOver'), code: 'INVALID_AMOUNT', message: 'Excesso inválido.' })
    if (rate === null || rateUnits(rate) > 1000000n)
      issues.push({ path: at('rate'), code: 'INVALID_PERCENT', message: 'Taxa entre 0 e 100.' })
    if (lower !== null && upper !== null && upper < lower)
      issues.push({
        path: at('upper'),
        code: 'RANGE',
        message: 'O limite superior é menor que o inferior.',
      })
    if (i === 0 && lower !== null && lower !== 0n)
      issues.push({ path: at('lower'), code: 'GAP', message: 'O primeiro escalão começa em 0.' })
    if (i > 0 && lower !== null && previousUpper !== null && lower !== previousUpper + 1n)
      issues.push({
        path: at('lower'),
        code: 'GAP',
        message: 'Cada escalão começa um cêntimo depois do fim do anterior.',
      })
    if (i > 0 && previousUpper === null)
      issues.push({ path: at('lower'), code: 'GAP', message: 'Só o último escalão fica aberto.' })
    if (i === brackets.length - 1 && upper !== null)
      issues.push({
        path: at('upper'),
        code: 'OPEN_LAST',
        message: 'O último escalão não tem limite.',
      })
    previousUpper = upper
  })
  return issues
}

/** Totais derivados das linhas (a fonte de verdade são as linhas). */
export function totalsOf(lines: PayLine[], bases: { inss: bigint; irt: bigint }): Totals {
  const sum = (f: (l: PayLine) => boolean) => lines.filter(f).reduce((a, l) => a + l.amount, 0n)
  const gross = sum((l) => l.kind === 'EARNING')
  const inssEmployee = sum((l) => l.source === 'INSS')
  const irt = sum((l) => l.source === 'IRT')
  const loans = sum((l) => l.source === 'LOAN')
  const deductions = sum(
    (l) => l.kind === 'DEDUCTION' && !['INSS', 'IRT', 'LOAN'].includes(l.source)
  )
  const inssEmployer = sum((l) => l.kind === 'EMPLOYER')
  return {
    gross,
    inssBase: bases.inss,
    irtBase: bases.irt,
    inssEmployee,
    irt,
    deductions,
    loans,
    net: gross - inssEmployee - irt - deductions - loans,
    inssEmployer,
    employerCost: gross + inssEmployer,
  }
}

/**
 * Recibo de um colaborador num mês. Ordem: salário base proporcional aos dias pagáveis; componentes (os recorrentes
 * de abono na mesma proporção); faltas não remuneradas (base ÷ dias da base × dias); bases de INSS e IRT pela
 * incidência de cada linha; INSS do trabalhador; IRT pela tabela sobre a base (menos o INSS, se as regras o dizem);
 * descontos autorizados e prestações de empréstimos; INSS da entidade patronal. Erros por colaborador em vez de
 * valores inventados (incidência por definir, IRT fora da tabela, líquido negativo).
 */
export function calculate(input: PayInput) {
  const r = input.rules
  const errors: ErrorDetail[] = []
  const lines: PayLine[] = []
  const basisDays = BigInt(r.dayBasis === 'FIXED_30' ? 30 : input.daysInMonth)
  const payable = input.base ? BigInt(Math.min(input.base.payableDays, input.daysInMonth)) : 0n
  const fullMonth = input.base ? payable === BigInt(input.daysInMonth) : true
  const factor = (amount: bigint) =>
    fullMonth ? amount : prorate(amount, payable, BigInt(input.daysInMonth))

  if (input.base) {
    const monthly = cents(input.base.amount) ?? 0n
    lines.push({
      code: 'BASE',
      name: 'Salário base',
      kind: 'EARNING',
      source: 'BASE',
      amount: factor(monthly),
      irtSubject: r.baseIrtSubject,
      inssSubject: r.baseInssSubject,
      refId: null,
    })
    for (const a of input.unpaidAbsences) {
      const days = cents(a.days) ?? 0n // dias × 100
      if (days <= 0n) continue
      lines.push({
        code: `FALTA-${a.code}`,
        name: `Faltas não remuneradas (${a.code})`,
        kind: 'EARNING',
        source: 'ABSENCE',
        amount: -divRound(monthly * days, basisDays * 100n),
        irtSubject: r.baseIrtSubject,
        inssSubject: r.baseInssSubject,
        refId: null,
      })
    }
  }

  let irtExempt = 0n
  for (const it of input.items) {
    const raw = cents(it.amount) ?? 0n
    const amount = it.kind === 'EARNING' && it.recurring && input.base ? factor(raw) : raw
    if (amount === 0n) continue
    if (it.kind === 'EARNING' && !it.incidence) {
      errors.push({
        path: it.code,
        code: 'MISSING_INCIDENCE',
        message: `${it.name}: incidência de IRT/INSS por definir nesta data.`,
      })
      continue
    }
    const inc = it.incidence ?? { irtSubject: false, irtExemptAmount: null, inssSubject: false }
    if (it.kind === 'EARNING' && inc.irtSubject && inc.irtExemptAmount) {
      const exempt = cents(inc.irtExemptAmount) ?? 0n
      irtExempt += amount < exempt ? amount : exempt
    }
    lines.push({
      code: it.code,
      name: it.name,
      kind: it.kind,
      source: 'COMPONENT',
      amount,
      irtSubject: it.kind === 'EARNING' && inc.irtSubject,
      inssSubject: it.kind === 'EARNING' && inc.inssSubject,
      refId: it.componentId,
    })
  }

  const earnings = lines.filter((l) => l.kind === 'EARNING')
  let inssBase = earnings.filter((l) => l.inssSubject).reduce((a, l) => a + l.amount, 0n)
  if (inssBase < 0n) inssBase = 0n
  const inssEmployee = applyRate(inssBase, r.inssEmployeeRate)
  let irtBase =
    earnings.filter((l) => l.irtSubject).reduce((a, l) => a + l.amount, 0n) -
    irtExempt -
    (r.irtBaseDeductsInss ? inssEmployee : 0n)
  if (irtBase < 0n) irtBase = 0n
  const irt = irtFor(irtBase, r.brackets)
  if (irt === null)
    errors.push({
      path: 'IRT',
      code: 'IRT_OUT_OF_TABLE',
      message: `A base de IRT (${moneyText(irtBase)}) não cabe em nenhum escalão da tabela.`,
    })
  const tax = (code: string, name: string, source: LineSource, kind: LineKind, amount: bigint) => {
    if (amount !== 0n)
      lines.push({
        code,
        name,
        kind,
        source,
        amount,
        irtSubject: false,
        inssSubject: false,
        refId: null,
      })
  }
  tax('INSS', 'Segurança social (trabalhador)', 'INSS', 'DEDUCTION', inssEmployee)
  tax('IRT', 'IRT', 'IRT', 'DEDUCTION', irt ?? 0n)
  for (const l of input.loans)
    lines.push({
      code: `PREST-${l.loanCode}`,
      name: `Prestação ${l.loanCode}`,
      kind: 'DEDUCTION',
      source: 'LOAN',
      amount: cents(l.amount) ?? 0n,
      irtSubject: false,
      inssSubject: false,
      refId: l.installmentId,
    })
  tax(
    'INSS-PATRONAL',
    'Segurança social (entidade patronal)',
    'INSS_EMPLOYER',
    'EMPLOYER',
    applyRate(inssBase, r.inssEmployerRate)
  )
  const totals = totalsOf(lines, { inss: inssBase, irt: irtBase })
  if (totals.net < 0n)
    errors.push({
      path: 'net',
      code: 'NEGATIVE_NET',
      message: `O líquido ficaria negativo (${moneyText(totals.net)}): reveja descontos e prestações.`,
    })
  return { lines, totals, errors }
}

/**
 * Processamento retroactivo: a diferença entre o recibo recalculado de um mês já fechado e o que foi processado
 * (regular e retroactivos anteriores), linha a linha por código e origem. As prestações de empréstimos não entram
 * (já foram descontadas ou não).
 */
export function difference(
  recalculated: PayLine[],
  previous: { code: string; name: string; kind: LineKind; source: LineSource; amount: bigint }[]
): PayLine[] {
  const key = (l: { code: string; kind: string; source: string }) =>
    `${l.kind}|${l.source}|${l.code}`
  const map = new Map<string, PayLine>()
  for (const l of recalculated) {
    if (l.source === 'LOAN') continue
    const k = key(l)
    const cur = map.get(k)
    map.set(k, cur ? { ...cur, amount: cur.amount + l.amount } : { ...l, refId: null })
  }
  for (const p of previous) {
    if (p.source === 'LOAN') continue
    const k = key(p)
    const cur = map.get(k)
    if (cur) map.set(k, { ...cur, amount: cur.amount - p.amount })
    else
      map.set(k, {
        code: p.code,
        name: p.name,
        kind: p.kind,
        source: p.source,
        amount: -p.amount,
        irtSubject: false,
        inssSubject: false,
        refId: null,
      })
  }
  return [...map.values()]
    .filter((l) => l.amount !== 0n)
    .map((l) => ({ ...l, name: `Diferença: ${l.name}` }))
}

/** Dias de um intervalo `[from, to]` (datas ISO) dentro de `[start, end]`. */
export function overlapDays(from: string, to: string, start: string, end: string): number {
  const a = from > start ? from : start
  const b = to < end ? to : end
  if (a > b) return 0
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1
}

export { moneyText }
