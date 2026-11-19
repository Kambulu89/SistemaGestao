import type { ErrorDetail } from '#shared/http/api_error'

/*
 * Requisições de compra (9.2) — regras puras, em inteiros (quantidades e preços com 6 casas, valores em cêntimos,
 * taxa de imposto com 3 casas, arredondamento meio-para-cima por linha).
 *
 *  Estados: rascunho → em aprovação → aprovada → parcialmente encomendada → encomendada; recusada e anulada são
 *  finais; uma aprovada com resto pode ser fechada (o resto deixa de estar em aberto).
 *
 *  Aprovação por valor: o total em moeda funcional escolhe as etapas activas (da entidade ou gerais) cujo mínimo atinge;
 *  sem nenhuma, há uma etapa base. As etapas decidem-se por ordem; o solicitante não decide nenhuma e a mesma pessoa
 *  não decide duas.
 */

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type Priority = (typeof PRIORITIES)[number]
export const REQUISITION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_ORDERED',
  'ORDERED',
  'REJECTED',
  'CANCELLED',
  'CLOSED',
] as const
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number]

export const CAN: Record<string, readonly RequisitionStatus[]> = {
  edit: ['DRAFT'],
  submit: ['DRAFT'],
  decide: ['PENDING_APPROVAL'],
  cancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'],
  close: ['APPROVED', 'PARTIALLY_ORDERED'],
  allocate: ['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'CLOSED'],
}
export const OPEN: readonly RequisitionStatus[] = ['APPROVED', 'PARTIALLY_ORDERED']

export const SERIES_TYPE = 'PURCHASE_REQUISITION'
export const BASE_LEVEL = {
  id: null,
  code: 'BASE',
  name: 'Aprovação',
  sequence: 0,
  approverRoleId: null,
}

const Q = 1_000_000n

export function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n
  const a = n < 0n ? -n : n
  const b = d < 0n ? -d : d
  const r = (a + b / 2n) / b
  return neg ? -r : r
}

/** Decimal em texto com até `scale` casas → inteiro; `null` se inválido, negativo ou com casas a mais. */
export function parseScaled(raw: unknown, scale: number): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string') return null
  const t = v.trim().replace(',', '.')
  if (!/^\d{1,14}(\.\d+)?$/.test(t)) return null
  const [i, f = ''] = t.split('.')
  if (f.length > scale) return null
  return BigInt(i) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale) || '0')
}

export const scaledText = (v: bigint, scale: number) => {
  const neg = v < 0n
  const a = neg ? -v : v
  const d = 10n ** BigInt(scale)
  return `${neg ? '-' : ''}${a / d}.${(a % d).toString().padStart(scale, '0')}`
}
export const money = (cents: bigint) => scaledText(cents, 2)

/** Valores de uma linha: líquido = q × preço (ao cêntimo), imposto = líquido × taxa (ao cêntimo), total. */
export function lineAmounts(quantity: bigint, unitPrice: bigint, taxRate: bigint) {
  const net = divRound(quantity * unitPrice * 100n, Q * Q)
  const tax = divRound(net * taxRate, 100_000n)
  return { net, tax, total: net + tax }
}

/** Total em moeda funcional: o total da requisição × câmbio (10 casas), ao cêntimo. */
export const toFunctional = (cents: bigint, rate: bigint) => divRound(cents * rate, 10n ** 10n)

export interface Level {
  id: string | null
  code: string
  name: string
  sequence: number
  minAmount?: string
  legalEntityId?: string | null
  approverRoleId: string | null
}

/** Etapas exigidas: as activas desta entidade (ou gerais) cujo mínimo ≤ total, por ordem; sem nenhuma, a base. */
export function requiredLevels(levels: (Level & { minCents: bigint })[], functionalCents: bigint) {
  const hit = levels
    .filter((l) => l.minCents <= functionalCents)
    .sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code))
    .map(({ minCents: _m, ...l }) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      sequence: l.sequence,
      approverRoleId: l.approverRoleId,
    }))
  return hit.length ? hit : [BASE_LEVEL]
}

/**
 * A etapa a decidir a seguir e se este membro a pode decidir: não é o solicitante, não decidiu uma etapa anterior e,
 * se a etapa exige um perfil, tem-no.
 */
export function nextStep(
  required: Level[],
  decided: { sequence: number; membershipId: string }[],
  me: { membershipId: string; isRequester: boolean; roleIds: Set<string> }
) {
  const done = new Set(decided.map((d) => d.sequence))
  const step = required.find((l) => !done.has(l.sequence)) ?? null
  if (!step) return { step: null, allowed: false, reason: 'DONE' as const }
  if (me.isRequester) return { step, allowed: false, reason: 'SELF_APPROVAL' as const }
  if (decided.some((d) => d.membershipId === me.membershipId))
    return { step, allowed: false, reason: 'SAME_APPROVER' as const }
  if (step.approverRoleId && !me.roleIds.has(step.approverRoleId))
    return { step, allowed: false, reason: 'ROLE_REQUIRED' as const }
  return { step, allowed: true, reason: null }
}

/** Estado depois de afectar/libertar: encomendada quando tudo está encomendado ou fechado; parcial se algo foi. */
export function fulfilmentStatus(
  current: RequisitionStatus,
  lines: { quantity: bigint; ordered: bigint; closed: bigint }[]
): RequisitionStatus {
  if (current === 'CLOSED') return 'CLOSED'
  const ordered = lines.some((l) => l.ordered > 0n)
  const complete = lines.every((l) => l.ordered + l.closed >= l.quantity)
  if (complete && ordered) return 'ORDERED'
  return ordered ? 'PARTIALLY_ORDERED' : 'APPROVED'
}

export interface LineInput {
  productId: string | null
  variantId: string | null
  description: string
  uomId: string | null
  quantity: bigint
  unitPrice: bigint
  taxRate: bigint
  neededBy: string | null
  suggestedSupplierId: string | null
  notes: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** Data AAAA-MM-DD real (2026-02-30 não passa: o `Date` rolaria para Março). */
export const isDate = (v: unknown): v is string =>
  typeof v === 'string' &&
  DATE.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const uuidish = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)

/** Normaliza as linhas (sem consultar a base): quantidades e preços em texto, taxa 0–100, datas. */
export function normalizeLines(raw: unknown): { lines: LineInput[]; issues: ErrorDetail[] } {
  const issues: ErrorDetail[] = []
  const list = Array.isArray(raw) ? raw : []
  if (!list.length)
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique pelo menos uma linha.' })
  if (list.length > 200)
    issues.push({ path: 'lines', code: 'TOO_MANY', message: 'Até 200 linhas.' })
  const lines: LineInput[] = []
  list.forEach((l: any, i: number) => {
    const at = (field: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${field}`, code, message })
    const q = parseScaled(l?.quantity, 6)
    if (q === null || q <= 0n)
      at('quantity', 'INVALID', 'Quantidade maior que zero, até 6 casas, em texto.')
    const p = parseScaled(l?.estimatedUnitPrice ?? '0', 6)
    if (p === null)
      at('estimatedUnitPrice', 'INVALID', 'Preço estimado ≥ 0, até 6 casas, em texto.')
    const t = parseScaled(l?.taxRate ?? '0', 3)
    if (t === null || t > 100_000n) at('taxRate', 'INVALID', 'Taxa de imposto entre 0 e 100.')
    const description = typeof l?.description === 'string' ? l.description.trim() : ''
    const productId = uuidish(l?.productId)
    if (!productId && description.length < 3)
      at('description', 'REQUIRED', 'Produto do catálogo ou descrição (mínimo 3 caracteres).')
    if (description.length > 300) at('description', 'LENGTH', 'Até 300 caracteres.')
    const neededBy = l?.neededBy ? l.neededBy : null
    if (neededBy !== null && !isDate(neededBy)) at('neededBy', 'INVALID', 'Data AAAA-MM-DD.')
    const notes = typeof l?.notes === 'string' && l.notes.trim() ? l.notes.trim() : null
    if (notes && notes.length > 500) at('notes', 'LENGTH', 'Até 500 caracteres.')
    lines.push({
      productId,
      variantId: uuidish(l?.variantId),
      description,
      uomId: uuidish(l?.uomId),
      quantity: q ?? 0n,
      unitPrice: p ?? 0n,
      taxRate: t ?? 0n,
      neededBy,
      suggestedSupplierId: uuidish(l?.suggestedSupplierId),
      notes,
    })
  })
  return { lines, issues }
}
