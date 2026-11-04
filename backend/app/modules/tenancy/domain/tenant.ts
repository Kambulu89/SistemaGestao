import type { ErrorDetail } from '#shared/http/api_error'

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'
export const TENANT_STATUSES: readonly TenantStatus[] = ['ACTIVE', 'SUSPENDED', 'ARCHIVED']

export interface Tenant {
  id: string
  code: string
  name: string
  slug: string
  status: TenantStatus
  countryCode: string
  defaultCurrency: string
  locale: string
  timezone: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface TenantInput {
  code?: unknown
  name?: unknown
  slug?: unknown
  countryCode?: unknown
  defaultCurrency?: unknown
  locale?: unknown
  timezone?: unknown
}

export type TenantValues = Pick<
  Tenant,
  'code' | 'name' | 'slug' | 'countryCode' | 'defaultCurrency' | 'locale' | 'timezone'
>

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/
const SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/

const isTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** Valida e normaliza um tenant; `base` existe numa alteração (o código e o slug não mudam). */
export function normalizeTenant(
  input: TenantInput,
  base: TenantValues | null
): { values: TenantValues | null; issues: ErrorDetail[] } {
  const issues: ErrorDetail[] = []
  const pick = (key: keyof TenantInput) => (input[key] === undefined ? base?.[key] : input[key])
  if (base) {
    for (const key of ['code', 'slug'] as const) {
      if (input[key] !== undefined && input[key] !== base[key]) {
        issues.push({ path: key, code: 'IMMUTABLE', message: 'Não se altera depois de criado.' })
      }
    }
  }
  const code = String(pick('code') ?? '')
    .trim()
    .toUpperCase()
  if (!CODE.test(code)) {
    issues.push({
      path: 'code',
      code: 'INVALID_CODE',
      message: 'Código: 2 a 30 letras maiúsculas, números, _ ou -.',
    })
  }
  const name = String(pick('name') ?? '').trim()
  if (name.length < 2 || name.length > 160) {
    issues.push({ path: 'name', code: 'INVALID_NAME', message: 'Nome: 2 a 160 caracteres.' })
  }
  const slug = String(pick('slug') ?? code.toLowerCase().replaceAll('_', '-')).trim()
  if (!SLUG.test(slug)) {
    issues.push({
      path: 'slug',
      code: 'INVALID_SLUG',
      message: 'Slug: minúsculas, números e hífens.',
    })
  }
  const countryCode = String(pick('countryCode') ?? '')
    .trim()
    .toUpperCase()
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    issues.push({
      path: 'countryCode',
      code: 'INVALID_COUNTRY',
      message: 'País ISO 3166-1 alfa-2 (ex.: AO).',
    })
  }
  const defaultCurrency = String(pick('defaultCurrency') ?? '')
    .trim()
    .toUpperCase()
  if (!/^[A-Z]{3}$/.test(defaultCurrency)) {
    issues.push({
      path: 'defaultCurrency',
      code: 'INVALID_CURRENCY',
      message: 'Moeda ISO 4217 (ex.: AOA).',
    })
  }
  const locale = String(pick('locale') ?? 'pt-AO').trim()
  if (!LOCALE.test(locale)) {
    issues.push({ path: 'locale', code: 'INVALID_LOCALE', message: 'Idioma: ex. pt-AO.' })
  }
  const timezone = String(pick('timezone') ?? 'Africa/Luanda').trim()
  if (!isTimezone(timezone)) {
    issues.push({
      path: 'timezone',
      code: 'INVALID_TIMEZONE',
      message: 'Fuso horário IANA (ex.: Africa/Luanda).',
    })
  }
  if (issues.length > 0) return { values: null, issues }
  return { values: { code, name, slug, countryCode, defaultCurrency, locale, timezone }, issues }
}
