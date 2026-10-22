import { SettingsRuleError } from '#core/settings/domain/errors'

/** Tokens do modelo de prefixo. Nada mais entre chavetas é aceite (sem código nem expressões do tenant). */
export const TEMPLATE_TOKENS = ['YYYY', 'YY', 'MM', 'SERIES', 'ORG', 'BRANCH'] as const
const TOKEN = /\{([A-Z]+)\}/g

export interface SequenceContext {
  /** Data do documento (UTC). */
  date: Date
  series: string
  organizationCode: string
  branchCode: string | null
}

export function validateTemplate(template: string): void {
  if (template.length > 100) {
    throw new SettingsRuleError(
      'prefixTemplate',
      'TEMPLATE_TOO_LONG',
      'O modelo tem no máximo 100 caracteres.'
    )
  }
  const unknown = [...template.matchAll(TOKEN)]
    .map((m) => m[1])
    .filter((t) => !(TEMPLATE_TOKENS as readonly string[]).includes(t))
  const stripped = template.replace(TOKEN, '')
  if (unknown.length > 0 || /[{}]/.test(stripped)) {
    throw new SettingsRuleError(
      'prefixTemplate',
      'INVALID_TEMPLATE',
      `Modelo inválido; use apenas ${TEMPLATE_TOKENS.map((t) => `{${t}}`).join(', ')}.`
    )
  }
}

const pad = (value: number, size: number) => String(value).padStart(size, '0')

export function renderPrefix(template: string, context: SequenceContext): string {
  const year = context.date.getUTCFullYear()
  const values: Record<string, string> = {
    YYYY: pad(year, 4),
    YY: pad(year % 100, 2),
    MM: pad(context.date.getUTCMonth() + 1, 2),
    SERIES: context.series,
    ORG: context.organizationCode,
    BRANCH: context.branchCode ?? '',
  }
  return template.replace(TOKEN, (_, token: string) => values[token] ?? '')
}

/** Número formatado; o preenchimento nunca trunca (um número maior que o `padding` mantém-se inteiro). */
export function formatNumber(
  template: string,
  padding: number,
  value: bigint,
  context: SequenceContext
): string {
  return `${renderPrefix(template, context)}${value.toString().padStart(padding, '0')}`
}

const PERIOD = /^(ALL|\d{4}|\d{4}-(0[1-9]|1[0-2]))$/
export const isValidPeriod = (period: string) => PERIOD.test(period)

/** Chaves de período a tentar, da mais específica para a mais geral: `2026-03`, `2026`, `ALL`. */
export function periodKeys(date: Date): string[] {
  const year = pad(date.getUTCFullYear(), 4)
  return [`${year}-${pad(date.getUTCMonth() + 1, 2)}`, year, 'ALL']
}
