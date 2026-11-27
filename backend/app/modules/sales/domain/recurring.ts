import type { ErrorDetail } from '#shared/http/api_error'
import { parseScaled, PRICE_SCALE, QTY_SCALE, scaledText } from '#modules/sales/domain/pricing'

/*
 * Facturação recorrente (10.11) — regras puras.
 *
 *  - Períodos calculados a partir do início do contrato (índice k): início_k = início + k×meses, com o dia preso ao
 *    último dia do mês quando não existe (31 → 28/29/30) — sem deriva de mês para mês. Fim = início_{k+1} − 1 dia.
 *  - Data da factura: início do período (adiantado) ou fim (vencido). Só se gera quando essa data já chegou.
 *  - Versão aplicável: a última APROVADA com início de vigência ≤ início do período.
 *  - A geração cria rascunhos; a emissão é sempre de uma pessoa com `sales.invoices.issue`.
 */

export const FREQUENCIES = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 } as const
export type Frequency = keyof typeof FREQUENCIES
export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'ENDED'] as const
export const MAX_PERIODS_PER_RUN = 24

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Soma meses a uma data mantendo o dia do início (preso ao fim do mês). */
export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}
const minusDay = (date: string) => {
  const x = new Date(`${date}T00:00:00Z`)
  x.setUTCDate(x.getUTCDate() - 1)
  return x.toISOString().slice(0, 10)
}

export function period(
  start: string,
  frequency: Frequency,
  k: number,
  timing: 'ADVANCE' | 'ARREARS'
) {
  const n = FREQUENCIES[frequency]
  const periodStart = addMonths(start, k * n)
  const periodEnd = minusDay(addMonths(start, (k + 1) * n))
  return {
    index: k,
    periodStart,
    periodEnd,
    invoiceDate: timing === 'ADVANCE' ? periodStart : periodEnd,
  }
}

/** O período k ainda pertence ao contrato (começa antes do fim). */
export const withinContract = (p: { periodStart: string }, endDate: string | null) =>
  endDate === null || p.periodStart <= endDate

export function effectiveVersion<T extends { validFrom: string; status: string }>(
  versions: T[],
  date: string
): T | null {
  return (
    versions
      .filter((v) => v.status === 'APPROVED' && v.validFrom <= date)
      .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0] ?? null
  )
}

export function normalizeContract(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  const req = (k: string) => creating || k in input
  if (req('reference')) {
    const r = typeof input.reference === 'string' ? input.reference.trim() : ''
    if (!/^[\p{L}\p{N}._/-]{2,40}$/u.test(r))
      issues.push({
        path: 'reference',
        code: 'INVALID',
        message: 'Referência (2 a 40, sem espaços).',
      })
    else v.reference = r
  }
  if (req('description')) {
    const d = typeof input.description === 'string' ? input.description.trim() : ''
    if (d.length < 3 || d.length > 300)
      issues.push({ path: 'description', code: 'REQUIRED', message: 'Descrição (3 a 300).' })
    else v.description = d
  }
  for (const k of ['legalEntityId', 'customerId'])
    if (creating) {
      if (typeof input[k] !== 'string' || !UUID.test(input[k] as string))
        issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      else v[k] = input[k]
    }
  if (req('frequency')) {
    if (!Object.keys(FREQUENCIES).includes(input.frequency as string))
      issues.push({ path: 'frequency', code: 'INVALID', message: 'Periodicidade.' })
    else v.frequency = input.frequency
  }
  if (req('billingTiming')) {
    const t = input.billingTiming ?? 'ADVANCE'
    if (t !== 'ADVANCE' && t !== 'ARREARS')
      issues.push({
        path: 'billingTiming',
        code: 'INVALID',
        message: 'No início ou no fim do período.',
      })
    else v.billingTiming = t
  }
  if (req('startDate')) {
    if (typeof input.startDate !== 'string' || !DATE.test(input.startDate))
      issues.push({ path: 'startDate', code: 'INVALID', message: 'Data de início.' })
    else v.startDate = input.startDate
  }
  if ('endDate' in input) {
    const e = input.endDate === '' || input.endDate === undefined ? null : input.endDate
    if (e !== null && (typeof e !== 'string' || !DATE.test(e)))
      issues.push({ path: 'endDate', code: 'INVALID', message: 'Data de fim.' })
    else v.endDate = e
  }
  if (v.endDate && v.startDate && (v.endDate as string) < (v.startDate as string))
    issues.push({ path: 'endDate', code: 'BEFORE_START', message: 'O fim é anterior ao início.' })
  if ('paymentTermsDays' in input) {
    const n = Number(input.paymentTermsDays)
    if (!Number.isInteger(n) || n < 0 || n > 365)
      issues.push({ path: 'paymentTermsDays', code: 'INVALID', message: 'Prazo de 0 a 365 dias.' })
    else v.paymentTermsDays = n
  }
  if ('currency' in input) {
    const c = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
    if (!/^[A-Z]{3}$/.test(c))
      issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: código ISO de 3 letras.' })
    else v.currency = c
  }
  return { v, issues }
}

export interface VersionLineInput {
  productId: string
  description: string | null
  quantity: bigint
  unitPrice: bigint | null
  taxCodeIds: string[]
  exemptionCode: string | null
}

export function normalizeVersion(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const validFrom = input.validFrom
  if (typeof validFrom !== 'string' || !DATE.test(validFrom))
    issues.push({ path: 'validFrom', code: 'INVALID', message: 'Início de vigência.' })
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null
  if (notes && notes.length > 500)
    issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 500.' })
  const lines: VersionLineInput[] = []
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 50)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'De 1 a 50 linhas.' })
  else
    input.lines.forEach((l: any, i: number) => {
      const at = (k: string, code: string, message: string) =>
        issues.push({ path: `lines.${i}.${k}`, code, message })
      if (typeof l?.productId !== 'string' || !UUID.test(l.productId))
        return at('productId', 'REQUIRED', 'Escolha o serviço.')
      if (lines.some((x) => x.productId === l.productId))
        return at('productId', 'DUPLICATE', 'Cada serviço uma só vez por versão.')
      const q = parseScaled(l?.quantity, QTY_SCALE)
      if (q === null || q === 0n) at('quantity', 'INVALID', 'Quantidade maior que 0, até 6 casas.')
      const raw = l?.unitPrice === '' || l?.unitPrice === undefined ? null : l.unitPrice
      const p = raw === null ? null : parseScaled(raw, PRICE_SCALE)
      if (raw !== null && p === null)
        at('unitPrice', 'INVALID', 'Preço com até 4 casas (ou vazio para usar a tabela de preços).')
      const codes = Array.isArray(l?.taxCodeIds)
        ? l.taxCodeIds.filter((x: unknown) => typeof x === 'string')
        : []
      if (!codes.length || codes.some((x: string) => !UUID.test(x)))
        at('taxCodeIds', 'REQUIRED', 'Indique os impostos da linha.')
      const description =
        typeof l?.description === 'string' && l.description.trim()
          ? l.description.trim().slice(0, 300)
          : null
      const ex =
        typeof l?.exemptionCode === 'string' && l.exemptionCode.trim()
          ? l.exemptionCode.trim()
          : null
      lines.push({
        productId: l.productId,
        description,
        quantity: q ?? 0n,
        unitPrice: p,
        taxCodeIds: codes,
        exemptionCode: ex,
      })
    })
  return { validFrom: validFrom as string, notes, lines, issues }
}

export const qtyText = (v: bigint) => scaledText(v, QTY_SCALE)
export const priceText = (v: bigint) => scaledText(v, PRICE_SCALE)
