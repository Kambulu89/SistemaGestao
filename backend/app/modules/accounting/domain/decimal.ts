/**
 * Decimais exactos sobre BigInt (nunca `float`): valores escalados por 10^escala. Usado para somar e converter
 * montantes contabilísticos com o arredondamento configurado pela empresa.
 */
export type Rounding = 'HALF_UP' | 'HALF_EVEN'

const DECIMAL = /^(\d{1,18})(?:\.(\d+))?$/

/** Lê um decimal positivo ou zero ("123.45"); null se inválido ou com mais casas do que `scale`. */
export function parseDecimal(raw: unknown, scale: number): bigint | null {
  const text = typeof raw === 'number' ? String(raw) : raw
  if (typeof text !== 'string') return null
  const m = DECIMAL.exec(text.trim())
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return null
  return BigInt(m[1] + frac.slice(0, scale).padEnd(scale, '0'))
}

export function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const int = digits.slice(0, digits.length - scale)
  const frac = scale > 0 ? '.' + digits.slice(digits.length - scale) : ''
  return (negative ? '-' : '') + int + frac
}

/** Divide `n` por `d` (> 0) arredondando conforme o modo. */
export function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  const negative = n < 0n
  const a = negative ? -n : n
  let q = a / d
  const r = a % d
  const twice = r * 2n
  if (twice > d || (twice === d && (mode === 'HALF_UP' || q % 2n === 1n))) q += 1n
  return negative ? -q : q
}

/** `amount` (escala `amountScale`) × `rate` (escala `rateScale`), arredondado para `outScale`. */
export function multiply(
  amount: bigint,
  amountScale: number,
  rate: bigint,
  rateScale: number,
  outScale: number,
  mode: Rounding
): bigint {
  const product = amount * rate
  const shift = amountScale + rateScale - outScale
  if (shift >= 0) return divRound(product, 10n ** BigInt(shift), mode)
  return product * 10n ** BigInt(-shift)
}

/** Muda a escala de um valor (arredonda ao reduzir). */
export function rescale(value: bigint, from: number, to: number, mode: Rounding): bigint {
  if (to >= from) return value * 10n ** BigInt(to - from)
  return divRound(value, 10n ** BigInt(from - to), mode)
}
