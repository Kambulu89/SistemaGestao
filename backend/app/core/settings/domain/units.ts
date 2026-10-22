import { SettingsRuleError } from '#core/settings/domain/errors'

const SCALE = 6
const ONE = 10n ** BigInt(SCALE)
const DECIMAL = /^(\d{1,13})(?:\.(\d{1,6}))?$/

/** Decimal em string → inteiro com 6 casas (sem floats). */
export function toScaled(value: string): bigint {
  const m = DECIMAL.exec(value)
  if (!m) {
    throw new SettingsRuleError(
      'quantity',
      'INVALID_QUANTITY',
      'Quantidade decimal ≥ 0 com até 6 casas.'
    )
  }
  return BigInt(m[1]) * ONE + BigInt((m[2] ?? '').padEnd(SCALE, '0'))
}

export function fromScaled(value: bigint, digits: number): string {
  const text = value.toString().padStart(SCALE + 1, '0')
  const whole = text.slice(0, -SCALE)
  const frac = text.slice(-SCALE).slice(0, digits)
  return digits === 0 ? whole : `${whole}.${frac}`
}

export interface ConvertibleUnit {
  code: string
  dimension: string
  precision: number
  /** `null` = unidade base; senão 1 unidade = `factor` unidades base. */
  baseUnitId: string | null
  factor: string | null
}

/** Divisão inteira arredondada (meio para cima). */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n)
}

/**
 * Converte entre unidades **da mesma dimensão** com aritmética exacta, arredondando (meio para cima) à
 * precisão da unidade de destino. Dimensões diferentes nunca convertem.
 */
export function convert(quantity: string, from: ConvertibleUnit, to: ConvertibleUnit): string {
  if (from.dimension !== to.dimension) {
    throw new SettingsRuleError(
      'to',
      'INCOMPATIBLE_DIMENSIONS',
      `${from.code} (${from.dimension}) não converte para ${to.code} (${to.dimension}).`
    )
  }
  const q = toScaled(quantity)
  const factorOf = (u: ConvertibleUnit) => (u.factor === null ? ONE : toScaled(u.factor))
  // q·from / to, tudo com 6 casas; depois reduz à precisão do destino.
  const rescale = 10n ** BigInt(SCALE - to.precision)
  const result = roundDiv(q * factorOf(from), factorOf(to) * rescale) * rescale
  return fromScaled(result, to.precision)
}
