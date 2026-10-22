export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSING' | 'CLOSED'

export interface Tenant {
  id: string
  code: string
  name: string
  status: TenantStatus
  defaultLocale: string
  timezone: string
  version: number
}

export interface TenantDomain {
  id: string
  tenantId: string
  hostname: string
  isPrimary: boolean
  verifiedAt: Date | null
}

/** Ciclo de vida do tenant. `CLOSED` é terminal; um tenant suspenso pode ser reactivado. */
const TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  PROVISIONING: ['ACTIVE'],
  ACTIVE: ['SUSPENDED', 'CLOSING'],
  SUSPENDED: ['ACTIVE', 'CLOSING'],
  CLOSING: ['CLOSED'],
  CLOSED: [],
}

export const TENANT_STATUSES = Object.keys(TRANSITIONS) as TenantStatus[]

export const canTransition = (from: TenantStatus, to: TenantStatus): boolean =>
  TRANSITIONS[from].includes(to)

/** Só um tenant `ACTIVE` serve pedidos de negócio; suspenso/em encerramento/fechado nega por omissão. */
export const isOperational = (status: TenantStatus): boolean => status === 'ACTIVE'

/** Código técnico estável (usado em chaves e prefixos): minúsculas, dígitos e `_`. */
const CODE = /^[a-z0-9_]{2,50}$/
export const isValidTenantCode = (code: string): boolean => CODE.test(code)

/** Hostname DNS em minúsculas (sem esquema, porta, caminho nem curingas). */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

export function isValidHostname(hostname: string): boolean {
  if (hostname.length > 253) return false
  const labels = hostname.split('.')
  return labels.length >= 2 && labels.every((label) => LABEL.test(label))
}
