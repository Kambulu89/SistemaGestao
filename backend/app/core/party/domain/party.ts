export type PartyKind = 'PERSON' | 'ORGANIZATION'
export type PartyStatus = 'ACTIVE' | 'INACTIVE'
export type ContactType = 'EMAIL' | 'PHONE' | 'WEBSITE'
export type AddressType = 'BILLING' | 'DELIVERY' | 'OTHER'

export interface Party {
  id: string
  kind: PartyKind
  displayName: string
  status: PartyStatus
  externalReference: string | null
  version: number
}

export interface Person {
  id: string
  givenNames: string
  familyName: string
  birthDate: string | null
  nationality: string | null
  identityType: string | null
  identityNumber: string | null
}

export interface OrganizationParty {
  id: string
  legalName: string
  taxCountry: string | null
  taxId: string | null
  registrationNumber: string | null
}

export interface Contact {
  id: string
  partyId: string
  type: ContactType
  value: string
  label: string | null
  isPrimary: boolean
  verifiedAt: Date | null
  version: number
}

export interface Address {
  id: string
  partyId: string
  type: AddressType
  line1: string
  line2: string | null
  city: string
  province: string | null
  countryCode: string
  postalCode: string | null
  isPrimary: boolean
  version: number
}

export interface PartyRelationship {
  id: string
  sourcePartyId: string
  targetPartyId: string
  relationshipType: string
  startsOn: string | null
  endsOn: string | null
}

export interface FieldIssue {
  path: string
  code: string
  message: string
}

/** Nomes dos campos sensíveis na API: alvo das regras de campo (C06) e da ocultação. */
export const SENSITIVE_PERSON_FIELDS = [
  'birthDate',
  'nationality',
  'identityType',
  'identityNumber',
] as const

const alnum = (value: string) =>
  value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

/** Chave de duplicados por identificação pessoal (tipo + número, sem pontuação nem maiúsculas). */
export function identityKey(type: string | null, number: string | null): string | null {
  const t = type ? alnum(type) : ''
  const n = number ? alnum(number) : ''
  return t && n ? `${t}:${n}` : null
}

/** Chave de duplicados por identificação fiscal (país + NIF normalizado). */
export function taxKey(country: string | null, taxId: string | null): string | null {
  const n = taxId ? alnum(taxId) : ''
  return country && n ? `${country}:${n}` : null
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

/** Valor normalizado de um contacto para comparação (nunca se mostra; o valor original é o que se guarda). */
export function contactKey(type: ContactType, value: string): string {
  const v = value.normalize('NFKC').trim()
  if (type === 'EMAIL') return v.toLowerCase()
  if (type === 'PHONE') {
    const digits = v.replace(/\D/g, '')
    return v.startsWith('+') ? `+${digits}` : digits
  }
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return v.toLowerCase()
  }
}

export function contactIssues(type: ContactType, value: string): FieldIssue[] {
  const v = value.trim()
  const bad = (message: string): FieldIssue[] => [
    { path: 'value', code: 'INVALID_CONTACT', message },
  ]
  if (!v || v.length > 254) return bad('Valor em falta ou demasiado longo.')
  if (type === 'EMAIL') return EMAIL.test(v) ? [] : bad('Email inválido.')
  if (type === 'PHONE') {
    const digits = v.replace(/\D/g, '')
    const shape = /^\+?[\d\s().-]+$/.test(v)
    return shape && digits.length >= 6 && digits.length <= 15
      ? []
      : bad('Telefone inválido (6 a 15 dígitos).')
  }
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
    return url.hostname.includes('.') ? [] : bad('Endereço web inválido.')
  } catch {
    return bad('Endereço web inválido.')
  }
}

const COUNTRY = /^[A-Z]{2}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
}

export function personIssues(
  input: Partial<Pick<Person, 'givenNames' | 'familyName' | 'birthDate' | 'nationality'>> & {
    identityType?: string | null
    identityNumber?: string | null
  },
  today: string,
  partial = false
): FieldIssue[] {
  const issues: FieldIssue[] = []
  const need = (v: unknown) => !partial || v !== undefined
  if (need(input.givenNames) && !(input.givenNames ?? '').trim()) {
    issues.push({
      path: 'givenNames',
      code: 'REQUIRED',
      message: 'Indique o(s) nome(s) próprio(s).',
    })
  }
  if (need(input.familyName) && !(input.familyName ?? '').trim()) {
    issues.push({ path: 'familyName', code: 'REQUIRED', message: 'Indique o apelido.' })
  }
  if (input.birthDate) {
    if (!isIsoDate(input.birthDate)) {
      issues.push({
        path: 'birthDate',
        code: 'INVALID_DATE',
        message: 'Data inválida (AAAA-MM-DD).',
      })
    } else if (input.birthDate > today) {
      issues.push({
        path: 'birthDate',
        code: 'FUTURE_DATE',
        message: 'A data de nascimento não pode ser futura.',
      })
    }
  }
  if (input.nationality && !COUNTRY.test(input.nationality)) {
    issues.push({
      path: 'nationality',
      code: 'INVALID_COUNTRY',
      message: 'País ISO alfa-2 em maiúsculas.',
    })
  }
  const hasType = !!input.identityType?.trim()
  const hasNumber = !!input.identityNumber?.trim()
  if (
    hasType !== hasNumber &&
    (!partial || input.identityType !== undefined || input.identityNumber !== undefined)
  ) {
    issues.push({
      path: hasType ? 'identityNumber' : 'identityType',
      code: 'INCOMPLETE_IDENTITY',
      message: 'Indique o tipo e o número do documento, ou nenhum.',
    })
  }
  return issues
}

export function organizationIssues(
  input: Partial<Pick<OrganizationParty, 'legalName' | 'taxCountry' | 'taxId'>>,
  partial = false
): FieldIssue[] {
  const issues: FieldIssue[] = []
  if ((!partial || input.legalName !== undefined) && !(input.legalName ?? '').trim()) {
    issues.push({ path: 'legalName', code: 'REQUIRED', message: 'Indique a designação legal.' })
  }
  if (input.taxCountry && !COUNTRY.test(input.taxCountry)) {
    issues.push({
      path: 'taxCountry',
      code: 'INVALID_COUNTRY',
      message: 'País ISO alfa-2 em maiúsculas.',
    })
  }
  if (!!input.taxId?.trim() && !input.taxCountry) {
    issues.push({
      path: 'taxCountry',
      code: 'REQUIRED',
      message: 'Indique o país da identificação fiscal.',
    })
  }
  return issues
}

export function addressIssues(
  input: Partial<Pick<Address, 'line1' | 'city' | 'countryCode'>>,
  partial = false
): FieldIssue[] {
  const issues: FieldIssue[] = []
  const need = (v: unknown) => !partial || v !== undefined
  if (need(input.line1) && !(input.line1 ?? '').trim()) {
    issues.push({ path: 'line1', code: 'REQUIRED', message: 'Indique a morada.' })
  }
  if (need(input.city) && !(input.city ?? '').trim()) {
    issues.push({ path: 'city', code: 'REQUIRED', message: 'Indique a localidade.' })
  }
  if (need(input.countryCode) && !COUNTRY.test(input.countryCode ?? '')) {
    issues.push({
      path: 'countryCode',
      code: 'INVALID_COUNTRY',
      message: 'País ISO alfa-2 em maiúsculas.',
    })
  }
  return issues
}

export const displayNameOf = (givenNames: string, familyName: string): string =>
  `${givenNames.trim()} ${familyName.trim()}`.trim()

/** Resultado do aviso de duplicados: nunca bloqueia nem funde. */
export interface PossibleDuplicate {
  partyId: string
  displayName: string
  reasons: ('IDENTITY' | 'TAX_ID' | 'CONTACT')[]
}
