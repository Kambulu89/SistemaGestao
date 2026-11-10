import type { ErrorDetail } from '#shared/http/api_error'

/** Regras puras do catálogo (8.1): códigos, códigos de barras GTIN, decimais exactos e coerência do produto. */

export const PRODUCT_TYPES = ['STOCKABLE', 'SERVICE', 'KIT'] as const
export type ProductType = (typeof PRODUCT_TYPES)[number]
export const PRODUCT_STATUSES = ['ACTIVE', 'INACTIVE', 'DISCONTINUED'] as const
export const UOM_CATEGORIES = [
  'UNIT',
  'WEIGHT',
  'VOLUME',
  'LENGTH',
  'AREA',
  'TIME',
  'OTHER',
] as const

const SKU = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,39}$/
const ACCOUNTING_CLASS = /^[A-Z][A-Z0-9_]{1,29}$/

export const isSku = (v: unknown): v is string => typeof v === 'string' && SKU.test(v)
export const isAccountingClass = (v: unknown): v is string =>
  typeof v === 'string' && ACCOUNTING_CLASS.test(v)

/** Dígito de controlo GTIN (EAN-8, UPC-A, EAN-13, GTIN-14): pesos 3/1 a partir da direita, sem o último dígito. */
export function gtinCheckDigit(body: string) {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i])
    sum += i % 2 === 0 ? d * 3 : d
  }
  return (10 - (sum % 10)) % 10
}

/**
 * Código de barras: numérico de 8, 12, 13 ou 14 dígitos tem de ter o dígito de controlo GTIN certo; outros (Code 128,
 * internos) aceitam-se se forem ASCII imprimível sem espaços, até 48 caracteres. Devolve o código normalizado ou um
 * erro.
 */
export function checkBarcode(raw: string): { value: string } | { error: string } {
  const v = raw.trim()
  if (/^\d+$/.test(v) && [8, 12, 13, 14].includes(v.length)) {
    return gtinCheckDigit(v.slice(0, -1)) === Number(v.at(-1))
      ? { value: v }
      : { error: 'Dígito de controlo GTIN inválido.' }
  }
  if (!/^[\x21-\x7E]{1,48}$/.test(v)) return { error: 'Código de barras inválido.' }
  return { value: v }
}

/** Decimal não negativo com até `scale` casas → inteiro escalado; `null` se inválido. */
export function scaled(raw: unknown, scale: number): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${scale}})?$`).test(t)) return null
  const [int, frac = ''] = t.split('.')
  return BigInt(int) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0') || '0')
}

export function scaledText(v: bigint, scale: number) {
  const neg = v < 0n
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0')
  return `${neg ? '-' : ''}${s.slice(0, -scale)}.${s.slice(-scale)}`
}

/** Quantidade numa unidade alternativa → unidades base (`factor` = unidades base por 1 alternativa), 6 casas. */
export function toBase(quantity: bigint, factor: bigint) {
  // Ambos com 6 casas: produto com 12 → arredonda a 6, meio para cima.
  const p = quantity * factor
  const unit = 10n ** 6n
  return (p * 2n + unit) / (2n * unit)
}

/** A quantidade (6 casas) respeita as casas decimais da unidade? */
export function fitsDecimals(quantity: bigint, decimals: number) {
  return quantity % 10n ** BigInt(6 - decimals) === 0n
}

/** Atributos de variante: 1 a 5 pares nome→valor de texto curto; chaves e valores aparados. */
export function normalizeAttributes(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim()
    const value = typeof v === 'string' ? v.trim() : ''
    if (!key || key.length > 40 || !value || value.length > 60) return null
    out[key] = value
  }
  const n = Object.keys(out).length
  return n >= 1 && n <= 5 ? out : null
}

/** Chave canónica dos atributos (para detectar variantes repetidas, ignorando ordem e maiúsculas). */
export function attributesKey(a: Record<string, string>) {
  return Object.keys(a)
    .map((k) => `${k.toLowerCase()}=${a[k].toLowerCase()}`)
    .sort()
    .join('|')
}

export interface ProductFacts {
  type: ProductType
  trackLots: boolean
  trackSerials: boolean
  trackExpiry: boolean
  shelfLifeDays: number | null
  minStock: bigint | null
  maxStock: bigint | null
  baseUomDecimals: number | null
  baseUomId: string
  purchaseUomId: string | null
  saleUomId: string | null
  conversionUomIds: string[]
  hasVariants: boolean
}

/** Coerência do produto: serviços/kits sem stock, série com unidade inteira, validade com rastreio, UOM convertíveis. */
export function productIssues(p: ProductFacts): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  const stock = p.type === 'STOCKABLE'
  if (!stock) {
    for (const [k, on] of [
      ['trackLots', p.trackLots],
      ['trackSerials', p.trackSerials],
      ['trackExpiry', p.trackExpiry],
    ] as const)
      if (on)
        issues.push({
          path: k,
          code: 'NOT_STOCKABLE',
          message: 'Serviços e kits não movimentam stock: sem lotes, séries nem validade.',
        })
    if (p.minStock !== null || p.maxStock !== null)
      issues.push({
        path: 'minStock',
        code: 'NOT_STOCKABLE',
        message: 'Serviços e kits não têm stock mínimo nem máximo.',
      })
  }
  if (p.type === 'KIT' && p.hasVariants)
    issues.push({ path: 'hasVariants', code: 'KIT_VARIANTS', message: 'Um kit não tem variantes.' })
  if (p.trackSerials && p.baseUomDecimals !== null && p.baseUomDecimals !== 0)
    issues.push({
      path: 'baseUomId',
      code: 'SERIAL_DECIMALS',
      message: 'Com números de série, a unidade base tem de ser inteira (0 casas decimais).',
    })
  if (p.shelfLifeDays !== null && !p.trackExpiry)
    issues.push({
      path: 'shelfLifeDays',
      code: 'EXPIRY_REQUIRED',
      message: 'O prazo de validade exige o controlo de validade.',
    })
  if (p.minStock !== null && p.maxStock !== null && p.minStock > p.maxStock)
    issues.push({
      path: 'maxStock',
      code: 'MIN_MAX',
      message: 'O stock máximo não pode ser inferior ao mínimo.',
    })
  const convertible = new Set([p.baseUomId, ...p.conversionUomIds])
  for (const k of ['purchaseUomId', 'saleUomId'] as const) {
    const u = p[k]
    if (u && !convertible.has(u))
      issues.push({
        path: k,
        code: 'NO_CONVERSION',
        message: 'Use a unidade base ou uma unidade com conversão definida no produto.',
      })
  }
  return issues
}
