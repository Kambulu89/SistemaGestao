/**
 * Aritmética exacta da facturação: inteiros `bigint` com escala fixa e arredondamento explícito (nunca `number`). Dinheiro
 * tem 4 casas, quantidades 6 e taxas de imposto (percentagem) até 4. É a mesma convenção das encomendas, mantida aqui para
 * que o domínio não dependa de outro módulo.
 */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN'

const DECIMAL = /^\d{1,15}(\.\d{1,6})?$/

/** Texto decimal → inteiro na escala indicada (acrescenta zeros; recusa mais casas do que a escala). */
export function toScaled(value: string, scale: number): bigint | null {
  if (!DECIMAL.test(value)) return null
  const [int = '0', frac = ''] = value.split('.')
  if (frac.length > scale) return null
  return BigInt(int + frac.padEnd(scale, '0'))
}

/** Inteiro escalado → texto decimal com exactamente `scale` casas. */
export function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const int = digits.slice(0, digits.length - scale)
  const frac = digits.slice(digits.length - scale)
  return `${negative ? '-' : ''}${int}${scale > 0 ? `.${frac}` : ''}`
}

/** Divisão inteira arredondada (só valores não negativos): `HALF_UP` ou `HALF_EVEN` (o meio vai para o par). */
export function roundDiv(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  const twice = remainder * 2n
  if (twice > denominator) return quotient + 1n
  if (twice < denominator) return quotient
  if (mode === 'HALF_UP') return quotient + 1n
  return quotient % 2n === 0n ? quotient : quotient + 1n
}
