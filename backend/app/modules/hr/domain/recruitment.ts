import type { ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'

/** Recrutamento e onboarding (7.2): estados, transições e normalização (sem acesso à base de dados). */

export const REQUISITION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'OPEN',
  'FILLED',
  'CLOSED',
  'CANCELLED',
] as const
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number]

export const APPLICATION_STAGES = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
] as const
export type ApplicationStage = (typeof APPLICATION_STAGES)[number]

/**
 * Mudanças de etapa feitas à mão. `OFFER` entra ao criar uma proposta e `HIRED` só pela contratação; recusar ou
 * desistir encerra a candidatura (e cancela a proposta em curso).
 */
export const STAGE_TRANSITIONS: Record<ApplicationStage, ApplicationStage[]> = {
  APPLIED: ['SCREENING', 'INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  SCREENING: ['INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['SCREENING', 'REJECTED', 'WITHDRAWN'],
  OFFER: ['REJECTED', 'WITHDRAWN'],
  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
}
export const CLOSED_STAGES: ApplicationStage[] = ['HIRED', 'REJECTED', 'WITHDRAWN']

export const OFFER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ACCEPTED',
  'DECLINED',
  'HIRED',
  'CANCELLED',
] as const
export type OfferStatus = (typeof OFFER_STATUSES)[number]

export const INTERVIEW_MODES = ['ONSITE', 'VIDEO', 'PHONE'] as const
export const INTERVIEW_STATUSES = ['SCHEDULED', 'DONE', 'CANCELLED'] as const
export const RECOMMENDATIONS = ['HIRE', 'HOLD', 'REJECT'] as const
export const ONBOARDING_CATEGORIES = [
  'DOCUMENTS',
  'ACCOUNT',
  'ACCESS',
  'EQUIPMENT',
  'OTHER',
] as const
export const ONBOARDING_STATUSES = ['PENDING', 'DONE', 'NOT_APPLICABLE'] as const

const MONEY = /^\d{1,16}(\.\d{1,2})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[0-9 ()-]{6,40}$/

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)

function isDate(v: string) {
  if (!ISO_DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Montante em cêntimos (inteiro exacto) para comparar sem `float`; `null` se não for um montante válido. */
export function cents(raw: unknown): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string' || !MONEY.test(v.trim())) return null
  const [int, frac = ''] = v.trim().split('.')
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'))
}

/** Montante canónico com 2 casas (como o PostgreSQL devolve `numeric(18,2)`). */
export function money(raw: unknown) {
  const c = cents(raw)
  if (c === null) return null
  const s = c.toString().padStart(3, '0')
  return `${s.slice(0, -2)}.${s.slice(-2)}`
}

/** O salário proposto cabe na remuneração autorizada da vaga? */
export function withinRange(salary: string, min: string, max: string) {
  const s = cents(salary)
  const lo = cents(min)
  const hi = cents(max)
  return s !== null && lo !== null && hi !== null && s >= lo && s <= hi
}

type Kind =
  'text' | 'longtext' | 'code' | 'uuid' | 'date' | 'int' | 'money' | 'currency' | 'email' | 'phone'
interface Field {
  kind: Kind
  max?: number
  min?: number
  label: string
}

/**
 * Normaliza os campos presentes em `input` segundo `fields`: aparas, vazio → `null`, montantes com 2 casas, moeda em
 * maiúsculas. Campos ausentes ficam ausentes (alteração parcial).
 */
export function normalizeFields(
  input: Record<string, unknown>,
  fields: Record<string, Field>
): { values: Record<string, unknown>; issues: ErrorDetail[] } {
  const values: Record<string, unknown> = {}
  const issues: ErrorDetail[] = []
  const bad = (path: string, code: string, message: string) => issues.push({ path, code, message })
  for (const [key, f] of Object.entries(fields)) {
    if (!(key in input)) continue
    let v = text(input[key])
    if (v === '' || v === undefined) v = null
    if (v === null) {
      values[key] = null
      continue
    }
    switch (f.kind) {
      case 'text':
      case 'longtext': {
        const max = f.max ?? (f.kind === 'text' ? 160 : 4000)
        if (typeof v !== 'string' || v.length > max || v.length < (f.min ?? 1))
          bad(key, 'LENGTH', `${f.label}: ${f.min ?? 1} a ${max} caracteres.`)
        else values[key] = v
        break
      }
      case 'code':
        if (typeof v !== 'string' || !CODE.test(v))
          bad(key, 'INVALID_CODE', 'Código: até 30 letras, dígitos ou . _ / -.')
        else values[key] = v.toUpperCase()
        break
      case 'uuid':
        if (!isUuid(v)) bad(key, 'INVALID', `${f.label} inválido(a).`)
        else values[key] = v
        break
      case 'date':
        if (typeof v !== 'string' || !isDate(v)) bad(key, 'INVALID_DATE', 'Data inválida.')
        else values[key] = v
        break
      case 'int':
        if (!Number.isInteger(v) || (v as number) < (f.min ?? 0) || (v as number) > (f.max ?? 1e6))
          bad(key, 'INVALID', `${f.label}: inteiro de ${f.min ?? 0} a ${f.max ?? 1e6}.`)
        else values[key] = v
        break
      case 'money': {
        const m = money(v)
        if (m === null) bad(key, 'INVALID_AMOUNT', 'Montante inválido (até 2 casas decimais).')
        else values[key] = m
        break
      }
      case 'currency':
        if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v))
          bad(key, 'INVALID_CURRENCY', 'Moeda ISO de 3 letras.')
        else values[key] = v.toUpperCase()
        break
      case 'email':
        if (typeof v !== 'string' || v.length > 254 || !EMAIL.test(v))
          bad(key, 'INVALID_EMAIL', 'Email inválido.')
        else values[key] = v.toLowerCase()
        break
      case 'phone':
        if (typeof v !== 'string' || !PHONE.test(v)) bad(key, 'INVALID_PHONE', 'Telefone inválido.')
        else values[key] = v
        break
    }
  }
  return { values, issues }
}

export const REQUISITION_FIELDS = {
  code: { kind: 'code', label: 'Código' },
  title: { kind: 'text', min: 3, label: 'Título' },
  legalEntityId: { kind: 'uuid', label: 'Entidade legal' },
  branchId: { kind: 'uuid', label: 'Filial' },
  departmentId: { kind: 'uuid', label: 'Departamento' },
  positionId: { kind: 'uuid', label: 'Cargo' },
  requirements: { kind: 'longtext', label: 'Requisitos' },
  justification: { kind: 'longtext', label: 'Justificação' },
  quantity: { kind: 'int', min: 1, max: 1000, label: 'Quantidade' },
  deadline: { kind: 'date', label: 'Prazo' },
  currency: { kind: 'currency', label: 'Moeda' },
  salaryMin: { kind: 'money', label: 'Remuneração mínima' },
  salaryMax: { kind: 'money', label: 'Remuneração máxima' },
} satisfies Record<string, Field>
export const REQUISITION_REQUIRED = [
  'code',
  'title',
  'legalEntityId',
  'positionId',
  'quantity',
  'currency',
  'salaryMin',
  'salaryMax',
]

export const CANDIDATE_FIELDS = {
  fullName: { kind: 'text', min: 2, label: 'Nome' },
  email: { kind: 'email', label: 'Email' },
  phone: { kind: 'phone', label: 'Telefone' },
  source: { kind: 'text', max: 60, label: 'Origem' },
  notes: { kind: 'longtext', label: 'Notas' },
} satisfies Record<string, Field>

export const INTERVIEW_FIELDS = {
  scheduledAt: { kind: 'text', label: 'Data e hora' },
  durationMinutes: { kind: 'int', min: 5, max: 480, label: 'Duração (min)' },
  location: { kind: 'text', max: 200, label: 'Local' },
  interviewerMembershipId: { kind: 'uuid', label: 'Entrevistador' },
} satisfies Record<string, Field>

export const OFFER_FIELDS = {
  salary: { kind: 'money', label: 'Salário' },
  startDate: { kind: 'date', label: 'Início' },
  expiresOn: { kind: 'date', label: 'Validade' },
  conditions: { kind: 'longtext', label: 'Condições' },
} satisfies Record<string, Field>

export const ONBOARDING_FIELDS = {
  title: { kind: 'text', min: 2, label: 'Tarefa' },
  dueDate: { kind: 'date', label: 'Prazo' },
  assigneeMembershipId: { kind: 'uuid', label: 'Responsável' },
  notes: { kind: 'longtext', max: 2000, label: 'Notas' },
} satisfies Record<string, Field>

/** Regras entre campos da vaga (depois de juntar o registo actual com a alteração). */
export function requisitionIssues(v: Record<string, unknown>, today: string): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  const lo = cents(v.salaryMin)
  const hi = cents(v.salaryMax)
  if (lo !== null && hi !== null && lo > hi)
    issues.push({
      path: 'salaryMax',
      code: 'RANGE',
      message: 'A remuneração máxima não pode ser inferior à mínima.',
    })
  if (typeof v.deadline === 'string' && v.deadline < today)
    issues.push({ path: 'deadline', code: 'PAST_DATE', message: 'O prazo já passou.' })
  return issues
}

/** Data e hora ISO 8601 com fuso (ex.: 2026-11-20T10:00:00Z ou +01:00). */
export function parseInstant(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
    return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Postos ainda por preencher (as contratações nunca passam a quantidade autorizada). */
export function remainingPositions(quantity: number, hired: number) {
  return Math.max(0, quantity - hired)
}
