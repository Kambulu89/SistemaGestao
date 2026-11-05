import type { ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'

export const ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN'] as const

export interface TenantSettings {
  amountScale: number
  quantityScale: number
  priceScale: number
  roundingMode: (typeof ROUNDING_MODES)[number]
  invitationTtlDays: number
  notifyApprovalPending: boolean
  notifyApprovalDecided: boolean
  bankAccountWorkflowId: string | null
  version: number
}

/** Valores por omissão (até a empresa gravar as suas configurações). */
export const DEFAULT_SETTINGS: TenantSettings = {
  amountScale: 2,
  quantityScale: 3,
  priceScale: 4,
  roundingMode: 'HALF_UP',
  invitationTtlDays: 7,
  notifyApprovalPending: true,
  notifyApprovalDecided: true,
  bankAccountWorkflowId: null,
  version: 0,
}

const int = (v: unknown, min: number, max: number) =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max

export function normalizeSettings(input: Record<string, unknown>, base: TenantSettings) {
  const issues: ErrorDetail[] = []
  const out = { ...base }
  const set = <K extends keyof TenantSettings>(key: K, ok: boolean, message: string) => {
    if (input[key] === undefined) return
    if (!ok) issues.push({ path: key, code: 'INVALID', message })
    else out[key] = input[key] as TenantSettings[K]
  }
  set('amountScale', int(input.amountScale, 0, 6), 'Casas decimais de 0 a 6.')
  set('quantityScale', int(input.quantityScale, 0, 6), 'Casas decimais de 0 a 6.')
  set('priceScale', int(input.priceScale, 0, 8), 'Casas decimais de 0 a 8.')
  set(
    'roundingMode',
    ROUNDING_MODES.includes(input.roundingMode as never),
    `Arredondamento: ${ROUNDING_MODES.join(', ')}.`
  )
  set('invitationTtlDays', int(input.invitationTtlDays, 1, 30), 'Validade de 1 a 30 dias.')
  set('notifyApprovalPending', typeof input.notifyApprovalPending === 'boolean', 'Sim ou não.')
  set('notifyApprovalDecided', typeof input.notifyApprovalDecided === 'boolean', 'Sim ou não.')
  set(
    'bankAccountWorkflowId',
    input.bankAccountWorkflowId === null || isUuid(input.bankAccountWorkflowId),
    'Workflow inválido.'
  )
  return { values: out, issues }
}

export const CURRENCY = /^[A-Z]{3}$/
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export const DOCUMENT_TYPE = /^[A-Z][A-Z0-9_]{1,39}$/

/** Taxa decimal positiva como texto (nunca float): até 14 dígitos inteiros e 10 decimais. */
export function normalizeRate(raw: unknown): string | null {
  const text =
    typeof raw === 'number'
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim().replace(',', '.')
        : ''
  const m = /^(\d{1,14})(?:\.(\d{1,10}))?$/.exec(text)
  if (!m) return null
  const value = `${m[1].replace(/^0+(?=\d)/, '')}${m[2] ? '.' + m[2] : ''}`
  return /^0(\.0*)?$/.test(value) ? null : value
}

/** Número de documento formatado: prefixo + número com zeros à esquerda (ex.: FT2026/000123). */
export function formatDocumentNumber(prefix: string, number: number, padding: number) {
  return `${prefix}${String(number).padStart(padding, '0')}`
}
