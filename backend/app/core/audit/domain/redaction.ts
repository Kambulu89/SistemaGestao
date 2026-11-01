/**
 * Redacção de dados para a auditoria e para os eventos de segurança: nunca se guardam segredos.
 * É uma segunda linha de defesa — os triggers já redigem colunas sensíveis — para metadados montados
 * pela aplicação. Qualquer chave que pareça um segredo fica `[REDACTED]`, a profundidade e o tamanho
 * são limitados e valores não JSON (funções, símbolos) desaparecem.
 */
export const REDACTED = '[REDACTED]'

const SENSITIVE_KEY =
  /pass(word)?|secret|token|hash|csrf|cookie|authorization|api[-_]?key|credential|signature|otp|pin$/i

const MAX_DEPTH = 6
const MAX_ITEMS = 50
const MAX_STRING = 500

export function redactSecrets(
  value: unknown,
  extraKeys: readonly string[] = [],
  depth = 0
): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => redactSecrets(item, extraKeys, depth + 1))
  }
  if (typeof value === 'object') {
    const extra = new Set(extraKeys)
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_ITEMS
    )) {
      if (typeof child === 'function' || typeof child === 'symbol') continue
      out[key] =
        SENSITIVE_KEY.test(key) || extra.has(key)
          ? REDACTED
          : redactSecrets(child, extraKeys, depth + 1)
    }
    return out
  }
  return undefined
}

/** `birth_date` → `birthDate` (a API é camelCase; a auditoria guarda as colunas). */
export const camelCase = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

export const snakeCase = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** Converte as chaves de um objecto de linha (snake_case) para camelCase, só ao nível raiz. */
export function camelKeys(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (row === null) return null
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camelCase(key), value]))
}
