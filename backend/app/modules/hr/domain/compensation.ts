import type { ErrorDetail } from '#shared/http/api_error'
import { cents } from '#modules/hr/domain/recruitment'

/**
 * Compensação e benefícios (7.5): regras puras. O salário base vive no contrato (7.3); aqui ficam os outros componentes
 * (subsídios, prémios, horas extra, abonos, descontos). Nenhuma taxa ou limite legal está fixado: a incidência de IRT e
 * INSS de cada componente é configurada pela empresa, com fonte e data de início.
 */

export const PAY_KINDS = ['EARNING', 'DEDUCTION'] as const
export const PAY_CATEGORIES = [
  'ALLOWANCE',
  'BONUS',
  'OVERTIME',
  'BENEFIT',
  'DEDUCTION',
  'OTHER',
] as const
export const PAY_CALCULATIONS = ['FIXED', 'PERCENT_OF_BASE', 'VARIABLE'] as const
export type PayCalculation = (typeof PAY_CALCULATIONS)[number]
export const PROPOSAL_ACTIONS = ['SET', 'REMOVE'] as const

/** Percentagem com até 4 casas → décimas-milésimas de ponto percentual (ex.: "12.5" → 125000n). */
export function percentUnits(raw: unknown): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string' || !/^\d{1,3}(\.\d{1,4})?$/.test(v.trim())) return null
  const [i, f = ''] = v.trim().split('.')
  const units = BigInt(i) * 10000n + BigInt(f.padEnd(4, '0'))
  return units > 1000000n ? null : units
}

/** Texto canónico da percentagem com 4 casas (como `numeric(7,4)`). */
export function percentText(units: bigint): string {
  const s = units.toString().padStart(5, '0')
  return `${s.slice(0, -4)}.${s.slice(-4)}`
}

export function moneyText(c: bigint): string {
  const neg = c < 0n
  const s = (neg ? -c : c).toString().padStart(3, '0')
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`
}

/** Valor de uma percentagem do salário base, arredondado ao cêntimo (meio para cima). */
export function percentOf(baseSalary: string, percent: string): string {
  const base = cents(baseSalary) ?? 0n
  const p = percentUnits(percent) ?? 0n
  const denominator = 1000000n // 100 (%) × 10 000 (4 casas)
  return moneyText((base * p * 2n + denominator) / (2n * denominator))
}

/**
 * Linhas da proposta: componente, acção e valor (montante ou percentagem conforme o cálculo do componente). O
 * componente tem de existir, estar activo e não ser variável (os variáveis entram por período no processamento).
 */
export function lineIssues(
  lines: unknown,
  components: Map<string, { calculation: PayCalculation; status: string }>
): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  if (!Array.isArray(lines) || lines.length === 0)
    return [{ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos um componente.' }]
  if (lines.length > 50)
    return [{ path: 'lines', code: 'TOO_MANY', message: 'No máximo 50 linhas.' }]
  const seen = new Set<string>()
  lines.forEach((l: any, i) => {
    const path = `lines.${i}`
    const c = typeof l?.componentId === 'string' ? components.get(l.componentId) : undefined
    if (!c)
      return issues.push({
        path: `${path}.componentId`,
        code: 'NOT_FOUND',
        message: 'Componente inexistente.',
      })
    if (seen.has(l.componentId))
      issues.push({
        path: `${path}.componentId`,
        code: 'DUPLICATE',
        message: 'Componente repetido.',
      })
    seen.add(l.componentId)
    if (!PROPOSAL_ACTIONS.includes(l.action))
      issues.push({ path: `${path}.action`, code: 'INVALID', message: 'Definir ou remover.' })
    if (l.action !== 'SET') return
    if (c.status !== 'ACTIVE')
      issues.push({
        path: `${path}.componentId`,
        code: 'INACTIVE',
        message: 'Componente inactivo.',
      })
    if (c.calculation === 'VARIABLE')
      issues.push({
        path: `${path}.componentId`,
        code: 'VARIABLE_COMPONENT',
        message: 'Componente variável: o valor entra em cada processamento, não na ficha.',
      })
    else if (c.calculation === 'FIXED') {
      const a = cents(l.amount)
      if (a === null || a <= 0n)
        issues.push({
          path: `${path}.amount`,
          code: 'INVALID_AMOUNT',
          message: 'Montante positivo (até 2 casas).',
        })
    } else {
      const p = percentUnits(l.percent)
      if (p === null || p <= 0n)
        issues.push({
          path: `${path}.percent`,
          code: 'INVALID_PERCENT',
          message: 'Percentagem entre 0 e 100 (até 4 casas).',
        })
    }
  })
  return issues
}

/** Coerência entre categoria e natureza: descontos são DEDUCTION; o resto são abonos (EARNING). */
export function componentIssues(v: Record<string, unknown>): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  if (v.category === 'DEDUCTION' && v.kind !== 'DEDUCTION')
    issues.push({
      path: 'kind',
      code: 'INCONSISTENT',
      message: 'Um desconto tem natureza de desconto.',
    })
  if (v.kind === 'DEDUCTION' && v.category !== 'DEDUCTION')
    issues.push({ path: 'category', code: 'INCONSISTENT', message: 'Use a categoria "Desconto".' })
  return issues
}
