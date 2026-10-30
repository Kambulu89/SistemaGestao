/**
 * Catálogo (M03). Domínio puro: regras de produtos, variantes e tabelas de preços. Decimais atravessam sempre como texto
 * (dinheiro com 4 casas, quantidades com 6): nunca `number`.
 */
export type ProductType = 'GOODS' | 'SERVICE'
export type TrackingMode = 'NONE' | 'LOT' | 'SERIAL'
export const PRODUCT_TYPES: readonly ProductType[] = ['GOODS', 'SERVICE']
export const TRACKING_MODES: readonly TrackingMode[] = ['NONE', 'LOT', 'SERIAL']

export interface Issue {
  path: string
  code: string
  message: string
}

export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/
export const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/
export const BARCODE = /^[A-Za-z0-9._-]{4,80}$/
export const MONEY = /^\d{1,15}(\.\d{1,4})?$/
export const QUANTITY = /^\d{1,13}(\.\d{1,6})?$/
export const RATE = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/
export const CURRENCY = /^[A-Z]{3}$/
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null

/** Compara dois decimais em texto (sem `number`); `null` se algum não for um decimal não negativo. */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (value: string) => {
    if (!/^\d+(\.\d+)?$/.test(value)) return null
    const [int = '0', frac = ''] = value.split('.')
    return { int: int.replace(/^0+(?=\d)/, ''), frac: frac.replace(/0+$/, '') }
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  if (x.int.length !== y.int.length) return x.int.length < y.int.length ? -1 : 1
  if (x.int !== y.int) return x.int < y.int ? -1 : 1
  const size = Math.max(x.frac.length, y.frac.length)
  const fx = x.frac.padEnd(size, '0')
  const fy = y.frac.padEnd(size, '0')
  return fx === fy ? 0 : fx < fy ? -1 : 1
}

export const isPositiveQuantity = (value: unknown): value is string =>
  typeof value === 'string' && QUANTITY.test(value) && compareDecimals(value, '0') === 1

// --- categorias ---------------------------------------------------------------------------------------

export interface CategoryValues {
  code: string
  name: string
  parentId: string | null
}

export function categoryIssues(
  input: { code?: unknown; name?: unknown },
  creating: boolean
): Issue[] {
  const issues: Issue[] = []
  if (creating && (typeof input.code !== 'string' || !CODE.test(input.code))) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  if (input.name !== undefined && !text(input.name, 160)) {
    issues.push(issue('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).'))
  }
  return issues
}

// --- produtos -----------------------------------------------------------------------------------------

export interface ProductValues {
  code: string
  name: string
  description: string | null
  type: ProductType
  categoryId: string | null
  baseUnitId: string
  trackStock: boolean
  trackingMode: TrackingMode
  active: boolean
  taxCategory: string | null
}

export interface ProductInput {
  code?: unknown
  name?: unknown
  description?: unknown
  type?: unknown
  categoryId?: unknown
  baseUnitId?: unknown
  trackStock?: unknown
  trackingMode?: unknown
  active?: unknown
  taxCategory?: unknown
}

/**
 * Valida e completa um produto. Um serviço não controla nem rastreia stock (e não o pode pedir); um bem controla stock
 * por omissão; lotes e séries exigem controlar stock.
 */
export function normalizeProduct(
  input: ProductInput,
  base: ProductValues | null,
  issues: Issue[]
): ProductValues | null {
  const before = issues.length
  const code = base?.code ?? (typeof input.code === 'string' ? input.code.trim() : '')
  if (!base && !CODE.test(code)) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  const name = input.name === undefined ? (base?.name ?? null) : text(input.name, 200)
  if (!name) issues.push(issue('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 200).'))
  const type = (input.type ?? base?.type ?? 'GOODS') as ProductType
  if (!PRODUCT_TYPES.includes(type)) {
    issues.push(issue('type', 'INVALID_TYPE', `Tipo: ${PRODUCT_TYPES.join(' ou ')}.`))
  }
  const trackingMode = (input.trackingMode ?? base?.trackingMode ?? 'NONE') as TrackingMode
  if (!TRACKING_MODES.includes(trackingMode)) {
    issues.push(
      issue('trackingMode', 'INVALID_TRACKING', `Rastreio: ${TRACKING_MODES.join(', ')}.`)
    )
  }
  const trackStock =
    input.trackStock === undefined
      ? (base?.trackStock ?? type === 'GOODS')
      : (input.trackStock as boolean)
  if (typeof trackStock !== 'boolean') {
    issues.push(issue('trackStock', 'INVALID_FLAG', 'trackStock é booleano.'))
  }
  if (type === 'SERVICE' && (trackStock === true || trackingMode !== 'NONE')) {
    issues.push(
      issue(
        'type',
        'SERVICE_NO_STOCK',
        'Um serviço não controla nem rastreia stock (nem lotes, nem séries).'
      )
    )
  }
  if (type === 'GOODS' && trackingMode !== 'NONE' && trackStock !== true) {
    issues.push(
      issue('trackingMode', 'TRACKING_NEEDS_STOCK', 'Lotes e séries exigem controlar stock.')
    )
  }
  const baseUnitId = input.baseUnitId ?? base?.baseUnitId
  if (typeof baseUnitId !== 'string' || !baseUnitId) {
    issues.push(issue('baseUnitId', 'INVALID_UNIT', 'Indique a unidade base.'))
  }
  const description =
    input.description === undefined
      ? (base?.description ?? null)
      : input.description === null
        ? null
        : text(input.description, 1000)
  if (input.description !== undefined && input.description !== null && description === null) {
    issues.push(issue('description', 'INVALID_DESCRIPTION', 'Máx. 1000 caracteres.'))
  }
  const taxCategory =
    input.taxCategory === undefined
      ? (base?.taxCategory ?? null)
      : input.taxCategory === null
        ? null
        : text(input.taxCategory, 50)
  if (input.taxCategory !== undefined && input.taxCategory !== null && taxCategory === null) {
    issues.push(issue('taxCategory', 'INVALID_TAX_CATEGORY', 'Máx. 50 caracteres.'))
  }
  const active = input.active === undefined ? (base?.active ?? true) : input.active
  if (typeof active !== 'boolean') {
    issues.push(issue('active', 'INVALID_FLAG', 'active é booleano.'))
  }
  const categoryId =
    input.categoryId === undefined
      ? (base?.categoryId ?? null)
      : (input.categoryId as string | null)
  if (issues.length > before) return null
  return {
    code,
    name: name as string,
    description,
    type,
    categoryId,
    baseUnitId: baseUnitId as string,
    trackStock: type === 'SERVICE' ? false : (trackStock as boolean),
    trackingMode: type === 'SERVICE' ? 'NONE' : trackingMode,
    active: active as boolean,
    taxCategory,
  }
}

/** A unidade base e o modo de rastreio só mudam com movimentos se houver migração (ver D-046). */
export function stockIdentityChanged(before: ProductValues, after: ProductValues): boolean {
  return (
    before.baseUnitId !== after.baseUnitId ||
    before.trackingMode !== after.trackingMode ||
    before.trackStock !== after.trackStock
  )
}

// --- variantes ----------------------------------------------------------------------------------------

export interface VariantValues {
  sku: string
  barcode: string | null
  attributes: Record<string, string | number | boolean>
  active: boolean
}

export interface VariantInput {
  sku?: unknown
  barcode?: unknown
  attributes?: unknown
  active?: unknown
}

const MAX_ATTRIBUTES = 20

export function normalizeVariant(
  input: VariantInput,
  base: VariantValues | null,
  issues: Issue[]
): VariantValues | null {
  const before = issues.length
  const sku = base?.sku ?? (typeof input.sku === 'string' ? input.sku.trim() : '')
  if (!base && !SKU.test(sku)) {
    issues.push(issue('sku', 'INVALID_SKU', 'SKU: letras, números, . _ / - (máx. 80).'))
  }
  if (base && input.sku !== undefined && input.sku !== base.sku) {
    issues.push(issue('sku', 'SKU_IMMUTABLE', 'O SKU identifica a variante e não se altera.'))
  }
  const barcode =
    input.barcode === undefined
      ? (base?.barcode ?? null)
      : input.barcode === null
        ? null
        : typeof input.barcode === 'string'
          ? input.barcode.trim()
          : ''
  if (barcode !== null && !BARCODE.test(barcode)) {
    issues.push(
      issue(
        'barcode',
        'INVALID_BARCODE',
        'Código de barras: 4 a 80 caracteres (letras, números, . _ -).'
      )
    )
  }
  const attributes = input.attributes === undefined ? (base?.attributes ?? {}) : input.attributes
  const clean: Record<string, string | number | boolean> = {}
  if (!isRecord(attributes) || Object.keys(attributes).length > MAX_ATTRIBUTES) {
    issues.push(
      issue(
        'attributes',
        'INVALID_ATTRIBUTES',
        `Até ${MAX_ATTRIBUTES} atributos (nome e valor simples).`
      )
    )
  } else {
    for (const [name, value] of Object.entries(attributes)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(name)) {
        issues.push(
          issue(`attributes.${name}`, 'INVALID_ATTRIBUTE_NAME', 'Nome de atributo inválido.')
        )
      } else if (typeof value === 'string' && value.length <= 200) clean[name] = value
      else if (typeof value === 'number' && Number.isFinite(value)) clean[name] = value
      else if (typeof value === 'boolean') clean[name] = value
      else
        issues.push(
          issue(`attributes.${name}`, 'INVALID_ATTRIBUTE', 'Valor: texto, número ou booleano.')
        )
    }
  }
  const active = input.active === undefined ? (base?.active ?? true) : input.active
  if (typeof active !== 'boolean')
    issues.push(issue('active', 'INVALID_FLAG', 'active é booleano.'))
  if (issues.length > before) return null
  return { sku, barcode, attributes: clean, active: active as boolean }
}

// --- tabelas de preços --------------------------------------------------------------------------------

export interface PriceListValues {
  organizationId: string
  name: string
  currency: string
  validFrom: string
  validTo: string | null
  taxInclusive: boolean
  priority: number
}

export interface PriceListInput {
  organizationId?: unknown
  name?: unknown
  currency?: unknown
  validFrom?: unknown
  validTo?: unknown
  taxInclusive?: unknown
  priority?: unknown
}

const validDate = (value: string): boolean => {
  if (!ISO_DATE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
}
export const isIsoDate = validDate

export function normalizePriceList(
  input: PriceListInput,
  base: PriceListValues | null,
  issues: Issue[]
): PriceListValues | null {
  const before = issues.length
  const organizationId = base?.organizationId ?? input.organizationId
  if (typeof organizationId !== 'string' || !organizationId) {
    issues.push(issue('organizationId', 'INVALID_ORGANIZATION', 'Indique a organização.'))
  }
  if (base && input.organizationId !== undefined && input.organizationId !== base.organizationId) {
    issues.push(
      issue('organizationId', 'ORGANIZATION_IMMUTABLE', 'A organização da tabela não se altera.')
    )
  }
  const name = input.name === undefined ? (base?.name ?? null) : text(input.name, 160)
  if (!name) issues.push(issue('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).'))
  const currency = input.currency ?? base?.currency
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda: 3 letras maiúsculas (ex.: AOA).'))
  }
  if (base && input.currency !== undefined && input.currency !== base.currency) {
    issues.push(
      issue('currency', 'CURRENCY_IMMUTABLE', 'A moeda da tabela não se altera: crie outra tabela.')
    )
  }
  const validFrom = input.validFrom ?? base?.validFrom
  if (typeof validFrom !== 'string' || !validDate(validFrom)) {
    issues.push(issue('validFrom', 'INVALID_DATE', 'Data inválida (AAAA-MM-DD).'))
  }
  const validTo = input.validTo === undefined ? (base?.validTo ?? null) : input.validTo
  if (validTo !== null && (typeof validTo !== 'string' || !validDate(validTo))) {
    issues.push(issue('validTo', 'INVALID_DATE', 'Data inválida (AAAA-MM-DD).'))
  }
  if (
    typeof validFrom === 'string' &&
    typeof validTo === 'string' &&
    validDate(validFrom) &&
    validDate(validTo) &&
    validTo < validFrom
  ) {
    issues.push(issue('validTo', 'INVALID_PERIOD', 'O fim não pode ser anterior ao início.'))
  }
  const taxInclusive = input.taxInclusive ?? base?.taxInclusive ?? false
  if (typeof taxInclusive !== 'boolean') {
    issues.push(issue('taxInclusive', 'INVALID_FLAG', 'taxInclusive é booleano.'))
  }
  const priority = input.priority ?? base?.priority ?? 0
  if (
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < -1000 ||
    priority > 1000
  ) {
    issues.push(
      issue('priority', 'INVALID_PRIORITY', 'A prioridade é um inteiro entre -1000 e 1000.')
    )
  }
  if (issues.length > before) return null
  return {
    organizationId: organizationId as string,
    name: name as string,
    currency: currency as string,
    validFrom: validFrom as string,
    validTo: validTo as string | null,
    taxInclusive: taxInclusive as boolean,
    priority: priority as number,
  }
}

export interface PriceItemValues {
  variantId: string
  minQuantity: string
  unitPrice: string
  maxDiscount: string
}

export function normalizePriceItem(
  input: { variantId?: unknown; minQuantity?: unknown; unitPrice?: unknown; maxDiscount?: unknown },
  issues: Issue[]
): PriceItemValues | null {
  const before = issues.length
  if (typeof input.variantId !== 'string' || !input.variantId) {
    issues.push(issue('variantId', 'INVALID_VARIANT', 'Indique a variante.'))
  }
  const minQuantity = input.minQuantity ?? '1'
  if (!isPositiveQuantity(minQuantity)) {
    issues.push(
      issue(
        'minQuantity',
        'INVALID_QUANTITY',
        'Quantidade mínima: decimal positivo em texto (até 6 casas).'
      )
    )
  }
  if (typeof input.unitPrice !== 'string' || !MONEY.test(input.unitPrice)) {
    issues.push(
      issue('unitPrice', 'INVALID_PRICE', 'Preço: decimal não negativo em texto (até 4 casas).')
    )
  }
  const maxDiscount = input.maxDiscount ?? '0'
  if (typeof maxDiscount !== 'string' || !RATE.test(maxDiscount)) {
    issues.push(
      issue(
        'maxDiscount',
        'INVALID_DISCOUNT',
        'Desconto máximo: taxa entre 0 e 1 em texto (ex.: 0.15).'
      )
    )
  }
  if (issues.length > before) return null
  return {
    variantId: input.variantId as string,
    minQuantity: minQuantity as string,
    unitPrice: input.unitPrice as string,
    maxDiscount: maxDiscount as string,
  }
}

// --- resolução de preço -------------------------------------------------------------------------------

/** Um preço aplicável encontrado numa tabela (já filtrado por organização, moeda, validade e escalão ≤ quantidade). */
export interface PriceCandidate {
  priceListId: string
  priceListName: string
  priority: number
  taxInclusive: boolean
  currency: string
  validFrom: string
  validTo: string | null
  minQuantity: string
  unitPrice: string
  maxDiscount: string
}

export type PriceResolution =
  | { kind: 'FOUND'; price: PriceCandidate }
  | { kind: 'NONE' }
  | { kind: 'AMBIGUOUS'; lists: { id: string; name: string }[] }

/**
 * Escolhe o preço: em cada tabela vale o escalão mais alto que a quantidade alcança; entre tabelas vence a de **maior
 * prioridade**. Duas tabelas aplicáveis com a mesma prioridade máxima são um empate ambíguo — nunca se desempata ao acaso.
 */
export function pickPrice(candidates: readonly PriceCandidate[]): PriceResolution {
  const perList = new Map<string, PriceCandidate>()
  for (const c of candidates) {
    const current = perList.get(c.priceListId)
    if (!current || compareDecimals(c.minQuantity, current.minQuantity) === 1)
      perList.set(c.priceListId, c)
  }
  const best = [...perList.values()]
  if (best.length === 0) return { kind: 'NONE' }
  const top = Math.max(...best.map((c) => c.priority))
  const winners = best.filter((c) => c.priority === top)
  if (winners.length > 1) {
    return {
      kind: 'AMBIGUOUS',
      lists: winners.map((w) => ({ id: w.priceListId, name: w.priceListName })),
    }
  }
  return { kind: 'FOUND', price: winners[0] as PriceCandidate }
}
