/**
 * Aritmética exacta das linhas comerciais (M04). Nunca `number`: tudo em inteiros `bigint` com escala fixa e
 * arredondamento explícito. Dinheiro tem 4 casas, quantidades 6, taxas de desconto 4 (0..1) e a taxa de imposto é uma
 * percentagem com até 4 casas.
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

/** Divisão inteira arredondada (só valores não negativos): `HALF_UP` ou `HALF_EVEN` (arredonda o meio para o par). */
export function roundDiv(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  const twice = remainder * 2n
  if (twice > denominator) return quotient + 1n
  if (twice < denominator) return quotient
  if (mode === 'HALF_UP') return quotient + 1n
  return quotient % 2n === 0n ? quotient : quotient + 1n
}

export interface LineAmounts {
  net: string
  tax: string
  total: string
}

export interface LineInput {
  /** Quantidade (até 6 casas), preço unitário (até 4), desconto 0..1 (até 4) e imposto em percentagem (até 4). */
  quantity: string
  unitPrice: string
  discountRate: string
  taxRate: string
  /** O preço já inclui o imposto (o líquido sai do total). */
  taxInclusive: boolean
}

/**
 * Valores de uma linha: `qtd × preço × (1 − desconto)` arredondado uma vez a 4 casas; depois o imposto sobre o líquido
 * (preço sem imposto) ou o líquido extraído do total (preço com imposto). `total = líquido + imposto`, sempre.
 */
export function lineAmounts(input: LineInput, mode: RoundingMode): LineAmounts | null {
  const quantity = toScaled(input.quantity, 6)
  const price = toScaled(input.unitPrice, 4)
  const discount = toScaled(input.discountRate, 4)
  const taxRate = toScaled(input.taxRate, 4)
  if (quantity === null || price === null || discount === null || taxRate === null) return null
  if (discount > 10_000n) return null
  // escala 6 + 4 + 4 = 14; reduz a 4 casas.
  const discounted = quantity * price * (10_000n - discount)
  const money = roundDiv(discounted, 10n ** 10n, mode)
  const hundredPercent = 1_000_000n // 100 % com 4 casas
  let net: bigint
  let tax: bigint
  let total: bigint
  if (input.taxInclusive) {
    total = money
    net = roundDiv(total * hundredPercent, hundredPercent + taxRate, mode)
    tax = total - net
  } else {
    net = money
    tax = roundDiv(net * taxRate, hundredPercent, mode)
    total = net + tax
  }
  return { net: fromScaled(net, 4), tax: fromScaled(tax, 4), total: fromScaled(total, 4) }
}

export interface Totals {
  net: string
  tax: string
  total: string
}

/** Soma exacta dos valores das linhas já arredondadas: o total do documento é a soma das suas linhas. */
export function sumTotals(lines: readonly LineAmounts[]): Totals {
  let net = 0n
  let tax = 0n
  let total = 0n
  for (const line of lines) {
    net += toScaled(line.net, 4) ?? 0n
    tax += toScaled(line.tax, 4) ?? 0n
    total += toScaled(line.total, 4) ?? 0n
  }
  return { net: fromScaled(net, 4), tax: fromScaled(tax, 4), total: fromScaled(total, 4) }
}

/** Número de casas decimais de um texto decimal (0 se for inteiro). */
export const decimalPlaces = (value: string): number => value.split('.')[1]?.length ?? 0
