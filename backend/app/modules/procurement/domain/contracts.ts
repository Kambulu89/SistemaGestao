import type { ErrorDetail } from '#shared/http/api_error'
import { divRound, isDate, parseScaled } from '#modules/procurement/domain/requisitions'

/*
 * Contratos de fornecedor (9.6) — regras puras.
 *
 *  Estados guardados: rascunho → em aprovação → activo (recusado volta a editar-se); activo ↔ suspenso; terminado e
 *  anulado (só rascunho/recusado/em aprovação) finais. Estado efectivo pelas datas: activo antes do início é "por
 *  iniciar", depois do fim é "caducado". Só um contrato efectivamente activo aceita consumo novo.
 *
 *  Consumo: o valor líquido em vigor das ordens (por linha, líquido × (quantidade − cancelada) / quantidade, ao
 *  cêntimo), comprometido na emissão e devolvido na anulação ou no fecho do resto; nunca passa o máximo.
 *
 *  Renovação: proposta como adenda (nova data de fim = fim + meses de renovação, ou a indicada); a renovação automática
 *  e o aviso servem para o alerta "a renovar" (sem agendador, calculado na leitura).
 */

export const CONTRACT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'SUSPENDED',
  'TERMINATED',
  'CANCELLED',
] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]
export type EffectiveStatus = ContractStatus | 'NOT_STARTED' | 'EXPIRED'
export const SLA_METRICS = [
  'DELIVERY_DAYS',
  'FILL_RATE',
  'QUALITY_RATE',
  'RESPONSE_HOURS',
  'OTHER',
] as const
export const CONTRACT_SERIES_TYPE = 'PURCHASE_CONTRACT'
export const CONTRACT_EDITABLE: readonly ContractStatus[] = ['DRAFT', 'REJECTED']

export function effectiveStatus(
  c: { status: ContractStatus; startDate: string; endDate: string },
  today: string
): EffectiveStatus {
  if (c.status !== 'ACTIVE') return c.status
  if (today < c.startDate) return 'NOT_STARTED'
  if (today > c.endDate) return 'EXPIRED'
  return 'ACTIVE'
}

/** A renovar: activo (ou por iniciar), com o fim dentro do prazo de aviso. */
export function renewalDue(
  c: { status: ContractStatus; endDate: string; renewalNoticeDays: number },
  today: string
) {
  if (c.status !== 'ACTIVE' || c.endDate < today) return false
  return c.endDate <= addDays(today, c.renewalNoticeDays)
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Soma meses a uma data, ficando no último dia do mês quando o dia não existe (31/01 + 1 → 28 ou 29/02). */
export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = total % 12
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  const day = Math.min(d, last)
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Valor líquido em vigor de uma ordem (o que consome do contrato). */
export function committedValue(
  lines: { quantity: bigint; cancelled: bigint; net: bigint }[]
): bigint {
  return lines.reduce(
    (s, l) =>
      s + (l.quantity === 0n ? 0n : divRound(l.net * (l.quantity - l.cancelled), l.quantity)),
    0n
  )
}

export interface ContractHeaderValues {
  title: string
  object: string
  startDate: string
  endDate: string
  maxAmount: bigint
  paymentTermsDays: number | null
  autoRenew: boolean
  renewalNoticeDays: number
  renewalMonths: number | null
  notes: string | null
}

/** Cabeçalho comercial (o mesmo para criar, editar e propor adendas). */
export function normalizeContractHeader(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const text = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const title = text('title')
  if (title.length < 3 || title.length > 200)
    issues.push({ path: 'title', code: 'LENGTH', message: 'Título: 3 a 200 caracteres.' })
  const object = text('object')
  if (object.length < 3 || object.length > 10_000)
    issues.push({ path: 'object', code: 'REQUIRED', message: 'Descreva o objecto do contrato.' })
  const startDate = input.startDate
  const endDate = input.endDate
  if (!isDate(startDate))
    issues.push({ path: 'startDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  if (!isDate(endDate))
    issues.push({ path: 'endDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  else if (isDate(startDate) && endDate < startDate)
    issues.push({
      path: 'endDate',
      code: 'BEFORE_START',
      message: 'O fim não pode ser antes do início.',
    })
  const max = parseScaled(input.maxAmount, 2)
  if (max === null || max <= 0n)
    issues.push({
      path: 'maxAmount',
      code: 'INVALID',
      message: 'Valor máximo maior que zero, até 2 casas, em texto.',
    })
  const int = (k: string, min: number, top: number, def: number | null) => {
    const v = input[k]
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > top) {
      issues.push({ path: k, code: 'INVALID', message: `De ${min} a ${top}.` })
      return def
    }
    return n
  }
  const notes = text('notes') || null
  if (notes && notes.length > 4000)
    issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 4000 caracteres.' })
  const values: ContractHeaderValues = {
    title,
    object,
    startDate: startDate as string,
    endDate: endDate as string,
    maxAmount: max ?? 0n,
    paymentTermsDays: int('paymentTermsDays', 0, 365, null),
    autoRenew: input.autoRenew === true,
    renewalNoticeDays: int('renewalNoticeDays', 0, 365, 30) ?? 30,
    renewalMonths: int('renewalMonths', 1, 120, null),
    notes,
  }
  if (values.autoRenew && values.renewalMonths === null)
    issues.push({
      path: 'renewalMonths',
      code: 'REQUIRED',
      message: 'Indique o período de renovação.',
    })
  return { values, issues }
}

export interface PriceInput {
  productId: string | null
  variantId: string | null
  description: string
  uomId: string | null
  unitPrice: bigint
  notes: string | null
}
export interface SlaInput {
  metric: (typeof SLA_METRICS)[number]
  target: bigint
  description: string | null
  penalty: string | null
}

const uuid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)

/** Forma da tabela de preços (produtos e unidades confirmados no serviço); o mesmo produto/variante só uma vez. */
export function normalizePrices(raw: unknown) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (list.length > 500)
    issues.push({ path: 'prices', code: 'TOO_MANY', message: 'Até 500 preços.' })
  const seen = new Set<string>()
  const prices: PriceInput[] = list.map((p: any, i: number) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `prices.${i}.${f}`, code, message })
    const price = parseScaled(p?.unitPrice ?? '', 6)
    if (price === null) at('unitPrice', 'INVALID', 'Preço ≥ 0, até 6 casas, em texto.')
    const productId = uuid(p?.productId)
    const variantId = uuid(p?.variantId)
    if (productId) {
      const k = `${productId}|${variantId ?? ''}`
      if (seen.has(k)) at('productId', 'DUPLICATE', 'O mesmo produto só uma vez.')
      seen.add(k)
    }
    const description = typeof p?.description === 'string' ? p.description.trim() : ''
    if (description.length > 300) at('description', 'LENGTH', 'Até 300 caracteres.')
    const notes =
      typeof p?.notes === 'string' && p.notes.trim() ? p.notes.trim().slice(0, 500) : null
    return {
      productId,
      variantId,
      description,
      uomId: uuid(p?.uomId),
      unitPrice: price ?? 0n,
      notes,
    }
  })
  return { prices, issues }
}

export function normalizeSlas(raw: unknown) {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (list.length > 50)
    issues.push({ path: 'slas', code: 'TOO_MANY', message: 'Até 50 níveis de serviço.' })
  const slas: SlaInput[] = list.map((s: any, i: number) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `slas.${i}.${f}`, code, message })
    if (!SLA_METRICS.includes(s?.metric)) at('metric', 'INVALID', 'Métrica inválida.')
    const target = parseScaled(s?.target ?? '', 3)
    if (target === null) at('target', 'INVALID', 'Objectivo ≥ 0, até 3 casas, em texto.')
    if (
      (s?.metric === 'FILL_RATE' || s?.metric === 'QUALITY_RATE') &&
      target !== null &&
      target > 100_000n
    )
      at('target', 'INVALID', 'Percentagem até 100.')
    const description =
      typeof s?.description === 'string' && s.description.trim() ? s.description.trim() : null
    if (s?.metric === 'OTHER' && !description)
      at('description', 'REQUIRED', 'Descreva o nível de serviço.')
    if (description && description.length > 300) at('description', 'LENGTH', 'Até 300 caracteres.')
    const penalty = typeof s?.penalty === 'string' && s.penalty.trim() ? s.penalty.trim() : null
    if (penalty && penalty.length > 500) at('penalty', 'LENGTH', 'Até 500 caracteres.')
    return { metric: s?.metric, target: target ?? 0n, description, penalty }
  })
  return { slas, issues }
}

/** Uma ordem pode usar este contrato? Mesma entidade, fornecedor e moeda; activo efectivo na data da ordem. */
export function contractFitIssues(
  c: {
    status: ContractStatus
    legalEntityId: string
    supplierId: string
    currency: string
    startDate: string
    endDate: string
  },
  o: { legalEntityId: string; supplierId: string; currency: string; orderDate: string }
) {
  const issues: ErrorDetail[] = []
  const err = (code: string, message: string) => issues.push({ path: 'contractId', code, message })
  if (c.status !== 'ACTIVE') err('CONTRACT_NOT_ACTIVE', 'O contrato não está activo.')
  else if (o.orderDate < c.startDate || o.orderDate > c.endDate)
    err('CONTRACT_OUT_OF_TERM', 'A data da ordem está fora da vigência do contrato.')
  if (c.legalEntityId !== o.legalEntityId)
    err('CONTRACT_OTHER_ENTITY', 'O contrato é de outra entidade.')
  if (c.supplierId !== o.supplierId)
    err('CONTRACT_OTHER_SUPPLIER', 'O contrato é de outro fornecedor.')
  if (c.currency !== o.currency)
    err('CONTRACT_OTHER_CURRENCY', 'A ordem tem de estar na moeda do contrato.')
  return issues
}
