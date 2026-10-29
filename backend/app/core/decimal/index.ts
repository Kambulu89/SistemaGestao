/**
 * Aritmética exacta partilhada (núcleo sem dependências): inteiros `bigint` com escala fixa e arredondamento explícito,
 * nunca `number`. Dinheiro tem 4 casas, quantidades 6 e taxas de imposto (percentagem) até 4. Os domínios dos módulos
 * importam daqui (a regra de arquitectura abre esta única excepção ao «domain só importa de si próprio»).
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

/** Escalas da plataforma: dinheiro `numeric(19,4)`, quantidades `numeric(19,6)`. */
export const MONEY_SCALE = 4
export const QUANTITY_SCALE = 6

/** Soma exacta de montantes em texto (4 casas); `null` se algum não for decimal válido. */
export function sumMoney(values: readonly string[]): string | null {
  let total = 0n
  for (const value of values) {
    const scaled = toScaled(value, MONEY_SCALE)
    if (scaled === null) return null
    total += scaled
  }
  return fromScaled(total, MONEY_SCALE)
}

/** Compara dois decimais em texto com a mesma escala de dinheiro: -1, 0 ou 1; `null` se algum for inválido. */
export function compareMoney(a: string, b: string): -1 | 0 | 1 | null {
  const x = toScaled(a, MONEY_SCALE)
  const y = toScaled(b, MONEY_SCALE)
  if (x === null || y === null) return null
  return x === y ? 0 : x < y ? -1 : 1
}
