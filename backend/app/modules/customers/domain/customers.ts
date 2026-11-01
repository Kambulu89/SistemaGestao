/**
 * Clientes (M01). Domínio puro: o cliente guarda só as condições comerciais; a identidade (nome, NIF, contactos) é da Party.
 * O limite de crédito é dinheiro: atravessa sempre como texto decimal, nunca `number`.
 */
export type CustomerStatus = 'ACTIVE' | 'BLOCKED' | 'INACTIVE'
export type InteractionChannel = 'CALL' | 'EMAIL' | 'MEETING' | 'NOTE'
export const CUSTOMER_STATUSES: readonly CustomerStatus[] = ['ACTIVE', 'BLOCKED', 'INACTIVE']
export const CHANNELS: readonly InteractionChannel[] = ['CALL', 'EMAIL', 'MEETING', 'NOTE']

export interface Issue {
  path: string
  code: string
  message: string
}

export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/
export const MONEY = /^\d{1,15}(\.\d{1,4})?$/
export const CURRENCY = /^[A-Z]{3}$/

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null

// --- segmentos --------------------------------------------------------------------------------------

export interface SegmentValues {
  code: string
  name: string
  description: string | null
  active: boolean
}

export interface SegmentInput {
  code?: unknown
  name?: unknown
  description?: unknown
  active?: unknown
}

export function normalizeSegment(
  input: SegmentInput,
  base: SegmentValues | null,
  issues: Issue[]
): SegmentValues | null {
  const before = issues.length
  const code = base?.code ?? (typeof input.code === 'string' ? input.code.trim() : '')
  if (!base && !CODE.test(code)) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  const name = input.name === undefined ? (base?.name ?? null) : text(input.name, 160)
  if (!name) issues.push(issue('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).'))
  let description = base?.description ?? null
  if (input.description !== undefined) {
    description = input.description === null ? null : text(input.description, 500)
    if (input.description !== null && !description) {
      issues.push(issue('description', 'INVALID_DESCRIPTION', 'Descrição: até 500 caracteres.'))
    }
  }
  const active = input.active === undefined ? (base?.active ?? true) : input.active
  if (typeof active !== 'boolean')
    issues.push(issue('active', 'INVALID_FLAG', 'active é booleano.'))
  if (issues.length > before || !name) return null
  return { code, name, description, active: active as boolean }
}

// --- clientes ---------------------------------------------------------------------------------------

/** Meio de pagamento preferido (informativo: propõe-se ao registar recebimentos; não restringe). */
export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'CHEQUE' | 'DIRECT_DEBIT' | 'OTHER'
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'CHEQUE',
  'DIRECT_DEBIT',
  'OTHER',
]
/** Regime fiscal do cliente; isento exige o motivo, que segue no instantâneo da factura. */
export type TaxRegime = 'GENERAL' | 'SIMPLIFIED' | 'EXEMPT'
export const TAX_REGIMES: readonly TaxRegime[] = ['GENERAL', 'SIMPLIFIED', 'EXEMPT']

/** O perfil de facturação: que moradas e contacto da Party usar, meio de pagamento e regime fiscal. */
export interface BillingProfile {
  billingAddressId: string | null
  shippingAddressId: string | null
  billingContactId: string | null
  preferredPaymentMethod: PaymentMethod | null
  taxRegime: TaxRegime
  taxExemptionReason: string | null
}

export interface CustomerValues extends BillingProfile {
  partyId: string
  organizationId: string
  code: string
  segmentId: string | null
  accountManagerMembershipId: string | null
  paymentTermDays: number
  creditLimit: string
  currency: string
  status: CustomerStatus
  statusReason: string | null
}

export interface CustomerInput {
  partyId?: unknown
  organizationId?: unknown
  code?: unknown
  segmentId?: unknown
  accountManagerMembershipId?: unknown
  paymentTermDays?: unknown
  creditLimit?: unknown
  currency?: unknown
  status?: unknown
  billingAddressId?: unknown
  shippingAddressId?: unknown
  billingContactId?: unknown
  preferredPaymentMethod?: unknown
  taxRegime?: unknown
  taxExemptionReason?: unknown
}

/** O que só quem pode gerir crédito altera: o limite e a moeda em que se mede. */
export const touchesCredit = (input: CustomerInput): boolean =>
  input.creditLimit !== undefined || input.currency !== undefined

/**
 * Valida e completa um cliente. `defaultCurrency` (a moeda base da organização) vale quando não há moeda nem base. A
 * Party, a organização e o código nunca mudam depois de criado; `BLOCKED` só se alcança (e deixa) por bloqueio/desbloqueio.
 */
export function normalizeCustomer(
  input: CustomerInput,
  base: CustomerValues | null,
  defaultCurrency: string,
  issues: Issue[]
): CustomerValues | null {
  const before = issues.length
  const code = base?.code ?? (typeof input.code === 'string' ? input.code.trim() : '')
  if (!base && !CODE.test(code)) {
    issues.push(issue('code', 'INVALID_CODE', 'Código: letras, números, . _ - (máx. 50).'))
  }
  const partyId = base?.partyId ?? input.partyId
  const organizationId = base?.organizationId ?? input.organizationId
  if (!base && typeof partyId !== 'string') {
    issues.push(issue('partyId', 'REQUIRED', 'Indique a pessoa ou organização (Party).'))
  }
  if (!base && typeof organizationId !== 'string') {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  const term =
    input.paymentTermDays === undefined ? (base?.paymentTermDays ?? 0) : input.paymentTermDays
  if (!Number.isInteger(term) || (term as number) < 0 || (term as number) > 3650) {
    issues.push(issue('paymentTermDays', 'INVALID_TERM', 'Prazo de pagamento: 0 a 3650 dias.'))
  }
  const creditLimit = (
    input.creditLimit === undefined ? (base?.creditLimit ?? '0') : input.creditLimit
  ) as string
  if (typeof creditLimit !== 'string' || !MONEY.test(creditLimit)) {
    issues.push(
      issue('creditLimit', 'INVALID_MONEY', 'Limite de crédito: número não negativo, até 4 casas.')
    )
  }
  const currency = (
    input.currency === undefined ? (base?.currency ?? defaultCurrency) : input.currency
  ) as string
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda: três letras maiúsculas (ISO 4217).'))
  }
  const status = (input.status ?? base?.status ?? 'ACTIVE') as CustomerStatus
  if (!CUSTOMER_STATUSES.includes(status)) {
    issues.push(issue('status', 'INVALID_STATUS', `Estado: ${CUSTOMER_STATUSES.join(', ')}.`))
  } else if (status === 'BLOCKED' && base?.status !== 'BLOCKED') {
    issues.push(
      issue('status', 'USE_BLOCK', 'Para bloquear use a operação de bloqueio (com motivo).')
    )
  } else if (base?.status === 'BLOCKED' && status !== 'BLOCKED') {
    issues.push(issue('status', 'USE_UNBLOCK', 'Para desbloquear use a operação de desbloqueio.'))
  }
  const pick = <K extends keyof BillingProfile>(key: K): unknown =>
    input[key] === undefined ? (base?.[key] ?? null) : input[key]
  const payment = pick('preferredPaymentMethod')
  if (payment !== null && !PAYMENT_METHODS.includes(payment as PaymentMethod)) {
    issues.push(
      issue(
        'preferredPaymentMethod',
        'INVALID_PAYMENT_METHOD',
        `Meio: ${PAYMENT_METHODS.join(', ')}.`
      )
    )
  }
  const regime = (input.taxRegime ?? base?.taxRegime ?? 'GENERAL') as TaxRegime
  if (!TAX_REGIMES.includes(regime)) {
    issues.push(issue('taxRegime', 'INVALID_TAX_REGIME', `Regime: ${TAX_REGIMES.join(', ')}.`))
  }
  let exemption: string | null = null
  if (regime === 'EXEMPT') {
    const given = pick('taxExemptionReason')
    exemption = typeof given === 'string' && given.trim() ? given.trim() : null
    if (!exemption || exemption.length > 200) {
      issues.push(
        issue(
          'taxExemptionReason',
          'EXEMPTION_REASON_REQUIRED',
          'Indique o motivo da isenção (até 200 caracteres).'
        )
      )
    }
  } else if (input.taxExemptionReason !== undefined && input.taxExemptionReason !== null) {
    issues.push(
      issue('taxExemptionReason', 'NOT_ALLOWED', 'Só o regime isento leva motivo de isenção.')
    )
  }
  for (const key of [
    'segmentId',
    'accountManagerMembershipId',
    'billingAddressId',
    'shippingAddressId',
    'billingContactId',
  ] as const) {
    const value = input[key]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      issues.push(issue(key, 'INVALID_ID', 'Identificador inválido.'))
    }
  }
  if (issues.length > before) return null
  return {
    partyId: partyId as string,
    organizationId: organizationId as string,
    code,
    segmentId:
      ((input.segmentId === undefined ? base?.segmentId : input.segmentId) as string | null) ??
      null,
    accountManagerMembershipId:
      ((input.accountManagerMembershipId === undefined
        ? base?.accountManagerMembershipId
        : input.accountManagerMembershipId) as string | null) ?? null,
    paymentTermDays: term as number,
    creditLimit,
    currency,
    status,
    statusReason: base?.statusReason ?? null,
    billingAddressId: pick('billingAddressId') as string | null,
    shippingAddressId: pick('shippingAddressId') as string | null,
    billingContactId: pick('billingContactId') as string | null,
    preferredPaymentMethod: payment as PaymentMethod | null,
    taxRegime: regime,
    taxExemptionReason: exemption,
  }
}

export const blockReasonIssue = (reason: unknown): Issue | null =>
  text(reason, 300)
    ? null
    : issue('reason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')

/** Uma venda só se confirma a clientes activos: bloqueado e inactivo recusam (cobrar e regularizar continuam possíveis). */
export function saleBlocker(status: CustomerStatus): { code: string; message: string } | null {
  if (status === 'BLOCKED') {
    return {
      code: 'CUSTOMER_BLOCKED',
      message: 'O cliente está bloqueado: não aceita novas confirmações de venda.',
    }
  }
  if (status === 'INACTIVE') {
    return {
      code: 'CUSTOMER_INACTIVE',
      message: 'O cliente está inactivo: não aceita novas confirmações de venda.',
    }
  }
  return null
}

// --- interacções ------------------------------------------------------------------------------------

export interface InteractionValues {
  partyId: string
  channel: InteractionChannel
  subject: string
  occurredAt: string
  ownerMembershipId: string
  summary: string
  followUpAt: string | null
}

export interface InteractionInput {
  partyId?: unknown
  channel?: unknown
  subject?: unknown
  occurredAt?: unknown
  summary?: unknown
  followUpAt?: unknown
}

const instant = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** `now` e `owner` vêm do chamador (relógio e actor): o domínio não os inventa. */
export function normalizeInteraction(
  input: InteractionInput,
  base: InteractionValues | null,
  owner: string,
  now: Date,
  issues: Issue[]
): InteractionValues | null {
  const before = issues.length
  const partyId = base?.partyId ?? input.partyId
  if (!base && typeof partyId !== 'string') {
    issues.push(issue('partyId', 'REQUIRED', 'Indique a pessoa ou organização (Party).'))
  }
  const channel = (input.channel ?? base?.channel) as InteractionChannel
  if (!CHANNELS.includes(channel)) {
    issues.push(issue('channel', 'INVALID_CHANNEL', `Canal: ${CHANNELS.join(', ')}.`))
  }
  const subject = input.subject === undefined ? (base?.subject ?? null) : text(input.subject, 200)
  if (!subject)
    issues.push(issue('subject', 'INVALID_SUBJECT', 'O assunto é obrigatório (máx. 200).'))
  const occurredAt =
    input.occurredAt === undefined
      ? (base?.occurredAt ?? now.toISOString())
      : instant(input.occurredAt)
  if (!occurredAt) {
    issues.push(issue('occurredAt', 'INVALID_INSTANT', 'Data e hora inválidas (ISO 8601).'))
  } else if (Date.parse(occurredAt) > now.getTime() + 86_400_000) {
    issues.push(
      issue('occurredAt', 'FUTURE', 'Uma interacção já aconteceu: a data não pode estar no futuro.')
    )
  }
  const summary = input.summary === undefined ? (base?.summary ?? '') : input.summary
  if (typeof summary !== 'string' || summary.length > 5000) {
    issues.push(issue('summary', 'INVALID_SUMMARY', 'Resumo: até 5000 caracteres.'))
  }
  let followUpAt = base?.followUpAt ?? null
  if (input.followUpAt !== undefined) {
    followUpAt = input.followUpAt === null ? null : instant(input.followUpAt)
    if (input.followUpAt !== null && !followUpAt) {
      issues.push(issue('followUpAt', 'INVALID_INSTANT', 'Data e hora inválidas (ISO 8601).'))
    }
  }
  if (occurredAt && followUpAt && Date.parse(followUpAt) < Date.parse(occurredAt)) {
    issues.push(
      issue('followUpAt', 'BEFORE_OCCURRED', 'O seguimento não pode ser anterior à interacção.')
    )
  }
  if (issues.length > before || !subject || !occurredAt) return null
  return {
    partyId: partyId as string,
    channel,
    subject,
    occurredAt,
    ownerMembershipId: base?.ownerMembershipId ?? owner,
    summary: summary as string,
    followUpAt,
  }
}
