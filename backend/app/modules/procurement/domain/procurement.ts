import {
  fromScaled,
  roundDiv,
  toScaled,
  type RoundingMode,
} from '#modules/procurement/domain/decimal'

/**
 * Compras (M06). Domínio puro: estados, validação das entradas e aritmética exacta (sempre `bigint` escalado, nunca
 * `number`). O que foi recebido de uma linha deriva das recepções lançadas e não revertidas; nunca é um saldo editável.
 */
export type SupplierStatus = 'ACTIVE' | 'BLOCKED' | 'INACTIVE'
export type RequisitionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CONVERTED'
export type PurchaseStatus = 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED'
export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'REVERSED'

export const SUPPLIER_STATUSES: readonly SupplierStatus[] = ['ACTIVE', 'BLOCKED', 'INACTIVE']

/** O que o fornecedor fornece (classificação), independente do estado comercial e da homologação. */
export type SupplyType = 'GOODS' | 'SERVICES' | 'BOTH'
export const SUPPLY_TYPES: readonly SupplyType[] = ['GOODS', 'SERVICES', 'BOTH']
/** Avaliação qualitativa (A melhor, D pior); a avaliação de desempenho calculada vem num bloco posterior. */
export type SupplierRating = 'A' | 'B' | 'C' | 'D'
export const SUPPLIER_RATINGS: readonly SupplierRating[] = ['A', 'B', 'C', 'D']

/**
 * Homologação. `EXPIRED` nunca se grava: é a homologação (total ou condicionada) cuja validade já passou.
 */
export type StoredApprovalStatus =
  'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'CONDITIONALLY_APPROVED' | 'REJECTED' | 'SUSPENDED'
export type ApprovalStatus = StoredApprovalStatus | 'EXPIRED'
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'CONDITIONALLY_APPROVED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
]
export type ApprovalDecision = 'APPROVE' | 'APPROVE_CONDITIONALLY' | 'REJECT' | 'SUSPEND'
export type ApprovalAction = 'SUBMIT' | ApprovalDecision
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  'APPROVE',
  'APPROVE_CONDITIONALLY',
  'REJECT',
  'SUSPEND',
]

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/
export const CURRENCY = /^[A-Z]{3}$/
const QUANTITY = /^\d{1,13}(\.\d{1,6})?$/
const MONEY = /^\d{1,15}(\.\d{1,4})?$/
const RATE = /^\d{1,3}(\.\d{1,4})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

export const isPositiveQuantity = (value: unknown): value is string =>
  typeof value === 'string' && QUANTITY.test(value) && /[1-9]/.test(value)
export const isMoney = (value: unknown): value is string =>
  typeof value === 'string' && MONEY.test(value)

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null

// --- fornecedores -----------------------------------------------------------------------------------

export interface SupplierValues {
  partyId: string
  organizationId: string
  code: string
  paymentTermDays: number
  currency: string
  status: SupplierStatus
  statusReason: string | null
  categoryId: string | null
  supplyType: SupplyType
  critical: boolean
  rating: SupplierRating | null
  leadTimeDays: number | null
  notes: string | null
}

export interface SupplierInput {
  partyId?: unknown
  organizationId?: unknown
  code?: unknown
  paymentTermDays?: unknown
  currency?: unknown
  status?: unknown
  statusReason?: unknown
  categoryId?: unknown
  supplyType?: unknown
  critical?: unknown
  rating?: unknown
  leadTimeDays?: unknown
  notes?: unknown
}

/**
 * Valida o fornecedor. A Party, a organização e o código não mudam depois de criado. Bloquear ou inactivar exige motivo;
 * voltar a activo limpa-o.
 */
export function normalizeSupplier(
  input: SupplierInput,
  base: SupplierValues | null,
  defaultCurrency: string,
  issues: Issue[]
): SupplierValues | null {
  const before = issues.length
  const partyId = base?.partyId ?? input.partyId
  const organizationId = base?.organizationId ?? input.organizationId
  if (typeof partyId !== 'string' || !partyId) {
    issues.push(issue('partyId', 'REQUIRED', 'Indique a pessoa ou organização (Party).'))
  }
  if (typeof organizationId !== 'string' || !organizationId) {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  if (base) {
    for (const key of ['partyId', 'organizationId', 'code'] as const) {
      if (input[key] !== undefined && input[key] !== base[key]) {
        issues.push(issue(key, 'IMMUTABLE', 'Este campo não se altera depois de criado.'))
      }
    }
  }
  const code = base?.code ?? (typeof input.code === 'string' ? input.code.trim() : '')
  if (!base && !CODE.test(code)) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  const terms =
    input.paymentTermDays === undefined ? (base?.paymentTermDays ?? 0) : input.paymentTermDays
  if (!Number.isInteger(terms) || (terms as number) < 0 || (terms as number) > 3650) {
    issues.push(issue('paymentTermDays', 'INVALID_TERMS', 'Prazo: inteiro entre 0 e 3650 dias.'))
  }
  const currency =
    input.currency === undefined ? (base?.currency ?? defaultCurrency) : input.currency
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda ISO 4217 em maiúsculas (ex.: AOA).'))
  }
  const status = (input.status ?? base?.status ?? 'ACTIVE') as SupplierStatus
  if (!SUPPLIER_STATUSES.includes(status)) {
    issues.push(issue('status', 'INVALID_STATUS', 'Estado: ACTIVE, BLOCKED ou INACTIVE.'))
  }
  let statusReason: string | null = null
  if (status !== 'ACTIVE') {
    const given =
      input.statusReason === undefined ? (base?.statusReason ?? null) : input.statusReason
    statusReason = text(given, 300)
    if (!statusReason) {
      issues.push(
        issue('statusReason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')
      )
    }
  }
  const categoryId = input.categoryId === undefined ? (base?.categoryId ?? null) : input.categoryId
  if (categoryId !== null && (typeof categoryId !== 'string' || !categoryId)) {
    issues.push(issue('categoryId', 'INVALID_CATEGORY', 'Categoria inválida.'))
  }
  const supplyType = (input.supplyType ?? base?.supplyType ?? 'GOODS') as SupplyType
  if (!SUPPLY_TYPES.includes(supplyType)) {
    issues.push(issue('supplyType', 'INVALID_SUPPLY_TYPE', 'Fornece: GOODS, SERVICES ou BOTH.'))
  }
  const critical = input.critical === undefined ? (base?.critical ?? false) : input.critical
  if (typeof critical !== 'boolean') {
    issues.push(issue('critical', 'INVALID_CRITICAL', 'Indique verdadeiro ou falso.'))
  }
  const rating = (
    input.rating === undefined ? (base?.rating ?? null) : input.rating
  ) as SupplierRating | null
  if (rating !== null && !SUPPLIER_RATINGS.includes(rating)) {
    issues.push(issue('rating', 'INVALID_RATING', 'Avaliação: A, B, C ou D.'))
  }
  const leadTime =
    input.leadTimeDays === undefined ? (base?.leadTimeDays ?? null) : input.leadTimeDays
  if (
    leadTime !== null &&
    (!Number.isInteger(leadTime) || (leadTime as number) < 0 || (leadTime as number) > 3650)
  ) {
    issues.push(issue('leadTimeDays', 'INVALID_LEAD_TIME', 'Prazo: inteiro entre 0 e 3650 dias.'))
  }
  const notesInput = input.notes === undefined ? (base?.notes ?? null) : input.notes
  const notes = notesInput === null || notesInput === '' ? null : text(notesInput, 1000)
  if (notesInput !== null && notesInput !== '' && notes === null) {
    issues.push(issue('notes', 'INVALID_NOTES', 'Observações: até 1000 caracteres.'))
  }
  if (issues.length > before) return null
  return {
    partyId: partyId as string,
    organizationId: organizationId as string,
    code,
    paymentTermDays: terms as number,
    currency: currency as string,
    status,
    statusReason,
    categoryId: categoryId as string | null,
    supplyType,
    critical: critical as boolean,
    rating,
    leadTimeDays: leadTime as number | null,
    notes,
  }
}

// --- categorias de fornecedor -------------------------------------------------------------------------

export interface SupplierCategoryValues {
  code: string
  name: string
  description: string | null
  active: boolean
}

export function normalizeSupplierCategory(
  input: { code?: unknown; name?: unknown; description?: unknown; active?: unknown },
  base: SupplierCategoryValues | null,
  issues: Issue[]
): SupplierCategoryValues | null {
  const before = issues.length
  if (base && input.code !== undefined && input.code !== base.code) {
    issues.push(issue('code', 'IMMUTABLE', 'O código não se altera depois de criado.'))
  }
  const code = base?.code ?? (typeof input.code === 'string' ? input.code.trim() : '')
  if (!base && !CODE.test(code)) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  const name = input.name === undefined ? (base?.name ?? null) : text(input.name, 160)
  if (!name) issues.push(issue('name', 'REQUIRED', 'Indique a designação (até 160 caracteres).'))
  const given = input.description === undefined ? (base?.description ?? null) : input.description
  const description = given === null || given === '' ? null : text(given, 2000)
  if (given !== null && given !== '' && description === null) {
    issues.push(issue('description', 'INVALID_DESCRIPTION', 'Descrição: até 2000 caracteres.'))
  }
  const active = input.active === undefined ? (base?.active ?? true) : input.active
  if (typeof active !== 'boolean') {
    issues.push(issue('active', 'INVALID_ACTIVE', 'Indique verdadeiro ou falso.'))
  }
  if (issues.length > before) return null
  return { code, name: name as string, description, active: active as boolean }
}

// --- homologação ------------------------------------------------------------------------------------

export interface ApprovalState {
  approvalStatus: ApprovalStatus
  approvalValidUntil: string | null
  approvalConditions: string | null
  approvalRequestedByMembershipId: string | null
}

export interface ApprovalChange {
  action: ApprovalAction
  from: ApprovalStatus
  to: StoredApprovalStatus
  reason: string | null
  conditions: string | null
  validUntil: string | null
  requestedByMembershipId: string | null
}

export type ApprovalOutcome =
  | { ok: true; change: ApprovalChange }
  | { ok: false; kind: 'invalid'; issues: Issue[] }
  | { ok: false; kind: 'conflict'; code: string; message: string }

const DECIDED_FROM: Record<ApprovalDecision, readonly ApprovalStatus[]> = {
  APPROVE: ['UNDER_REVIEW'],
  APPROVE_CONDITIONALLY: ['UNDER_REVIEW'],
  REJECT: ['UNDER_REVIEW'],
  SUSPEND: ['APPROVED', 'CONDITIONALLY_APPROVED'],
}

const DECIDED_TO: Record<ApprovalDecision, StoredApprovalStatus> = {
  APPROVE: 'APPROVED',
  APPROVE_CONDITIONALLY: 'CONDITIONALLY_APPROVED',
  REJECT: 'REJECTED',
  SUSPEND: 'SUSPENDED',
}

/**
 * Regras da homologação:
 *  - submeter (pedir análise) é possível a partir de qualquer estado excepto «em análise»; serve também para renovar;
 *  - aprovar, aprovar com condições e rejeitar só a partir de «em análise», e quem pediu a análise não aprova
 *    (segregação de funções); rejeitar exige motivo, aprovar com condições exige as condições;
 *  - suspender só uma homologação em vigor, com motivo; a validade, se indicada, é posterior a hoje.
 */
export function approvalTransition(
  state: ApprovalState,
  action: ApprovalAction,
  input: { reason?: unknown; conditions?: unknown; validUntil?: unknown },
  actorMembershipId: string,
  today: string
): ApprovalOutcome {
  const issues: Issue[] = []
  const reasonGiven = input.reason === undefined || input.reason === null ? '' : input.reason
  const reason = reasonGiven === '' ? null : text(reasonGiven, 500)
  if (reasonGiven !== '' && reason === null) {
    issues.push(issue('reason', 'INVALID_REASON', 'Motivo: até 500 caracteres.'))
  }
  if ((action === 'REJECT' || action === 'SUSPEND') && reason === null && issues.length === 0) {
    issues.push(issue('reason', 'REASON_REQUIRED', 'Indique o motivo (até 500 caracteres).'))
  }
  let conditions: string | null = null
  if (action === 'APPROVE_CONDITIONALLY') {
    conditions = text(input.conditions, 1000)
    if (!conditions) {
      issues.push(
        issue('conditions', 'CONDITIONS_REQUIRED', 'Indique as condições (até 1000 caracteres).')
      )
    }
  } else if (input.conditions !== undefined && input.conditions !== null) {
    issues.push(issue('conditions', 'NOT_ALLOWED', 'Só a aprovação condicionada leva condições.'))
  }
  let validUntil: string | null = null
  if (action === 'APPROVE' || action === 'APPROVE_CONDITIONALLY') {
    if (input.validUntil !== undefined && input.validUntil !== null) {
      if (!isIsoDate(input.validUntil) || input.validUntil <= today) {
        issues.push(
          issue('validUntil', 'INVALID_VALIDITY', 'A validade é uma data (AAAA-MM-DD) futura.')
        )
      } else {
        validUntil = input.validUntil
      }
    }
  } else if (input.validUntil !== undefined && input.validUntil !== null) {
    issues.push(issue('validUntil', 'NOT_ALLOWED', 'Só a aprovação leva validade.'))
  }
  if (issues.length > 0) return { ok: false, kind: 'invalid', issues }

  const from = state.approvalStatus
  if (action === 'SUBMIT') {
    if (from === 'UNDER_REVIEW') {
      return {
        ok: false,
        kind: 'conflict',
        code: 'SUPPLIER_ALREADY_UNDER_REVIEW',
        message: 'A homologação já está em análise.',
      }
    }
    return {
      ok: true,
      change: {
        action,
        from,
        to: 'UNDER_REVIEW',
        reason,
        conditions: null,
        validUntil: null,
        requestedByMembershipId: actorMembershipId,
      },
    }
  }
  if (!DECIDED_FROM[action].includes(from)) {
    return {
      ok: false,
      kind: 'conflict',
      code: 'SUPPLIER_APPROVAL_STATE',
      message:
        action === 'SUSPEND'
          ? 'Só se suspende uma homologação em vigor.'
          : 'Só se decide uma homologação em análise.',
    }
  }
  if (
    (action === 'APPROVE' || action === 'APPROVE_CONDITIONALLY') &&
    state.approvalRequestedByMembershipId === actorMembershipId
  ) {
    return {
      ok: false,
      kind: 'conflict',
      code: 'SEGREGATION_OF_DUTIES',
      message: 'Quem pediu a análise do fornecedor não o pode homologar.',
    }
  }
  return {
    ok: true,
    change: {
      action,
      from,
      to: DECIDED_TO[action],
      reason,
      conditions,
      // Suspender conserva a validade anterior (para memória); rejeitar limpa-a.
      validUntil: action === 'SUSPEND' ? state.approvalValidUntil : validUntil,
      requestedByMembershipId: state.approvalRequestedByMembershipId,
    },
  }
}

/**
 * Um fornecedor bloqueado ou inactivo, com homologação rejeitada, suspensa ou caducada, ou crítico e sem homologação em
 * vigor, não recebe novas encomendas (as já feitas continuam a receber-se).
 */
export function purchaseBlocker(supplier: {
  status: SupplierStatus
  approvalStatus: ApprovalStatus
  critical: boolean
}): { code: string; message: string } | null {
  const { status, approvalStatus } = supplier
  if (status === 'BLOCKED') {
    return {
      code: 'SUPPLIER_BLOCKED',
      message: 'O fornecedor está bloqueado: não recebe novas encomendas.',
    }
  }
  if (status === 'INACTIVE') {
    return {
      code: 'SUPPLIER_INACTIVE',
      message: 'O fornecedor está inactivo: não recebe novas encomendas.',
    }
  }
  if (approvalStatus === 'REJECTED') {
    return {
      code: 'SUPPLIER_REJECTED',
      message: 'A homologação do fornecedor foi rejeitada: não recebe novas encomendas.',
    }
  }
  if (approvalStatus === 'SUSPENDED') {
    return {
      code: 'SUPPLIER_SUSPENDED',
      message: 'A homologação do fornecedor está suspensa: não recebe novas encomendas.',
    }
  }
  if (approvalStatus === 'EXPIRED') {
    return {
      code: 'SUPPLIER_APPROVAL_EXPIRED',
      message: 'A homologação do fornecedor caducou: renove-a antes de encomendar.',
    }
  }
  if (
    supplier.critical &&
    approvalStatus !== 'APPROVED' &&
    approvalStatus !== 'CONDITIONALLY_APPROVED'
  ) {
    return {
      code: 'SUPPLIER_NOT_APPROVED',
      message: 'Um fornecedor crítico só recebe encomendas depois de homologado.',
    }
  }
  return null
}

// --- linhas -----------------------------------------------------------------------------------------

export interface RequisitionLineInput {
  variantId?: unknown
  quantity?: unknown
}

export function normalizeRequisitionLine(
  input: RequisitionLineInput,
  path: string,
  issues: Issue[]
): { variantId: string; quantity: string } | null {
  const before = issues.length
  if (typeof input.variantId !== 'string' || !input.variantId) {
    issues.push(issue(`${path}variantId`, 'REQUIRED', 'Indique a variante.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  if (issues.length > before) return null
  return { variantId: input.variantId as string, quantity: input.quantity as string }
}

export interface PurchaseLineInput {
  variantId?: unknown
  quantity?: unknown
  unitCost?: unknown
  taxRate?: unknown
}

export interface PurchaseLineValues {
  variantId: string
  quantity: string
  unitCost: string
  taxRate: string
  netAmount: string
  taxAmount: string
  total: string
}

/** Linha de compra: `líquido = quantidade × custo`, `imposto = líquido × taxa`, cada um arredondado uma só vez. */
export function purchaseLineValues(
  input: PurchaseLineInput,
  path: string,
  mode: RoundingMode,
  issues: Issue[]
): PurchaseLineValues | null {
  const before = issues.length
  if (typeof input.variantId !== 'string' || !input.variantId) {
    issues.push(issue(`${path}variantId`, 'REQUIRED', 'Indique a variante.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  if (!isMoney(input.unitCost)) {
    issues.push(issue(`${path}unitCost`, 'INVALID_COST', 'Custo com até 4 casas, não negativo.'))
  }
  const taxRate = input.taxRate === undefined ? '0' : input.taxRate
  if (typeof taxRate !== 'string' || !RATE.test(taxRate) || Number(taxRate) > 100) {
    issues.push(
      issue(`${path}taxRate`, 'INVALID_TAX_RATE', 'Taxa em percentagem (0–100, até 4 casas).')
    )
  }
  if (issues.length > before) return null
  const quantity = toScaled(input.quantity as string, 6) as bigint
  const cost = toScaled(input.unitCost as string, 4) as bigint
  const rate = toScaled(taxRate as string, 4) as bigint
  const net = roundDiv(quantity * cost, 10n ** 6n, mode)
  const tax = roundDiv(net * rate, 1_000_000n, mode)
  return {
    variantId: input.variantId as string,
    quantity: input.quantity as string,
    unitCost: input.unitCost as string,
    taxRate: taxRate as string,
    netAmount: fromScaled(net, 4),
    taxAmount: fromScaled(tax, 4),
    total: fromScaled(net + tax, 4),
  }
}

// --- recepções --------------------------------------------------------------------------------------

export interface Balance {
  ordered: bigint
  received: bigint
}

/** O que ainda falta receber de uma linha (nunca negativo). */
export const remaining = (balance: Balance): bigint =>
  balance.ordered > balance.received ? balance.ordered - balance.received : 0n

/** `true` se a quantidade (positiva) cabe no saldo por receber. */
export const fits = (balance: Balance, quantity: string): boolean => {
  const q = toScaled(quantity, 6)
  return q !== null && q > 0n && q <= remaining(balance)
}

export const quantityText = (value: bigint): string => fromScaled(value, 6)

/** Estado da encomenda a partir dos saldos: nada recebido → `ORDERED`; tudo → `RECEIVED`; senão `PARTIAL`. */
export function statusAfterReceiving(
  balances: readonly Balance[]
): 'ORDERED' | 'PARTIAL' | 'RECEIVED' {
  if (balances.length === 0 || balances.every((b) => b.received === 0n)) return 'ORDERED'
  return balances.every((b) => b.received >= b.ordered) ? 'RECEIVED' : 'PARTIAL'
}

export const canReceive = (status: PurchaseStatus): boolean =>
  status === 'ORDERED' || status === 'PARTIAL'

export interface ReceiptLineInput {
  purchaseLineId?: unknown
  quantity?: unknown
  lotCode?: unknown
  expiresOn?: unknown
}

export interface ReceiptLineValues {
  purchaseLineId: string
  quantity: string
  lotCode: string | null
  expiresOn: string | null
}

export function normalizeReceiptLine(
  input: ReceiptLineInput,
  path: string,
  issues: Issue[]
): ReceiptLineValues | null {
  const before = issues.length
  if (typeof input.purchaseLineId !== 'string' || !input.purchaseLineId) {
    issues.push(issue(`${path}purchaseLineId`, 'REQUIRED', 'Indique a linha da encomenda.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  let lotCode: string | null = null
  if (input.lotCode !== undefined && input.lotCode !== null && input.lotCode !== '') {
    lotCode = text(input.lotCode, 60)
    if (!lotCode)
      issues.push(issue(`${path}lotCode`, 'INVALID_LOT', 'Código do lote até 60 caracteres.'))
  }
  let expiresOn: string | null = null
  if (input.expiresOn !== undefined && input.expiresOn !== null && input.expiresOn !== '') {
    if (!isIsoDate(input.expiresOn)) {
      issues.push(issue(`${path}expiresOn`, 'INVALID_DATE', 'A validade tem de ser AAAA-MM-DD.'))
    } else {
      expiresOn = input.expiresOn
    }
  }
  if (issues.length > before) return null
  return {
    purchaseLineId: input.purchaseLineId as string,
    quantity: input.quantity as string,
    lotCode,
    expiresOn,
  }
}

export interface LineTotals {
  netAmount: string
  taxAmount: string
  total: string
}

/** Soma exacta dos valores das linhas já arredondadas: o total do documento é a soma das suas linhas. */
export function sumLines(lines: readonly LineTotals[]): {
  net: string
  tax: string
  total: string
} {
  let net = 0n
  let tax = 0n
  let total = 0n
  for (const line of lines) {
    net += toScaled(line.netAmount, 4) ?? 0n
    tax += toScaled(line.taxAmount, 4) ?? 0n
    total += toScaled(line.total, 4) ?? 0n
  }
  return { net: fromScaled(net, 4), tax: fromScaled(tax, 4), total: fromScaled(total, 4) }
}
