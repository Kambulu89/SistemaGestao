import { createHash } from 'node:crypto'
import type { ErrorDetail } from '#shared/http/api_error'

/*
 * Clientes (10.1) — regras puras.
 *
 *  - O cliente é o papel de venda de um terceiro (`business_partners`): a identidade (código, nome, tipo, NIF, país,
 *    contactos) é do terceiro e partilhada com o papel de fornecedor; aqui ficam as condições de venda.
 *  - Estados: activo; bloqueado (com motivo — não recebe documentos novos); inactivo (com motivo).
 *  - Versões: a identidade fiscal e a morada de facturação usadas nos documentos ficam numa versão imutável; muda a
 *    identidade, nasce uma versão nova (as anteriores ficam para os documentos que as usaram).
 */

export const CUSTOMER_STATUSES = ['ACTIVE', 'BLOCKED', 'INACTIVE'] as const
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number]
export const ADDRESS_KINDS = ['BILLING', 'DELIVERY'] as const
export type AddressKind = (typeof ADDRESS_KINDS)[number]

const CURRENCY = /^[A-Z]{3}$/
const COUNTRY = /^[A-Z]{2}$/
const SEGMENT_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const MONEY = /^\d{1,14}(\.\d{1,2})?$/

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const optional = (v: unknown) => {
  const t = text(v)
  return t === '' || t === undefined || t === null ? null : t
}

/** Condições de venda (só os campos enviados; ao criar, a moeda é obrigatória). */
export function normalizeCustomer(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('currency' in input || creating) {
    const c = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
    if (!CURRENCY.test(c))
      issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: código ISO de 3 letras.' })
    else v.currency = c
  }
  if ('paymentTermsDays' in input) {
    const n = Number(input.paymentTermsDays)
    if (!Number.isInteger(n) || n < 0 || n > 365)
      issues.push({ path: 'paymentTermsDays', code: 'INVALID', message: 'Prazo de 0 a 365 dias.' })
    else v.paymentTermsDays = n
  }
  if ('segmentId' in input) v.segmentId = optional(input.segmentId)
  if ('notes' in input) {
    const n = optional(input.notes)
    if (n !== null && (typeof n !== 'string' || n.length > 2000))
      issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 2000 caracteres.' })
    else v.notes = n
  }
  return { v, issues }
}

/** Limite de crédito: valor ≥ 0 com até 2 casas (texto), ou vazio (sem limite). */
export function normalizeCreditLimit(raw: unknown) {
  const t = optional(raw)
  if (t === null) return { value: null as string | null, issues: [] as ErrorDetail[] }
  const s = String(t).replace(',', '.')
  if (!MONEY.test(s))
    return {
      value: null,
      issues: [
        {
          path: 'creditLimit',
          code: 'INVALID',
          message: 'Limite ≥ 0, até 2 casas, em texto (vazio = sem limite).',
        },
      ],
    }
  const [i, f = ''] = s.split('.')
  return { value: `${BigInt(i)}.${(f + '00').slice(0, 2)}`, issues: [] as ErrorDetail[] }
}

export function normalizeAddress(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('kind' in input || creating) {
    if (!(ADDRESS_KINDS as readonly unknown[]).includes(input.kind))
      issues.push({ path: 'kind', code: 'INVALID', message: 'Facturação ou entrega.' })
    else v.kind = input.kind
  }
  const req = (k: string, max: number, label: string) => {
    if (!(k in input) && !creating) return
    const t = text(input[k])
    if (typeof t !== 'string' || t.length < 2 || t.length > max)
      issues.push({ path: k, code: 'LENGTH', message: `${label}: 2 a ${max} caracteres.` })
    else v[k] = t
  }
  req('label', 80, 'Designação')
  req('addressLine', 200, 'Morada')
  for (const [k, max] of [
    ['city', 100],
    ['municipality', 100],
    ['province', 100],
    ['postalCode', 20],
  ] as const)
    if (k in input) {
      const t = optional(input[k])
      if (t !== null && (typeof t !== 'string' || t.length > max))
        issues.push({ path: k, code: 'LENGTH', message: `Até ${max} caracteres.` })
      else v[k] = t
    }
  if ('countryCode' in input || creating) {
    const c = typeof input.countryCode === 'string' ? input.countryCode.trim().toUpperCase() : ''
    if (!COUNTRY.test(c))
      issues.push({
        path: 'countryCode',
        code: 'INVALID',
        message: 'País: código ISO de 2 letras.',
      })
    else v.countryCode = c
  }
  if ('isDefault' in input) v.isDefault = input.isDefault === true
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activa ou inactiva.' })
    else v.status = input.status
  }
  return { v, issues }
}

export function normalizeSegment(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('code' in input || creating) {
    const c = text(input.code)
    if (typeof c !== 'string' || !SEGMENT_CODE.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: até 30 letras, dígitos ou . _ -.',
      })
    else v.code = c.toUpperCase()
  }
  if ('name' in input || creating) {
    const n = text(input.name)
    if (typeof n !== 'string' || n.length < 2 || n.length > 120)
      issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 120 caracteres.' })
    else v.name = n
  }
  if ('description' in input) {
    const d = optional(input.description)
    if (d !== null && (typeof d !== 'string' || d.length > 500))
      issues.push({ path: 'description', code: 'LENGTH', message: 'Até 500 caracteres.' })
    else v.description = d
  }
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  return { v, issues }
}

/** Mudança de estado: bloquear e inactivar exigem motivo. */
export function normalizeStatusChange(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const status = input.status
  if (!(CUSTOMER_STATUSES as readonly unknown[]).includes(status))
    issues.push({ path: 'status', code: 'INVALID', message: 'Activo, bloqueado ou inactivo.' })
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (status !== 'ACTIVE' && (reason.length < 3 || reason.length > 500))
    issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' })
  return { status: status as CustomerStatus, reason: reason || null, issues }
}

/** Dados de uma versão (identidade fiscal e morada de facturação usadas nos documentos). */
export interface CustomerVersionData {
  code: string
  name: string
  partnerType: string
  taxId: string | null
  countryCode: string
  email: string | null
  billingAddress: {
    addressLine: string | null
    city: string | null
    municipality: string | null
    province: string | null
    postalCode: string | null
    countryCode: string
  }
}

/** Impressão digital estável dos dados da versão (mesmos dados → mesma impressão). */
export function versionHash(d: CustomerVersionData) {
  const a = d.billingAddress
  return createHash('sha256')
    .update(
      JSON.stringify([
        d.code,
        d.name,
        d.partnerType,
        d.taxId,
        d.countryCode,
        d.email,
        a.addressLine,
        a.city,
        a.municipality,
        a.province,
        a.postalCode,
        a.countryCode,
      ])
    )
    .digest('hex')
}
