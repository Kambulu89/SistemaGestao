import type { Issue } from '#dynamic/metadata/domain/field_types'

/** Valores escalares tipados: decimais exactos (sem float), datas civis e instantes. */

const DECIMAL = /^-?\d{1,19}(\.\d{1,19})?$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

export interface DecimalShape {
  precision: number
  scale: number
}

/** Converte uma string decimal em inteiro escalado (BigInt), ou devolve o motivo da recusa. */
export function parseDecimal(
  raw: string,
  shape: DecimalShape
): { ok: true; scaled: bigint; canonical: string } | { ok: false; code: string; message: string } {
  if (!DECIMAL.test(raw)) {
    return {
      ok: false,
      code: 'INVALID_DECIMAL',
      message: 'Indique um decimal em texto (ex.: 12.50).',
    }
  }
  const negative = raw.startsWith('-')
  const [intPart, fracPart = ''] = raw.replace('-', '').split('.')
  if (fracPart.length > shape.scale) {
    return {
      ok: false,
      code: 'TOO_MANY_DECIMALS',
      message: `No máximo ${shape.scale} casas decimais.`,
    }
  }
  const integer = intPart.replace(/^0+(?=\d)/, '')
  if (integer.length > shape.precision - shape.scale) {
    return {
      ok: false,
      code: 'TOO_MANY_DIGITS',
      message: `No máximo ${shape.precision - shape.scale} dígitos inteiros.`,
    }
  }
  const frac = fracPart.padEnd(shape.scale, '0')
  const magnitude = BigInt(integer + frac)
  const scaled = negative ? -magnitude : magnitude
  const sign = scaled < 0n ? '-' : ''
  return {
    ok: true,
    scaled,
    canonical: `${sign}${integer}${shape.scale > 0 ? `.${frac}` : ''}`,
  }
}

function validCivilDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export function parseDate(raw: string): string | null {
  const match = DATE.exec(raw)
  if (!match) return null
  return validCivilDate(Number(match[1]), Number(match[2]), Number(match[3])) ? raw : null
}

/** Instante ISO 8601 com fuso horário, normalizado para UTC (`…Z`). */
export function parseInstant(raw: string): string | null {
  const match = DATETIME.exec(raw)
  if (!match) return null
  if (!validCivilDate(Number(match[1]), Number(match[2]), Number(match[3]))) return null
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) return null
  const time = Date.parse(raw)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  return value.length <= 254 && EMAIL.test(value) ? value : null
}

export function normalizePhone(raw: string): string | null {
  const value = raw.replace(/[\s().-]/g, '')
  return /^\+?\d{6,20}$/.test(value) ? value : null
}

/** Só `http` e `https`; nunca se faz um pedido ao endereço para o validar. */
export function normalizeUrl(raw: string): string | null {
  const value = raw.trim()
  if (value.length > 2000) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Padrões de texto "seguros": comprimento limitado e sem grupos repetidos sem limite, retrovisores nem
 * asserções, que são a origem do retrocesso exponencial. Com o comprimento do valor limitado (255), o
 * custo da validação fica limitado.
 */
export function checkPattern(pattern: string): Issue | null {
  const bad = (message: string): Issue => ({
    path: 'validation.pattern',
    code: 'UNSAFE_PATTERN',
    message,
  })
  if (pattern.length === 0 || pattern.length > 200)
    return bad('O padrão tem de ter 1 a 200 caracteres.')
  if (/\)\s*(?:[*+]|\{\d+,\})/.test(pattern))
    return bad('Grupos repetidos sem limite não são permitidos.')
  if (/\\[1-9k]|\(\?[=!<]/.test(pattern)) return bad('Retrovisores e asserções não são permitidos.')
  try {
    new RegExp(pattern, 'u')
  } catch {
    return { path: 'validation.pattern', code: 'INVALID_PATTERN', message: 'Padrão inválido.' }
  }
  return null
}
