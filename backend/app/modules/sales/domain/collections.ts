import type { ErrorDetail } from '#shared/http/api_error'
import { parseScaled } from '#modules/sales/domain/pricing'

/*
 * Cobranças (10.10) — regras puras.
 *
 *  - Em dívida por factura = a pagar + débitos − créditos − recebido (10.8). Antiguidade pelo vencimento: por vencer,
 *    1–30, 31–60, 61–90 e mais de 90 dias.
 *  - Crédito do cliente que ainda não abateu facturas: adiantamentos dos recibos (10.7) e crédito das notas (10.8).
 *    A exposição para o limite de crédito é o em dívida menos esse crédito, mais as encomendas por facturar.
 *  - Promessa de pagamento ≠ pagamento: não toca em saldos. Estado calculado: anulada; cumprida quando os recebimentos
 *    confirmados depois da promessa (nas facturas indicadas, ou do cliente na entidade se não indicar) chegam ao valor;
 *    falhada quando passou a data sem isso; senão, em aberto.
 */

export const AGING_BUCKETS = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]
export const ACTIVITY_KINDS = ['CALL', 'EMAIL', 'VISIT', 'LETTER', 'NOTE'] as const
export const ACTIVITY_OUTCOMES = [
  'REACHED',
  'NO_ANSWER',
  'PROMISED',
  'DISPUTED',
  'PAID_CLAIMED',
  'OTHER',
] as const
export type PromiseStatus = 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = 86_400_000

/** Dias de atraso (0 se ainda não venceu). */
export function daysOverdue(dueDate: string, today: string) {
  const d = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / DAY
  return d > 0 ? Math.round(d) : 0
}

export function agingBucket(dueDate: string, today: string): AgingBucket {
  const d = daysOverdue(dueDate, today)
  if (d === 0) return 'CURRENT'
  if (d <= 30) return 'D1_30'
  if (d <= 60) return 'D31_60'
  if (d <= 90) return 'D61_90'
  return 'D90_PLUS'
}

/** Soma por antiguidade (valores em cêntimos). */
export function aging(items: { dueDate: string; open: bigint }[], today: string) {
  const out = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0n])) as Record<AgingBucket, bigint>
  for (const i of items) out[agingBucket(i.dueDate, today)] += i.open
  return out
}

export function promiseStatus(p: {
  cancelled: boolean
  amount: bigint
  paidSince: bigint
  promisedDate: string
  today: string
}): PromiseStatus {
  if (p.cancelled) return 'CANCELLED'
  if (p.paidSince >= p.amount) return 'KEPT'
  if (p.today > p.promisedDate) return 'BROKEN'
  return 'OPEN'
}

export function normalizePromise(input: Record<string, unknown>, today: string) {
  const issues: ErrorDetail[] = []
  const amount = parseScaled(input.amount, 2)
  if (amount === null || amount <= 0n)
    issues.push({ path: 'amount', code: 'INVALID', message: 'Valor maior que 0, 2 casas.' })
  const date = input.promisedDate
  if (typeof date !== 'string' || !DATE.test(date))
    issues.push({ path: 'promisedDate', code: 'INVALID', message: 'Data prometida obrigatória.' })
  else if (date < today)
    issues.push({
      path: 'promisedDate',
      code: 'PAST',
      message: 'A data prometida não pode ser passada.',
    })
  if (typeof input.legalEntityId !== 'string' || !UUID.test(input.legalEntityId))
    issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade.' })
  const invoiceIds: string[] = []
  if (input.invoiceIds !== undefined && input.invoiceIds !== null) {
    if (!Array.isArray(input.invoiceIds) || input.invoiceIds.length > 50)
      issues.push({ path: 'invoiceIds', code: 'INVALID', message: 'Até 50 facturas.' })
    else
      for (const id of input.invoiceIds)
        if (typeof id !== 'string' || !UUID.test(id))
          issues.push({ path: 'invoiceIds', code: 'INVALID', message: 'Factura inválida.' })
        else if (!invoiceIds.includes(id)) invoiceIds.push(id)
  }
  const text = (k: string, max: number) => {
    const v = typeof input[k] === 'string' ? (input[k] as string).trim() : ''
    if (v.length > max) issues.push({ path: k, code: 'LENGTH', message: `Até ${max} caracteres.` })
    return v || null
  }
  return {
    v: {
      amount: amount ?? 0n,
      promisedDate: date as string,
      legalEntityId: input.legalEntityId as string,
      invoiceIds,
      contactName: text('contactName', 120),
      notes: text('notes', 500),
    },
    issues,
  }
}

export function normalizeActivity(input: Record<string, unknown>, today: string) {
  const issues: ErrorDetail[] = []
  if (!(ACTIVITY_KINDS as readonly unknown[]).includes(input.kind))
    issues.push({ path: 'kind', code: 'INVALID', message: 'Tipo de contacto.' })
  if (!(ACTIVITY_OUTCOMES as readonly unknown[]).includes(input.outcome))
    issues.push({ path: 'outcome', code: 'INVALID', message: 'Resultado do contacto.' })
  if (typeof input.legalEntityId !== 'string' || !UUID.test(input.legalEntityId))
    issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade.' })
  const notes = typeof input.notes === 'string' ? input.notes.trim() : ''
  if (notes.length < 3 || notes.length > 1000)
    issues.push({ path: 'notes', code: 'REQUIRED', message: 'Descreva o contacto (3 a 1000).' })
  const contact = typeof input.contactName === 'string' ? input.contactName.trim() : ''
  if (contact.length > 120)
    issues.push({ path: 'contactName', code: 'LENGTH', message: 'Até 120 caracteres.' })
  const next =
    input.nextActionDate === '' ||
    input.nextActionDate === null ||
    input.nextActionDate === undefined
      ? null
      : input.nextActionDate
  if (next !== null && (typeof next !== 'string' || !DATE.test(next) || next < today))
    issues.push({ path: 'nextActionDate', code: 'INVALID', message: 'Data futura (ou vazia).' })
  const promise =
    input.promiseId === '' || input.promiseId === null || input.promiseId === undefined
      ? null
      : input.promiseId
  if (promise !== null && (typeof promise !== 'string' || !UUID.test(promise)))
    issues.push({ path: 'promiseId', code: 'INVALID', message: 'Promessa inválida.' })
  return {
    v: {
      kind: input.kind as string,
      outcome: input.outcome as string,
      legalEntityId: input.legalEntityId as string,
      notes,
      contactName: contact || null,
      nextActionDate: next as string | null,
      promiseId: promise as string | null,
    },
    issues,
  }
}
