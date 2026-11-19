import type { ErrorDetail } from '#shared/http/api_error'

/*
 * Terceiro (business partner): a identidade única de quem a empresa compra ou vende — pessoa colectiva ou singular,
 * NIF, país, contactos e morada. Os papéis (fornecedor, cliente) vivem nos módulos de negócio e apontam para aqui, por
 * isso o mesmo terceiro pode ser fornecedor e cliente sem duplicar a ficha.
 *
 * O NIF valida-se só no formato (letras, dígitos e hífen, 5 a 30): as regras de cada país não são verificadas aqui.
 */

export const PARTNER_TYPES = ['ORGANIZATION', 'INDIVIDUAL'] as const
export type PartnerType = (typeof PARTNER_TYPES)[number]

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const TAX_ID = /^[A-Za-z0-9][A-Za-z0-9-]{4,29}$/
const COUNTRY = /^[A-Z]{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const optional = (v: unknown) => {
  const t = text(v)
  return t === '' || t === undefined ? null : t
}

/** Campos da ficha do terceiro (camelCase → coluna). */
export const PARTNER_COLUMNS: Record<string, string> = {
  code: 'code',
  name: 'name',
  partnerType: 'partner_type',
  taxId: 'tax_id',
  countryCode: 'country_code',
  email: 'email',
  phone: 'phone',
  website: 'website',
  addressLine: 'address_line',
  city: 'city',
  province: 'province',
  postalCode: 'postal_code',
  status: 'status',
}

const LIMITS: Record<string, number> = {
  phone: 40,
  website: 200,
  addressLine: 200,
  city: 100,
  province: 100,
  postalCode: 20,
}

/**
 * Valida os campos enviados (ao criar, código, nome, tipo e país são obrigatórios). Devolve só o que veio, já
 * normalizado (código e NIF em maiúsculas, país em maiúsculas).
 */
export function normalizePartner(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  const has = (k: string) => k in input || creating
  if (has('code')) {
    const c = text(input.code)
    if (typeof c !== 'string' || !CODE.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: até 30 letras, dígitos ou . _ -.',
      })
    else v.code = c.toUpperCase()
  }
  if (has('name')) {
    const n = text(input.name)
    if (typeof n !== 'string' || n.length < 2 || n.length > 200)
      issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 200 caracteres.' })
    else v.name = n
  }
  if (has('partnerType')) {
    if (!PARTNER_TYPES.includes(input.partnerType as PartnerType))
      issues.push({
        path: 'partnerType',
        code: 'INVALID',
        message: 'Pessoa colectiva ou singular.',
      })
    else v.partnerType = input.partnerType
  }
  if (has('countryCode')) {
    const c = typeof input.countryCode === 'string' ? input.countryCode.trim().toUpperCase() : ''
    if (!COUNTRY.test(c))
      issues.push({
        path: 'countryCode',
        code: 'INVALID',
        message: 'País: código ISO de 2 letras.',
      })
    else v.countryCode = c
  }
  if ('taxId' in input) {
    const t = optional(input.taxId)
    if (t !== null && (typeof t !== 'string' || !TAX_ID.test(t)))
      issues.push({
        path: 'taxId',
        code: 'INVALID',
        message: 'NIF: 5 a 30 letras, dígitos ou hífen.',
      })
    else v.taxId = t === null ? null : (t as string).toUpperCase()
  }
  if ('email' in input) {
    const e = optional(input.email)
    if (e !== null && (typeof e !== 'string' || e.length > 160 || !EMAIL.test(e)))
      issues.push({ path: 'email', code: 'INVALID', message: 'Correio electrónico inválido.' })
    else v.email = e === null ? null : (e as string).toLowerCase()
  }
  for (const [k, max] of Object.entries(LIMITS))
    if (k in input) {
      const t = optional(input[k])
      if (t !== null && (typeof t !== 'string' || t.length > max))
        issues.push({ path: k, code: 'LENGTH', message: `Até ${max} caracteres.` })
      else v[k] = t
    }
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  return { v, issues }
}

export function normalizeContact(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('name' in input || creating) {
    const n = text(input.name)
    if (typeof n !== 'string' || n.length < 2 || n.length > 160)
      issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 160 caracteres.' })
    else v.name = n
  }
  if ('role' in input) {
    const r = optional(input.role)
    if (r !== null && (typeof r !== 'string' || r.length > 100))
      issues.push({ path: 'role', code: 'LENGTH', message: 'Até 100 caracteres.' })
    else v.role = r
  }
  if ('email' in input) {
    const e = optional(input.email)
    if (e !== null && (typeof e !== 'string' || e.length > 160 || !EMAIL.test(e)))
      issues.push({ path: 'email', code: 'INVALID', message: 'Correio electrónico inválido.' })
    else v.email = e === null ? null : (e as string).toLowerCase()
  }
  if ('phone' in input) {
    const p = optional(input.phone)
    if (p !== null && (typeof p !== 'string' || p.length > 40))
      issues.push({ path: 'phone', code: 'LENGTH', message: 'Até 40 caracteres.' })
    else v.phone = p
  }
  if ('isPrimary' in input) v.isPrimary = input.isPrimary === true
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  if (
    creating &&
    !v.email &&
    !v.phone &&
    !issues.some((i) => i.path === 'email' || i.path === 'phone')
  )
    issues.push({ path: 'email', code: 'REQUIRED', message: 'Indique um e-mail ou telefone.' })
  return { v, issues }
}
