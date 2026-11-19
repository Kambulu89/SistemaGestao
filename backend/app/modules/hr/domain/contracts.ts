import type { ErrorDetail } from '#shared/http/api_error'
import { cents } from '#modules/hr/domain/recruitment'

/** Contratos e carreira (7.3): tipos, estados, condições numa data e regras entre campos (sem base de dados). */

export const CONTRACT_TYPES = ['PERMANENT', 'FIXED_TERM', 'UNCERTAIN_TERM'] as const
export type ContractType = (typeof CONTRACT_TYPES)[number]
export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'ENDED', 'CANCELLED'] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]
export const ASSIGNMENT_KINDS = ['TRANSFER', 'PROMOTION', 'CHANGE'] as const
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number] | 'HIRE'

/** Campos da colocação que só mudam por movimento de carreira (com histórico). */
export const PLACEMENT_KEYS = [
  'branchId',
  'departmentId',
  'positionId',
  'managerId',
  'costCenterId',
] as const

export const CONTRACT_FIELDS = {
  code: { kind: 'code', label: 'Número' },
  contractType: { kind: 'text', max: 20, label: 'Tipo' },
  startDate: { kind: 'date', label: 'Início' },
  endDate: { kind: 'date', label: 'Termo' },
  probationEndDate: { kind: 'date', label: 'Fim do período experimental' },
  weeklyHours: { kind: 'money', label: 'Horas semanais' },
  workSchedule: { kind: 'text', max: 200, label: 'Horário' },
  currency: { kind: 'currency', label: 'Moeda' },
  baseSalary: { kind: 'money', label: 'Remuneração base' },
  notes: { kind: 'longtext', max: 2000, label: 'Notas' },
} as const
export const CONTRACT_REQUIRED = [
  'code',
  'contractType',
  'startDate',
  'weeklyHours',
  'currency',
  'baseSalary',
]

/** Condições negociáveis do contrato (o que as adendas podem mudar). */
export interface Terms {
  baseSalary: string
  weeklyHours: string
  workSchedule: string | null
  endDate: string | null
}

export interface Amendment {
  sequence: number
  effectiveDate: string
  baseSalary: string | null
  weeklyHours: string | null
  workSchedule: string | null
  endDate: string | null
}

/**
 * Condições em vigor numa data: as do contrato com as adendas com efeito até essa data aplicadas por ordem (data de
 * efeito e depois sequência). É a base para o processamento salarial calcular com as condições de cada período.
 */
export function termsAt(base: Terms, amendments: Amendment[], date: string): Terms {
  const applicable = amendments
    .filter((a) => a.effectiveDate <= date)
    .sort((a, b) =>
      a.effectiveDate === b.effectiveDate
        ? a.sequence - b.sequence
        : a.effectiveDate < b.effectiveDate
          ? -1
          : 1
    )
  const out = { ...base }
  for (const a of applicable) {
    if (a.baseSalary !== null) out.baseSalary = a.baseSalary
    if (a.weeklyHours !== null) out.weeklyHours = a.weeklyHours
    if (a.workSchedule !== null) out.workSchedule = a.workSchedule
    if (a.endDate !== null) out.endDate = a.endDate
  }
  return out
}

/** Regras entre campos do contrato (depois de juntar o registo actual com a alteração). */
export function contractIssues(v: Record<string, unknown>): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  if (v.contractType !== undefined && !CONTRACT_TYPES.includes(v.contractType as ContractType))
    issues.push({ path: 'contractType', code: 'INVALID', message: 'Tipo de contrato inválido.' })
  const start = v.startDate as string | null | undefined
  const end = v.endDate as string | null | undefined
  const probation = v.probationEndDate as string | null | undefined
  if (v.contractType === 'FIXED_TERM' && !end)
    issues.push({
      path: 'endDate',
      code: 'REQUIRED',
      message: 'Um contrato a termo certo tem termo.',
    })
  if (start && end && end < start)
    issues.push({ path: 'endDate', code: 'BEFORE_START', message: 'O termo é anterior ao início.' })
  if (start && probation && probation < start)
    issues.push({
      path: 'probationEndDate',
      code: 'BEFORE_START',
      message: 'O período experimental termina antes do início.',
    })
  if (end && probation && probation > end)
    issues.push({
      path: 'probationEndDate',
      code: 'AFTER_END',
      message: 'O período experimental não pode passar do termo.',
    })
  issues.push(...hoursIssues(v.weeklyHours))
  return issues
}

export function hoursIssues(raw: unknown): ErrorDetail[] {
  if (raw === undefined || raw === null) return []
  const c = cents(raw)
  if (c === null || c <= 0n || c > 16800n)
    return [
      {
        path: 'weeklyHours',
        code: 'INVALID',
        message: 'Horas semanais entre 0 e 168 (até 2 casas decimais).',
      },
    ]
  return []
}

/** Transições de estado por acção (a activação e o fim têm regras próprias no serviço). */
export const CONTRACT_ACTIONS: Record<string, { from: ContractStatus[]; to: ContractStatus }> = {
  activate: { from: ['DRAFT'], to: 'ACTIVE' },
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED' },
  resume: { from: ['SUSPENDED'], to: 'ACTIVE' },
  terminate: { from: ['ACTIVE', 'SUSPENDED'], to: 'ENDED' },
  cancel: { from: ['DRAFT'], to: 'CANCELLED' },
}

/** Dia anterior (AAAA-MM-DD), para fechar o período corrente na véspera do movimento. */
export function previousDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Contrato a termo já passado o termo e ainda em vigor: renovar ou terminar. */
export function termExceeded(
  status: ContractStatus,
  endDate: string | null,
  today: string
): boolean {
  return (status === 'ACTIVE' || status === 'SUSPENDED') && !!endDate && endDate < today
}
