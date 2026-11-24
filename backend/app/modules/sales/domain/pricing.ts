import { createHash } from 'node:crypto'
import type { ErrorDetail } from '#shared/http/api_error'

/*
 * Preços e descontos (10.2) — regras puras.
 *
 * Valores em inteiros escalados (nunca `float`): preço com 4 casas, quantidade com 6, percentagem com 2.
 *
 * Resolução do preço de uma linha (cliente, moeda, data, entidade, produto/variante, quantidade):
 *  1. Tabelas activas na moeda, em vigor na data, da entidade (ou de todas), do cliente, do seu segmento ou gerais,
 *     com linha do produto (ou da variante) cujo escalão mínimo a quantidade atinge. Ganha a mais específica
 *     (cliente > segmento > geral), depois a de maior prioridade, depois a que começou mais tarde, depois o código.
 *     Dentro dela: a linha da variante antes da do produto, e o maior escalão atingido.
 *  2. Sem tabela: o preço de venda do catálogo (variante ou produto) se estiver na mesma moeda.
 *  3. Sem nenhum: preço manual, que exige aprovação; sem preço manual, a linha fica sem preço (`NO_PRICE`).
 *  4. Desconto automático: uma só regra (não acumulam) — maior prioridade, depois cliente > segmento > todos, depois
 *     produto > categoria > todos, depois o código. Já foi aprovada ao activar-se: não conta para o limite.
 *  5. Desconto manual (percentagem, ou preço manual abaixo do preço com a regra) sobre o preço com a regra. O limite
 *     sem aprovação é o do cliente, senão o do segmento, senão o geral, senão 0; o limite da linha da tabela, se for
 *     menor, prevalece. Acima do limite, o documento precisa de aprovação.
 */

export const PRICING_STATUSES = ['DRAFT', 'PENDING', 'ACTIVE', 'INACTIVE'] as const
export type PricingStatus = (typeof PRICING_STATUSES)[number]
export const LIST_TARGETS = ['GENERAL', 'SEGMENT', 'CUSTOMER'] as const
export type ListTarget = (typeof LIST_TARGETS)[number]
export const RULE_TARGETS = ['ALL', 'SEGMENT', 'CUSTOMER'] as const
export type RuleTarget = (typeof RULE_TARGETS)[number]
export const LIMIT_TARGETS = ['GENERAL', 'SEGMENT', 'CUSTOMER'] as const
export type LimitTarget = (typeof LIMIT_TARGETS)[number]

export const PRICE_SCALE = 4
export const QTY_SCALE = 6
export const PCT_SCALE = 2
const HUNDRED = 10_000n // 100,00 % na escala 2

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const CURRENCY = /^[A-Z]{3}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Arredondamento a metade para cima (afastando de zero) de n/d, com d > 0. */
export function divRound(n: bigint, d: bigint): bigint {
  const q = n / d
  const r = n % d
  if (r === 0n) return q
  if (n >= 0n) return r * 2n >= d ? q + 1n : q
  return -r * 2n >= d ? q - 1n : q
}

/** Texto decimal (vírgula ou ponto) → inteiro na escala; `null` se inválido ou com casas a mais. */
export function parseScaled(raw: unknown, scale: number): bigint | null {
  if (typeof raw === 'number') raw = String(raw)
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(',', '.')
  if (!/^\d{1,14}(\.\d+)?$/.test(s)) return null
  const [i, f = ''] = s.split('.')
  if (f.length > scale) return null
  return BigInt(i) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale) || '0')
}

export function scaledText(v: bigint, scale: number) {
  const neg = v < 0n
  const a = neg ? -v : v
  const d = 10n ** BigInt(scale)
  const f = (a % d).toString().padStart(scale, '0')
  return `${neg ? '-' : ''}${a / d}${scale ? '.' + f : ''}`
}

/** Valor da base (`numeric` como texto) → inteiro na escala (a base já guarda com essa escala ou menos). */
export const dbScaled = (v: unknown, scale: number) => parseScaled(String(v), scale)!

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const optionalText = (v: unknown) => {
  const t = text(v)
  return t === '' || t === undefined || t === null ? null : t
}

function dates(
  input: Record<string, unknown>,
  creating: boolean,
  v: Record<string, unknown>,
  issues: ErrorDetail[]
) {
  if ('validFrom' in input || creating) {
    if (typeof input.validFrom !== 'string' || !DATE.test(input.validFrom))
      issues.push({ path: 'validFrom', code: 'INVALID', message: 'Data de início obrigatória.' })
    else v.validFrom = input.validFrom
  }
  if ('validTo' in input) {
    const t = optionalText(input.validTo)
    if (t !== null && (typeof t !== 'string' || !DATE.test(t)))
      issues.push({ path: 'validTo', code: 'INVALID', message: 'Data de fim inválida.' })
    else v.validTo = t
  }
}

function common(
  input: Record<string, unknown>,
  creating: boolean,
  v: Record<string, unknown>,
  issues: ErrorDetail[]
) {
  if ('code' in input || creating) {
    const c = text(input.code)
    if (typeof c !== 'string' || !CODE.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: até 30 letras, dígitos ou . _ -.',
      })
    else v.code = c.toUpperCase()
  }
  if ('name' in input || creating) {
    const n = text(input.name)
    if (typeof n !== 'string' || n.length < 2 || n.length > 120)
      issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 120 caracteres.' })
    else v.name = n
  }
  if ('priority' in input) {
    const p = Number(input.priority)
    if (!Number.isInteger(p) || p < 0 || p > 1000)
      issues.push({ path: 'priority', code: 'INVALID', message: 'Prioridade de 0 a 1000.' })
    else v.priority = p
  }
  if ('notes' in input) {
    const n = optionalText(input.notes)
    if (n !== null && (typeof n !== 'string' || n.length > 1000))
      issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 1000 caracteres.' })
    else v.notes = n
  }
  dates(input, creating, v, issues)
}

function target(
  input: Record<string, unknown>,
  creating: boolean,
  allowed: readonly string[],
  v: Record<string, unknown>,
  issues: ErrorDetail[]
) {
  if (!('targetType' in input) && !creating) return
  if (!allowed.includes(input.targetType as string)) {
    issues.push({ path: 'targetType', code: 'INVALID', message: 'Destino inválido.' })
    return
  }
  v.targetType = input.targetType
  v.segmentId = null
  v.customerId = null
  if (input.targetType === 'SEGMENT') {
    if (typeof input.segmentId !== 'string' || !UUID.test(input.segmentId))
      issues.push({ path: 'segmentId', code: 'REQUIRED', message: 'Escolha o segmento.' })
    else v.segmentId = input.segmentId
  }
  if (input.targetType === 'CUSTOMER') {
    if (typeof input.customerId !== 'string' || !UUID.test(input.customerId))
      issues.push({ path: 'customerId', code: 'REQUIRED', message: 'Escolha o cliente.' })
    else v.customerId = input.customerId
  }
}

/** Cabeçalho de uma tabela de preços (só os campos enviados; ao criar, os obrigatórios). */
export function normalizePriceList(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  common(input, creating, v, issues)
  target(input, creating, LIST_TARGETS, v, issues)
  if ('currency' in input || creating) {
    const c = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
    if (!CURRENCY.test(c))
      issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: código ISO de 3 letras.' })
    else v.currency = c
  }
  if ('legalEntityId' in input) {
    const e = optionalText(input.legalEntityId)
    if (e !== null && (typeof e !== 'string' || !UUID.test(e)))
      issues.push({ path: 'legalEntityId', code: 'INVALID', message: 'Entidade inválida.' })
    else v.legalEntityId = e
  }
  return { v, issues }
}

const pct = (raw: unknown, path: string, issues: ErrorDetail[], positive = false) => {
  const p = parseScaled(raw, PCT_SCALE)
  if (p === null || p > HUNDRED || (positive && p === 0n)) {
    issues.push({
      path,
      code: 'INVALID',
      message: positive
        ? 'Percentagem maior que 0 e até 100, 2 casas.'
        : 'Percentagem de 0 a 100, 2 casas.',
    })
    return null
  }
  return p
}

/** Linha de uma tabela: produto (ou variante), escalão mínimo, preço e limite de desconto opcional. */
export function normalizePriceLine(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('productId' in input || creating) {
    if (typeof input.productId !== 'string' || !UUID.test(input.productId))
      issues.push({ path: 'productId', code: 'REQUIRED', message: 'Escolha o produto.' })
    else v.productId = input.productId
  }
  if ('variantId' in input) {
    const x = optionalText(input.variantId)
    if (x !== null && (typeof x !== 'string' || !UUID.test(x)))
      issues.push({ path: 'variantId', code: 'INVALID', message: 'Variante inválida.' })
    else v.variantId = x
  }
  if ('minQuantity' in input) {
    const q = parseScaled(input.minQuantity, QTY_SCALE)
    if (q === null || q === 0n)
      issues.push({
        path: 'minQuantity',
        code: 'INVALID',
        message: 'Quantidade mínima maior que 0, até 6 casas.',
      })
    else v.minQuantity = scaledText(q, QTY_SCALE)
  }
  if ('unitPrice' in input || creating) {
    const p = parseScaled(input.unitPrice, PRICE_SCALE)
    if (p === null)
      issues.push({
        path: 'unitPrice',
        code: 'INVALID',
        message: 'Preço ≥ 0, até 4 casas, em texto.',
      })
    else v.unitPrice = scaledText(p, PRICE_SCALE)
  }
  if ('maxDiscountPct' in input) {
    const raw = optionalText(input.maxDiscountPct)
    if (raw === null) v.maxDiscountPct = null
    else {
      const p = pct(raw, 'maxDiscountPct', issues)
      if (p !== null) v.maxDiscountPct = scaledText(p, PCT_SCALE)
    }
  }
  return { v, issues }
}

/** Regra de desconto automático. */
export function normalizeRule(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  common(input, creating, v, issues)
  target(input, creating, RULE_TARGETS, v, issues)
  for (const k of ['productId', 'categoryId'] as const)
    if (k in input) {
      const x = optionalText(input[k])
      if (x !== null && (typeof x !== 'string' || !UUID.test(x)))
        issues.push({ path: k, code: 'INVALID', message: 'Referência inválida.' })
      else v[k] = x
    }
  if (v.productId && v.categoryId)
    issues.push({
      path: 'categoryId',
      code: 'INVALID',
      message: 'Produto ou categoria, não os dois.',
    })
  if ('minQuantity' in input) {
    const q = parseScaled(optionalText(input.minQuantity) ?? '0', QTY_SCALE)
    if (q === null)
      issues.push({ path: 'minQuantity', code: 'INVALID', message: 'Quantidade ≥ 0, até 6 casas.' })
    else v.minQuantity = scaledText(q, QTY_SCALE)
  }
  if ('discountPct' in input || creating) {
    const p = pct(input.discountPct, 'discountPct', issues, true)
    if (p !== null) v.discountPct = scaledText(p, PCT_SCALE)
  }
  return { v, issues }
}

export function normalizeLimit(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  target(input, true, LIMIT_TARGETS, v, issues)
  const p = pct(input.maxPct, 'maxPct', issues)
  if (p !== null) v.maxPct = scaledText(p, PCT_SCALE)
  return { v, issues }
}

export function normalizeReason(input: Record<string, unknown>, required: boolean) {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const issues: ErrorDetail[] = []
  if ((required || reason) && (reason.length < 3 || reason.length > 500))
    issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' })
  return { reason: reason || null, issues }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolução
// ---------------------------------------------------------------------------------------------------------------

export interface PriceCandidate {
  listId: string
  listCode: string
  targetType: ListTarget
  priority: number
  validFrom: string
  lineId: string
  variantId: string | null
  minQuantity: bigint
  unitPrice: bigint
  maxDiscountPct: bigint | null
}

export interface RuleCandidate {
  ruleId: string
  code: string
  targetType: RuleTarget
  scope: 'PRODUCT' | 'CATEGORY' | 'ALL'
  priority: number
  minQuantity: bigint
  pct: bigint
}

export interface Limits {
  customer: bigint | null
  segment: bigint | null
  general: bigint | null
}

export interface LineInput {
  quantity: bigint
  variantId: string | null
  manualDiscountPct: bigint | null
  manualUnitPrice: bigint | null
  catalogPrice: bigint | null
}

export interface ResolvedLine {
  source: 'LIST' | 'CATALOG' | 'MANUAL' | 'NONE'
  priceListId: string | null
  priceListCode: string | null
  priceListLineId: string | null
  tierMinQuantity: string | null
  basePrice: string | null
  ruleId: string | null
  ruleCode: string | null
  rulePct: string
  manualDiscountPct: string
  limitPct: string
  limitSource: 'CUSTOMER' | 'SEGMENT' | 'GENERAL' | 'LINE' | 'NONE'
  netUnitPrice: string | null
  netAmount: string | null
  requiresApproval: boolean
  reasons: string[]
}

const LIST_RANK: Record<ListTarget, number> = { CUSTOMER: 3, SEGMENT: 2, GENERAL: 1 }
const RULE_RANK: Record<RuleTarget, number> = { CUSTOMER: 3, SEGMENT: 2, ALL: 1 }
const SCOPE_RANK = { PRODUCT: 3, CATEGORY: 2, ALL: 1 } as const
const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0)

/** Escolhe a linha de tabela aplicável (ou `null`). */
export function pickPrice(
  candidates: PriceCandidate[],
  quantity: bigint,
  variantId: string | null
) {
  const eligible = candidates.filter(
    (c) => c.minQuantity <= quantity && (c.variantId === null || c.variantId === variantId)
  )
  if (!eligible.length) return null
  const byList = new Map<string, PriceCandidate[]>()
  for (const c of eligible) byList.set(c.listId, [...(byList.get(c.listId) ?? []), c])
  const lists = [...byList.values()].sort(
    (a, b) =>
      cmp(LIST_RANK[b[0].targetType], LIST_RANK[a[0].targetType]) ||
      cmp(b[0].priority, a[0].priority) ||
      cmp(b[0].validFrom, a[0].validFrom) ||
      cmp(a[0].listCode, b[0].listCode)
  )
  return lists[0].sort(
    (a, b) =>
      cmp(b.variantId ? 1 : 0, a.variantId ? 1 : 0) ||
      (b.minQuantity > a.minQuantity ? 1 : b.minQuantity < a.minQuantity ? -1 : 0)
  )[0]
}

/** Escolhe a regra de desconto aplicável (ou `null`). */
export function pickRule(rules: RuleCandidate[], quantity: bigint) {
  const eligible = rules.filter((r) => r.minQuantity <= quantity)
  if (!eligible.length) return null
  return eligible.sort(
    (a, b) =>
      cmp(b.priority, a.priority) ||
      cmp(RULE_RANK[b.targetType], RULE_RANK[a.targetType]) ||
      cmp(SCOPE_RANK[b.scope], SCOPE_RANK[a.scope]) ||
      cmp(a.code, b.code)
  )[0]
}

export function resolveLine(
  input: LineInput,
  candidates: PriceCandidate[],
  rules: RuleCandidate[],
  limits: Limits
): ResolvedLine {
  const reasons: string[] = []
  const line = pickPrice(candidates, input.quantity, input.variantId)
  let source: ResolvedLine['source']
  let base: bigint | null
  if (line) {
    source = 'LIST'
    base = line.unitPrice
  } else if (input.catalogPrice !== null) {
    source = 'CATALOG'
    base = input.catalogPrice
  } else if (input.manualUnitPrice !== null) {
    source = 'MANUAL'
    base = null
    reasons.push('MANUAL_PRICE')
  } else {
    source = 'NONE'
    base = null
    reasons.push('NO_PRICE')
  }

  const rule = base !== null ? pickRule(rules, input.quantity) : null
  const rulePct = rule?.pct ?? 0n

  // Limite do desconto manual.
  let limit: bigint
  let limitSource: ResolvedLine['limitSource']
  if (limits.customer !== null) [limit, limitSource] = [limits.customer, 'CUSTOMER']
  else if (limits.segment !== null) [limit, limitSource] = [limits.segment, 'SEGMENT']
  else if (limits.general !== null) [limit, limitSource] = [limits.general, 'GENERAL']
  else [limit, limitSource] = [0n, 'NONE']
  if (
    line?.maxDiscountPct !== null &&
    line?.maxDiscountPct !== undefined &&
    line.maxDiscountPct < limit
  )
    [limit, limitSource] = [line.maxDiscountPct, 'LINE']

  let net: bigint | null = null
  let manualPct = 0n
  if (base !== null) {
    // Preço com a regra, com precisão total (escala 4 + 4).
    const afterRule = base * (HUNDRED - rulePct) // escala 8
    if (input.manualUnitPrice !== null) {
      const manual = input.manualUnitPrice * HUNDRED // escala 8
      if (manual >= afterRule) net = input.manualUnitPrice
      else {
        net = input.manualUnitPrice
        // Percentagem implícita, arredondada para cima (nunca subestima o desconto).
        const diff = (afterRule - manual) * HUNDRED
        manualPct = afterRule === 0n ? 0n : (diff + afterRule - 1n) / afterRule
      }
    } else {
      manualPct = input.manualDiscountPct ?? 0n
      net = divRound(afterRule * (HUNDRED - manualPct), HUNDRED * HUNDRED)
    }
    if (manualPct > limit) reasons.push('DISCOUNT_OVER_LIMIT')
  } else if (source === 'MANUAL') net = input.manualUnitPrice

  return {
    source,
    priceListId: line?.listId ?? null,
    priceListCode: line?.listCode ?? null,
    priceListLineId: line?.lineId ?? null,
    tierMinQuantity: line ? scaledText(line.minQuantity, QTY_SCALE) : null,
    basePrice: base === null ? null : scaledText(base, PRICE_SCALE),
    ruleId: rule?.ruleId ?? null,
    ruleCode: rule?.code ?? null,
    rulePct: scaledText(rulePct, PCT_SCALE),
    manualDiscountPct: scaledText(manualPct, PCT_SCALE),
    limitPct: scaledText(limit, PCT_SCALE),
    limitSource,
    netUnitPrice: net === null ? null : scaledText(net, PRICE_SCALE),
    netAmount:
      net === null
        ? null
        : scaledText(divRound(net * input.quantity, 10n ** BigInt(PRICE_SCALE + QTY_SCALE - 2)), 2),
    requiresApproval: reasons.includes('DISCOUNT_OVER_LIMIT') || reasons.includes('MANUAL_PRICE'),
    reasons,
  }
}

/** Impressão digital do snapshot (tudo menos o instante da resolução). */
export function snapshotHash(data: unknown) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}
