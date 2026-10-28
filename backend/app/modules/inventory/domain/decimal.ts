/**
 * Aritmética exacta do inventário: quantidades com 6 casas e custos com 4, sempre em `bigint` escalado (nunca `number`).
 * Os decimais atravessam a API como texto.
 */
export const QTY_SCALE = 6
export const COST_SCALE = 4

const POSITIVE = /^\d{1,13}(\.\d{1,6})?$/
const SIGNED = /^-?\d{1,13}(\.\d{1,6})?$/

function scaled(value: string, scale: number): bigint {
  const negative = value.startsWith('-')
  const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.')
  const result = BigInt(int + frac.padEnd(scale, '0'))
  return negative ? -result : result
}

/** Quantidade não negativa (até 6 casas) → inteiro escalado; `null` se o texto não for válido. */
export function parseQty(value: unknown): bigint | null {
  return typeof value === 'string' && POSITIVE.test(value) ? scaled(value, QTY_SCALE) : null
}

/** Quantidade com sinal (ajustes). */
export function parseSignedQty(value: unknown): bigint | null {
  return typeof value === 'string' && SIGNED.test(value) ? scaled(value, QTY_SCALE) : null
}

/** Custo unitário não negativo (até 4 casas). */
export function parseCost(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,15}(\.\d{1,4})?$/.test(value)) return null
  return scaled(value, COST_SCALE)
}

export function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const int = digits.slice(0, digits.length - scale)
  const frac = digits.slice(digits.length - scale)
  return `${negative ? '-' : ''}${int}.${frac}`
}

export const qtyText = (value: bigint) => fromScaled(value, QTY_SCALE)
export const costText = (value: bigint) => fromScaled(value, COST_SCALE)

/** Texto decimal da base de dados (`numeric`) → inteiro escalado. */
export function fromDb(value: string, scale: number): bigint {
  const negative = value.startsWith('-')
  const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.')
  const result = BigInt(int + frac.slice(0, scale).padEnd(scale, '0'))
  return negative ? -result : result
}

/** Divisão inteira arredondada ao mais próximo (o meio sobe), só para numeradores e denominadores positivos. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  return (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient
}
