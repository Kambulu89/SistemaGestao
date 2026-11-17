import type { ErrorDetail } from '#shared/http/api_error'

/*
 * Fornecedor (9.1): o papel de fornecedor de um terceiro, com condições comerciais e homologação.
 *
 *  Estados: rascunho → em aprovação → homologado | recusado; homologado → suspenso. Recusado e suspenso voltam a
 *  "em aprovação" por um novo pedido de homologação. Quem submete não decide.
 *
 *  Homologação: cada critério obrigatório tem de estar "cumprido" e cada tipo de documento obrigatório tem de ter um
 *  documento activo e válido (sem validade ou válido até hoje, inclusive). A validade da homologação deriva dos
 *  documentos obrigatórios: quando um caduca, o fornecedor continua homologado no histórico mas `qualification.valid`
 *  passa a falso (as encomendas do 9.5 verificam-no). Nada é recalculado para trás.
 */

export const SUPPLIER_TYPES = ['GOODS', 'SERVICES', 'BOTH'] as const
export const PAYMENT_METHODS = ['TRANSFER', 'CHEQUE', 'CASH', 'OTHER'] as const
export const SUPPLIER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
] as const
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number]
export const CRITERION_RESULTS = ['MET', 'NOT_MET', 'NOT_APPLICABLE'] as const
export type CriterionResult = (typeof CRITERION_RESULTS)[number]

/** De onde se pode pedir homologação. */
export const CAN_SUBMIT: readonly SupplierStatus[] = ['DRAFT', 'REJECTED', 'SUSPENDED']

export const SUPPLIER_COLUMNS: Record<string, string> = {
  partnerId: 'partner_id',
  supplierType: 'supplier_type',
  currency: 'currency',
  paymentTermsDays: 'payment_terms_days',
  paymentMethod: 'payment_method',
  leadTimeDays: 'lead_time_days',
  minOrderAmount: 'min_order_amount',
  incoterm: 'incoterm',
  notes: 'notes',
  status: 'status',
  approvedAt: 'approved_at',
}

const CURRENCY = /^[A-Z]{3}$/
const INCOTERM = /^[A-Z]{3}$/
const MONEY = /^\d{1,17}(\.\d{1,2})?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const int = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v)
    ? v
    : typeof v === 'string' && /^\d+$/.test(v.trim())
      ? Number(v.trim())
      : null

/** Condições comerciais e tipo (ao criar, tipo e moeda são obrigatórios). */
export function normalizeSupplier(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('supplierType' in input || creating) {
    if (!SUPPLIER_TYPES.includes(input.supplierType as never))
      issues.push({
        path: 'supplierType',
        code: 'INVALID',
        message: 'Bens, serviços ou ambos.',
      })
    else v.supplierType = input.supplierType
  }
  if ('currency' in input || creating) {
    const c = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
    if (!CURRENCY.test(c))
      issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: código ISO de 3 letras.' })
    else v.currency = c
  }
  if ('paymentTermsDays' in input) {
    const d = int(input.paymentTermsDays)
    if (d === null || d < 0 || d > 365)
      issues.push({ path: 'paymentTermsDays', code: 'INVALID', message: 'Prazo: 0 a 365 dias.' })
    else v.paymentTermsDays = d
  }
  if ('paymentMethod' in input) {
    if (!PAYMENT_METHODS.includes(input.paymentMethod as never))
      issues.push({
        path: 'paymentMethod',
        code: 'INVALID',
        message: 'Meio de pagamento inválido.',
      })
    else v.paymentMethod = input.paymentMethod
  }
  if ('leadTimeDays' in input) {
    if (input.leadTimeDays === null || input.leadTimeDays === '') v.leadTimeDays = null
    else {
      const d = int(input.leadTimeDays)
      if (d === null || d < 0 || d > 730)
        issues.push({
          path: 'leadTimeDays',
          code: 'INVALID',
          message: 'Prazo de entrega: 0 a 730 dias.',
        })
      else v.leadTimeDays = d
    }
  }
  if ('minOrderAmount' in input) {
    const m = input.minOrderAmount
    if (m === null || m === '') v.minOrderAmount = null
    else if (typeof m !== 'string' || !MONEY.test(m.trim()))
      issues.push({
        path: 'minOrderAmount',
        code: 'INVALID',
        message: 'Valor mínimo: número com até 2 casas, em texto.',
      })
    else v.minOrderAmount = m.trim()
  }
  if ('incoterm' in input) {
    const i = typeof input.incoterm === 'string' ? input.incoterm.trim().toUpperCase() : ''
    if (input.incoterm === null || i === '') v.incoterm = null
    else if (!INCOTERM.test(i))
      issues.push({ path: 'incoterm', code: 'INVALID', message: 'Incoterm: 3 letras (ex.: FOB).' })
    else v.incoterm = i
  }
  if ('notes' in input) {
    const n = typeof input.notes === 'string' ? input.notes.trim() : null
    if (n !== null && n.length > 2000)
      issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 2000 caracteres.' })
    else v.notes = n || null
  }
  return { v, issues }
}

export interface DocumentFact {
  documentTypeId: string
  validUntil: string | null
  status: 'ACTIVE' | 'INACTIVE'
}
export interface RequiredType {
  id: string
  code: string
  name: string
}

/** Documento activo e válido hoje (sem validade conta como válido; caduca no dia seguinte ao `validUntil`). */
export const documentValid = (d: DocumentFact, today: string) =>
  d.status === 'ACTIVE' && (d.validUntil === null || d.validUntil >= today)

/**
 * Estado dos documentos obrigatórios: os que faltam (nunca entregues ou todos inactivos), os caducados (há documento
 * activo mas fora de validade) e a data em que a homologação deixa de valer (a validade mais próxima dos obrigatórios).
 */
export function qualification(
  required: RequiredType[],
  documents: DocumentFact[],
  today: string,
  warningDays: number
) {
  const missing: string[] = []
  const expired: string[] = []
  const expiring: string[] = []
  let expiresOn: string | null = null
  const limit = addDays(today, warningDays)
  for (const t of required) {
    const mine = documents.filter((d) => d.documentTypeId === t.id && d.status === 'ACTIVE')
    if (!mine.length) {
      missing.push(t.code)
      continue
    }
    const valid = mine.filter((d) => documentValid(d, today))
    if (!valid.length) {
      expired.push(t.code)
      continue
    }
    // A melhor cobertura deste tipo: sem validade, ou a validade mais distante.
    const best = valid.some((d) => d.validUntil === null)
      ? null
      : valid
          .map((d) => d.validUntil!)
          .sort()
          .at(-1)!
    if (best !== null) {
      if (expiresOn === null || best < expiresOn) expiresOn = best
      if (best <= limit) expiring.push(t.code)
    }
  }
  return { valid: !missing.length && !expired.length, missing, expired, expiring, expiresOn }
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface CriterionFact {
  id: string
  code: string
  required: boolean
}

/** Valida as avaliações de um pedido de homologação: todos os critérios activos avaliados; obrigatórios cumpridos. */
export function reviewIssues(
  criteria: CriterionFact[],
  items: { criterionId: string; result: string; notes: string | null }[]
) {
  const issues: ErrorDetail[] = []
  const byId = new Map(items.map((i) => [i.criterionId, i]))
  if (byId.size !== items.length)
    issues.push({ path: 'items', code: 'DUPLICATE', message: 'Cada critério só uma vez.' })
  for (const i of items)
    if (!criteria.some((c) => c.id === i.criterionId))
      issues.push({
        path: 'items',
        code: 'NOT_FOUND',
        message: 'Critério desconhecido ou inactivo.',
      })
    else if (!CRITERION_RESULTS.includes(i.result as CriterionResult))
      issues.push({
        path: 'items',
        code: 'INVALID',
        message: 'Cumprido, não cumprido ou não aplicável.',
      })
  for (const c of criteria) {
    const i = byId.get(c.id)
    if (!i)
      issues.push({
        path: 'items',
        code: 'MISSING',
        message: `Falta avaliar o critério ${c.code}.`,
      })
    else if (c.required && i.result !== 'MET')
      issues.push({
        path: 'items',
        code: 'REQUIRED_NOT_MET',
        message: `O critério obrigatório ${c.code} tem de estar cumprido.`,
      })
    else if (i.result === 'NOT_MET' && !i.notes)
      issues.push({
        path: 'items',
        code: 'REQUIRED',
        message: `Justifique o critério não cumprido ${c.code}.`,
      })
  }
  return issues
}

export function isDate(v: unknown): v is string {
  return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
}
