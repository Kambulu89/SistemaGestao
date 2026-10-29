import { MONEY_SCALE, fromScaled, toScaled } from '#core/decimal/index'

/**
 * CRM comercial (M02). Domínio puro: estados, validação das entradas, regras do pipeline e do consentimento. Dinheiro em
 * aritmética exacta (texto decimal, nunca `number`). Nada aqui conhece a base de dados nem outros módulos.
 */
export type LeadStatus = 'NEW' | 'QUALIFIED' | 'DISQUALIFIED' | 'CONVERTED'
export type ConsentStatus = 'UNKNOWN' | 'OPT_IN' | 'OPT_OUT'
export type StageOutcome = 'WON' | 'LOST'
export type ActivityKind = 'CALL' | 'EMAIL' | 'MEETING' | 'TASK' | 'NOTE'
export type CampaignChannel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'CALL' | 'EVENT' | 'OTHER'
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED'
export type MemberStatus = 'TARGETED' | 'CONTACTED' | 'RESPONDED' | 'OPTED_OUT'
export type ExclusionKind = 'EMAIL' | 'PHONE'

export const LEAD_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'QUALIFIED',
  'DISQUALIFIED',
  'CONVERTED',
]
export const CONSENT_STATUSES: readonly ConsentStatus[] = ['UNKNOWN', 'OPT_IN', 'OPT_OUT']
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['CALL', 'EMAIL', 'MEETING', 'TASK', 'NOTE']
export const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = [
  'EMAIL',
  'SMS',
  'WHATSAPP',
  'CALL',
  'EVENT',
  'OTHER',
]
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
]

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

const MONEY = /^\d{1,15}(\.\d{1,4})?$/
const RATE = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/
const CURRENCY = /^[A-Z]{3}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[\d\s().-]{5,40}$/
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))

export const isMoney = (value: unknown): value is string =>
  typeof value === 'string' && MONEY.test(value)

export const showMoney = (value: string): string =>
  fromScaled(toScaled(value, MONEY_SCALE) as bigint, MONEY_SCALE)

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null

/** `undefined` se não vem; `null` se vem vazio; o texto aparado; `false` se é inválido. */
function optional(value: unknown, max: number): string | null | undefined | false {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length <= max ? trimmed : false
}

// --- leads ------------------------------------------------------------------------------------------

export interface LeadValues {
  name: string
  companyName: string | null
  email: string | null
  phone: string | null
  source: string
  consentStatus: ConsentStatus
}

export interface LeadInput {
  name?: unknown
  companyName?: unknown
  email?: unknown
  phone?: unknown
  source?: unknown
  consentStatus?: unknown
}

/** Valida e completa uma lead. O email guarda-se em minúsculas: é a chave da lista de exclusão. */
export function normalizeLead(input: LeadInput, base: LeadValues | null, issues: Issue[]) {
  const before = issues.length
  const name = input.name === undefined && base ? base.name : text(input.name, 160)
  if (!name) issues.push(issue('name', 'REQUIRED', 'Indique o nome da lead (até 160 caracteres).'))
  const pick = (key: 'companyName' | 'email' | 'phone', max: number, field: string) => {
    const value = optional(input[key], max)
    if (value === false) issues.push(issue(field, 'INVALID', 'Valor inválido.'))
    return value === undefined ? (base?.[key] ?? null) : value || null
  }
  const companyName = pick('companyName', 160, 'companyName')
  let email = pick('email', 200, 'email')
  if (email) {
    email = email.toLowerCase()
    if (!EMAIL.test(email)) issues.push(issue('email', 'INVALID_EMAIL', 'Email inválido.'))
  }
  const phone = pick('phone', 40, 'phone')
  if (phone && !PHONE.test(phone))
    issues.push(issue('phone', 'INVALID_PHONE', 'Telefone inválido.'))
  const source = input.source === undefined && base ? base.source : text(input.source, 60)
  if (!source)
    issues.push(issue('source', 'REQUIRED', 'Indique a origem da lead (até 60 caracteres).'))
  const consent = input.consentStatus ?? base?.consentStatus ?? 'UNKNOWN'
  if (!CONSENT_STATUSES.includes(consent as ConsentStatus)) {
    issues.push(issue('consentStatus', 'INVALID', 'Consentimento: UNKNOWN, OPT_IN ou OPT_OUT.'))
  }
  if (issues.length > before) return null
  return {
    name: name as string,
    companyName,
    email,
    phone,
    source: source as string,
    consentStatus: consent as ConsentStatus,
  } satisfies LeadValues
}

/**
 * Nome próprio e apelido de uma pessoa a partir do nome da lead: o último elemento é o apelido. Com um só elemento não
 * se inventa um apelido (`null`): a conversão pede para completar o nome ou ligar uma Party existente.
 */
export function splitName(name: string): { givenNames: string; familyName: string } | null {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return null
  return { givenNames: parts.slice(0, -1).join(' '), familyName: parts[parts.length - 1] as string }
}

/** Código de cliente derivado da lead quando quem converte não indica um. */
export const customerCodeOf = (leadId: string): string =>
  `L-${leadId.replaceAll('-', '').slice(0, 10).toUpperCase()}`

export function normalizeCustomerCode(value: unknown, leadId: string, issues: Issue[]): string {
  if (value === undefined || value === null || value === '') return customerCodeOf(leadId)
  if (typeof value !== 'string' || !CODE.test(value.trim())) {
    issues.push(issue('customerCode', 'INVALID_CODE', 'Código de cliente inválido.'))
    return customerCodeOf(leadId)
  }
  return value.trim()
}

// --- pipeline ---------------------------------------------------------------------------------------

export interface StageValues {
  pipelineCode: string
  code: string
  name: string
  position: number
  probability: string
  terminal: boolean
  outcome: StageOutcome | null
  requiresEvidence: boolean
  active: boolean
}

export interface StageInput {
  pipelineCode?: unknown
  code?: unknown
  name?: unknown
  position?: unknown
  probability?: unknown
  outcome?: unknown
  requiresEvidence?: unknown
  active?: unknown
}

export const DEFAULT_PIPELINE = 'DEFAULT'

/** Etapas por omissão, criadas quando um tenant ainda não definiu o seu pipeline. */
export const DEFAULT_STAGES: readonly StageValues[] = [
  stage('NEW', 'Novo', 1, '0.1000', null),
  stage('QUALIFIED', 'Qualificado', 2, '0.2500', null),
  stage('PROPOSAL', 'Proposta', 3, '0.5000', null),
  stage('NEGOTIATION', 'Negociação', 4, '0.7500', null),
  stage('WON', 'Ganha', 5, '1.0000', 'WON'),
  stage('LOST', 'Perdida', 6, '0.0000', 'LOST'),
]

function stage(
  code: string,
  name: string,
  position: number,
  probability: string,
  outcome: StageOutcome | null
): StageValues {
  return {
    pipelineCode: DEFAULT_PIPELINE,
    code,
    name,
    position,
    probability,
    terminal: outcome !== null,
    outcome,
    requiresEvidence: false,
    active: true,
  }
}

export function normalizeStage(input: StageInput, base: StageValues | null, issues: Issue[]) {
  const before = issues.length
  const pipelineCode =
    base?.pipelineCode ?? (text(input.pipelineCode ?? DEFAULT_PIPELINE, 40) as string)
  const code =
    base?.code ??
    (typeof input.code === 'string' && CODE.test(input.code.trim()) ? input.code.trim() : null)
  if (!code) issues.push(issue('code', 'INVALID_CODE', 'Código inválido (letras, números, . _ -).'))
  const name = input.name === undefined && base ? base.name : text(input.name, 120)
  if (!name) issues.push(issue('name', 'REQUIRED', 'Indique o nome da etapa.'))
  const position = input.position === undefined && base ? base.position : input.position
  if (
    typeof position !== 'number' ||
    !Number.isInteger(position) ||
    position < 1 ||
    position > 999
  ) {
    issues.push(issue('position', 'INVALID_POSITION', 'Posição: inteiro entre 1 e 999.'))
  }
  const probability = input.probability === undefined && base ? base.probability : input.probability
  if (typeof probability !== 'string' || !RATE.test(probability)) {
    issues.push(
      issue('probability', 'INVALID_PROBABILITY', 'Probabilidade entre 0 e 1 (texto decimal).')
    )
  }
  let outcome: StageOutcome | null = base?.outcome ?? null
  if (input.outcome !== undefined) {
    if (base && input.outcome !== base.outcome) {
      issues.push(issue('outcome', 'IMMUTABLE', 'O desfecho de uma etapa não se altera.'))
    } else if (input.outcome === null) outcome = null
    else if (input.outcome === 'WON' || input.outcome === 'LOST') outcome = input.outcome
    else issues.push(issue('outcome', 'INVALID', 'Desfecho: WON, LOST ou vazio.'))
  }
  const requiresEvidence = Boolean(input.requiresEvidence ?? base?.requiresEvidence ?? false)
  if (requiresEvidence && outcome !== 'WON') {
    issues.push(issue('requiresEvidence', 'ONLY_WON', 'Só a etapa «ganha» pode exigir evidência.'))
  }
  if (issues.length > before) return null
  return {
    pipelineCode,
    code: code as string,
    name: name as string,
    position: position as number,
    probability: showRate(probability as string),
    terminal: outcome !== null,
    outcome,
    requiresEvidence,
    active: Boolean(input.active ?? base?.active ?? true),
  } satisfies StageValues
}

const showRate = (value: string): string => {
  const [int = '0', frac = ''] = value.split('.')
  return `${int}.${frac.padEnd(4, '0')}`
}

// --- oportunidades ----------------------------------------------------------------------------------

export interface OpportunityValues {
  organizationId: string
  customerId: string | null
  leadId: string | null
  name: string
  stageId: string | null
  expectedValue: string
  currency: string
  expectedCloseDate: string | null
}

export interface OpportunityInput {
  organizationId?: unknown
  customerId?: unknown
  leadId?: unknown
  name?: unknown
  stageId?: unknown
  expectedValue?: unknown
  currency?: unknown
  expectedCloseDate?: unknown
}

export function normalizeOpportunity(
  input: OpportunityInput,
  base: OpportunityValues | null,
  defaultCurrency: string,
  issues: Issue[]
) {
  const before = issues.length
  const organizationId = base?.organizationId ?? input.organizationId
  if (typeof organizationId !== 'string') {
    issues.push(issue('organizationId', 'REQUIRED', 'Indique a organização.'))
  }
  const customerId = base ? base.customerId : (input.customerId ?? null)
  const leadId = base ? base.leadId : (input.leadId ?? null)
  if (
    (customerId !== null && typeof customerId !== 'string') ||
    (leadId !== null && typeof leadId !== 'string')
  ) {
    issues.push(issue('customerId', 'INVALID', 'Identificador inválido.'))
  } else if (customerId === null && leadId === null) {
    issues.push(issue('customerId', 'REQUIRED', 'Indique o cliente ou a lead da oportunidade.'))
  }
  const name = input.name === undefined && base ? base.name : text(input.name, 200)
  if (!name) issues.push(issue('name', 'REQUIRED', 'Indique o nome da oportunidade.'))
  const value =
    input.expectedValue === undefined ? (base?.expectedValue ?? '0') : input.expectedValue
  if (!isMoney(value)) {
    issues.push(
      issue('expectedValue', 'INVALID_AMOUNT', 'Valor esperado inválido (até 4 casas decimais).')
    )
  }
  const currency =
    input.currency === undefined ? (base?.currency ?? defaultCurrency) : input.currency
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda ISO de três letras maiúsculas.'))
  } else if (base && currency !== base.currency && input.currency !== undefined) {
    issues.push(issue('currency', 'IMMUTABLE', 'A moeda de uma oportunidade não se altera.'))
  }
  const close =
    input.expectedCloseDate === undefined
      ? (base?.expectedCloseDate ?? null)
      : input.expectedCloseDate
  if (close !== null && !isIsoDate(close)) {
    issues.push(issue('expectedCloseDate', 'INVALID_DATE', 'Data inválida (AAAA-MM-DD).'))
  }
  const stageId = input.stageId === undefined ? (base?.stageId ?? null) : input.stageId
  if (stageId !== null && typeof stageId !== 'string') {
    issues.push(issue('stageId', 'INVALID', 'Etapa inválida.'))
  }
  if (issues.length > before) return null
  return {
    organizationId: organizationId as string,
    customerId: customerId as string | null,
    leadId: leadId as string | null,
    name: name as string,
    stageId: stageId as string | null,
    expectedValue: showMoney(value as string),
    currency: currency as string,
    expectedCloseDate: close as string | null,
  } satisfies OpportunityValues
}

export interface StageRef {
  id: string
  outcome: StageOutcome | null
  requiresEvidence: boolean
  active: boolean
}

/**
 * Mover uma oportunidade: sem sair de uma etapa terminal (ganha/perdida), só para etapas activas; perder exige motivo e
 * ganhar exige a evidência quando a etapa a configura. Mover para a etapa onde já está não faz nada.
 */
export function planMove(
  current: StageRef,
  target: StageRef,
  input: { lossReason?: unknown; winEvidence?: unknown }
):
  | { noop: true }
  | { noop: false; lossReason: string | null; winEvidence: string | null }
  | { issues: Issue[] } {
  if (current.id === target.id) return { noop: true }
  const issues: Issue[] = []
  if (current.outcome !== null) {
    issues.push(
      issue('stageId', 'OPPORTUNITY_CLOSED', 'Uma oportunidade ganha ou perdida já não se move.')
    )
  }
  if (!target.active) issues.push(issue('stageId', 'STAGE_INACTIVE', 'A etapa está inactiva.'))
  let lossReason: string | null = null
  let winEvidence: string | null = null
  if (target.outcome === 'LOST') {
    lossReason = text(input.lossReason, 1000)
    if (!lossReason)
      issues.push(issue('lossReason', 'LOSS_REASON_REQUIRED', 'Indique o motivo da perda.'))
  }
  if (target.outcome === 'WON') {
    winEvidence =
      typeof input.winEvidence === 'string' ? input.winEvidence.trim().slice(0, 2000) : null
    if (target.requiresEvidence && (winEvidence?.length ?? 0) < 3) {
      issues.push(
        issue(
          'winEvidence',
          'EVIDENCE_REQUIRED',
          'Esta etapa exige a evidência comercial do ganho.'
        )
      )
    }
    if (winEvidence === '') winEvidence = null
  }
  return issues.length > 0 ? { issues } : { noop: false, lossReason, winEvidence }
}

// --- actividades ------------------------------------------------------------------------------------

export interface ActivityValues {
  kind: ActivityKind
  subject: string
  notes: string | null
  dueAt: string | null
}

export function normalizeActivity(
  input: { kind?: unknown; subject?: unknown; notes?: unknown; dueAt?: unknown },
  issues: Issue[]
) {
  const before = issues.length
  if (!ACTIVITY_KINDS.includes(input.kind as ActivityKind)) {
    issues.push(issue('kind', 'INVALID', 'Tipo: CALL, EMAIL, MEETING, TASK ou NOTE.'))
  }
  const subject = text(input.subject, 200)
  if (!subject) issues.push(issue('subject', 'REQUIRED', 'Indique o assunto (até 200 caracteres).'))
  const notes = optional(input.notes, 4000)
  if (notes === false) issues.push(issue('notes', 'INVALID', 'Notas inválidas.'))
  const dueAt = input.dueAt ?? null
  if (dueAt !== null && !isInstant(dueAt)) {
    issues.push(issue('dueAt', 'INVALID_DATE', 'Data e hora inválidas.'))
  }
  if (issues.length > before) return null
  return {
    kind: input.kind as ActivityKind,
    subject: subject as string,
    notes: notes || null,
    dueAt: dueAt as string | null,
  } satisfies ActivityValues
}

// --- campanhas --------------------------------------------------------------------------------------

export interface CampaignValues {
  name: string
  channel: CampaignChannel
  startsAt: string
  endsAt: string | null
  budget: string
  currency: string
}

export interface CampaignInput {
  name?: unknown
  channel?: unknown
  startsAt?: unknown
  endsAt?: unknown
  budget?: unknown
  currency?: unknown
}

export function normalizeCampaign(
  input: CampaignInput,
  base: CampaignValues | null,
  defaultCurrency: string,
  issues: Issue[]
) {
  const before = issues.length
  const name = input.name === undefined && base ? base.name : text(input.name, 160)
  if (!name) issues.push(issue('name', 'REQUIRED', 'Indique o nome da campanha.'))
  const channel = input.channel ?? base?.channel
  if (!CAMPAIGN_CHANNELS.includes(channel as CampaignChannel)) {
    issues.push(issue('channel', 'INVALID', 'Canal: EMAIL, SMS, WHATSAPP, CALL, EVENT ou OTHER.'))
  } else if (base && input.channel !== undefined && channel !== base.channel) {
    issues.push(issue('channel', 'IMMUTABLE', 'O canal de uma campanha não se altera.'))
  }
  const startsAt = input.startsAt ?? base?.startsAt
  if (!isInstant(startsAt)) issues.push(issue('startsAt', 'INVALID_DATE', 'Início inválido.'))
  const endsAt = input.endsAt === undefined ? (base?.endsAt ?? null) : input.endsAt
  if (endsAt !== null && !isInstant(endsAt)) {
    issues.push(issue('endsAt', 'INVALID_DATE', 'Fim inválido.'))
  } else if (isInstant(startsAt) && endsAt !== null && Date.parse(endsAt) < Date.parse(startsAt)) {
    issues.push(issue('endsAt', 'BEFORE_START', 'O fim não pode ser anterior ao início.'))
  }
  const budget = input.budget === undefined ? (base?.budget ?? '0') : input.budget
  if (!isMoney(budget)) issues.push(issue('budget', 'INVALID_AMOUNT', 'Orçamento inválido.'))
  const currency =
    input.currency === undefined ? (base?.currency ?? defaultCurrency) : input.currency
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    issues.push(issue('currency', 'INVALID_CURRENCY', 'Moeda ISO de três letras maiúsculas.'))
  }
  if (issues.length > before) return null
  return {
    name: name as string,
    channel: channel as CampaignChannel,
    startsAt: startsAt as string,
    endsAt: endsAt as string | null,
    budget: showMoney(budget as string),
    currency: currency as string,
  } satisfies CampaignValues
}

/** Transições de estado de uma campanha: rascunho → activa ⇄ pausada → concluída (final). */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'COMPLETED'],
  COMPLETED: [],
}

// --- consentimento e exclusão -----------------------------------------------------------------------

/** Chave de comparação na lista de exclusão: email em minúsculas; telefone só com `+` inicial e dígitos. */
export function exclusionValue(kind: ExclusionKind, value: string): string | null {
  const trimmed = value.trim()
  if (kind === 'EMAIL') return EMAIL.test(trimmed.toLowerCase()) ? trimmed.toLowerCase() : null
  if (!PHONE.test(trimmed)) return null
  const digits = trimmed.replace(/\D/g, '')
  return digits.length >= 5 ? `${trimmed.startsWith('+') ? '+' : ''}${digits}` : null
}

export type SendDecision = 'SEND' | 'OPTED_OUT' | 'NO_CONSENT' | 'NO_DESTINATION'

/**
 * Pode enviar-se uma mensagem promocional a este destinatário? Nunca a quem recusou (consentimento da lead ou lista de
 * exclusão); uma lead sem consentimento expresso também não recebe; uma Party (já cliente ou contacto da empresa) recebe
 * enquanto não estiver na lista de exclusão. Sem destino (email/telefone) para o canal, não há envio.
 */
export function sendDecision(input: {
  leadConsent: ConsentStatus | null
  destination: string | null
  excluded: boolean
}): SendDecision {
  if (input.leadConsent === 'OPT_OUT' || input.excluded) return 'OPTED_OUT'
  if (input.leadConsent !== null && input.leadConsent !== 'OPT_IN') return 'NO_CONSENT'
  if (!input.destination) return 'NO_DESTINATION'
  return 'SEND'
}

/** O destino que o canal usa: email para EMAIL, telefone para os restantes canais directos; EVENT/OTHER não têm destino. */
export const destinationKind = (channel: CampaignChannel): ExclusionKind | null =>
  channel === 'EMAIL' ? 'EMAIL' : channel === 'EVENT' || channel === 'OTHER' ? null : 'PHONE'
