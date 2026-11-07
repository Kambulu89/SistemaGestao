import type { ErrorDetail } from '#shared/http/api_error'

/** Campos de cada entidade organizacional e as suas regras (puro: sem base de dados). */
export type OrgKind = 'legalEntities' | 'branches' | 'departments' | 'positions' | 'costCenters'
export type Values = Record<string, unknown>

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export const BRANCH_TYPES = [
  'HEADQUARTERS',
  'BRANCH',
  'OFFICE',
  'STORE',
  'WAREHOUSE',
  'PLANT',
] as const

const isDate = (v: unknown): v is string =>
  typeof v === 'string' &&
  ISO_DATE.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)

interface Field {
  key: string
  required?: boolean
  immutable?: boolean
  check: (value: unknown) => string | null
  normalize?: (value: unknown) => unknown
}

const text =
  (max: number, min = 1) =>
  (v: unknown) =>
    typeof v === 'string' && v.trim().length >= min && v.trim().length <= max
      ? null
      : `Texto de ${min} a ${max} caracteres.`
const optionalText = (max: number) => (v: unknown) =>
  v === null || text(max)(v) === null ? null : `Até ${max} caracteres.`
const uuidOrNull = (v: unknown) =>
  v === null || (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v))
    ? null
    : 'Identificador inválido.'
const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)

const code: Field = {
  key: 'code',
  required: true,
  immutable: true,
  check: (v) =>
    typeof v === 'string' && CODE.test(v.trim())
      ? null
      : 'Código: letras, números, . _ - (até 30).',
  normalize: trim,
}
const status: Field = {
  key: 'status',
  check: (v) => (v === 'ACTIVE' || v === 'INACTIVE' ? null : 'Estado: ACTIVE ou INACTIVE.'),
}
const validFrom: Field = {
  key: 'validFrom',
  check: (v) => (v === null || isDate(v) ? null : 'Data AAAA-MM-DD.'),
}
const validTo: Field = {
  key: 'validTo',
  check: (v) => (v === null || isDate(v) ? null : 'Data AAAA-MM-DD.'),
}
const name: Field = { key: 'name', required: true, check: text(160, 2), normalize: trim }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const optional = (key: string, max: number): Field => ({
  key,
  check: optionalText(max),
  normalize: trim,
})
const email: Field = {
  key: 'email',
  check: (v) =>
    v === null || (typeof v === 'string' && v.length <= 254 && EMAIL.test(v))
      ? null
      : 'Email inválido.',
  normalize: (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
}
const phone: Field = {
  key: 'phone',
  check: (v) =>
    v === null || (typeof v === 'string' && /^[+0-9 ()-]{6,40}$/.test(v))
      ? null
      : 'Telefone: dígitos, espaço, + ( ) -.',
  normalize: trim,
}
const website: Field = {
  key: 'website',
  check: (v) =>
    v === null || (typeof v === 'string' && /^https?:\/\/[^\s]{3,190}$/.test(v))
      ? null
      : 'Endereço web (http/https).',
  normalize: trim,
}
/** Morada estruturada (Angola: província, município, comuna, bairro); texto livre, sem listas oficiais pré-carregadas. */
const ADDRESS: Field[] = [
  optional('addressLine', 200),
  optional('neighbourhood', 120),
  optional('commune', 120),
  optional('municipality', 120),
  optional('province', 120),
  optional('postalCode', 20),
]
const manager: Field = { key: 'managerMembershipId', check: uuidOrNull }
const costCenter: Field = { key: 'costCenterId', check: uuidOrNull }

export const FIELDS: Record<OrgKind, Field[]> = {
  legalEntities: [
    code,
    { key: 'legalName', required: true, check: text(200, 2), normalize: trim },
    { key: 'tradeName', check: optionalText(200), normalize: trim },
    {
      key: 'taxId',
      required: true,
      check: (v) =>
        typeof v === 'string' && /^[A-Za-z0-9./-]{5,30}$/.test(v.trim())
          ? null
          : 'NIF: 5 a 30 caracteres.',
      normalize: upper,
    },
    {
      key: 'countryCode',
      required: true,
      check: (v) =>
        typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? null : 'País ISO 3166-1 alfa-2.',
      normalize: upper,
    },
    {
      key: 'functionalCurrency',
      required: true,
      check: (v) =>
        typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? null : 'Moeda ISO 4217.',
      normalize: upper,
    },
    optional('taxRegime', 60),
    {
      key: 'vatRegistered',
      check: (v) => (typeof v === 'boolean' ? null : 'Sim ou não.'),
    },
    {
      key: 'fiscalYearStartMonth',
      check: (v) =>
        Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12 ? null : 'Mês de 1 a 12.',
    },
    email,
    phone,
    website,
    ...ADDRESS,
    optional('representativeName', 160),
    optional('representativeRole', 120),
    status,
    validFrom,
    validTo,
  ],
  branches: [
    code,
    name,
    { key: 'legalEntityId', required: true, immutable: true, check: uuidOrNull },
    {
      key: 'type',
      check: (v) =>
        BRANCH_TYPES.includes(v as never) ? null : `Tipo: ${BRANCH_TYPES.join(', ')}.`,
    },
    email,
    phone,
    ...ADDRESS,
    manager,
    costCenter,
    status,
    validFrom,
    validTo,
  ],
  departments: [
    code,
    name,
    { key: 'legalEntityId', required: true, immutable: true, check: uuidOrNull },
    { key: 'branchId', check: uuidOrNull },
    { key: 'parentId', check: uuidOrNull },
    manager,
    costCenter,
    status,
    validFrom,
    validTo,
  ],
  positions: [
    code,
    name,
    { key: 'departmentId', check: uuidOrNull },
    { key: 'jobFamily', check: optionalText(80), normalize: trim },
    { key: 'category', check: optionalText(80), normalize: trim },
    {
      key: 'level',
      check: (v) =>
        v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20)
          ? null
          : 'Nível 1 a 20.',
    },
    { key: 'description', check: optionalText(4000), normalize: trim },
    optional('jobFunction', 120),
    optional('requirements', 4000),
    optional('responsibilities', 4000),
    status,
    validFrom,
    validTo,
  ],
  costCenters: [
    code,
    name,
    { key: 'legalEntityId', required: true, immutable: true, check: uuidOrNull },
    { key: 'parentId', check: uuidOrNull },
    { key: 'departmentId', check: uuidOrNull },
    manager,
    status,
    validFrom,
    validTo,
  ],
}

/**
 * Valida a criação (`base` nulo) ou a alteração de uma entidade. Devolve só os campos a gravar. O código e a entidade
 * legal não mudam depois de criados; a vigência tem de ser coerente.
 */
export function normalize(kind: OrgKind, input: Values, base: Values | null) {
  const issues: ErrorDetail[] = []
  const values: Values = {}
  for (const field of FIELDS[kind]) {
    const given = input[field.key]
    if (given === undefined) {
      if (!base && field.required)
        issues.push({ path: field.key, code: 'REQUIRED', message: 'Campo obrigatório.' })
      continue
    }
    if (base && field.immutable) {
      if (given !== base[field.key]) {
        issues.push({
          path: field.key,
          code: 'IMMUTABLE',
          message: 'Não se altera depois de criado.',
        })
      }
      continue
    }
    const value = given === '' ? null : field.normalize ? field.normalize(given) : given
    if (value === null && field.required) {
      issues.push({ path: field.key, code: 'REQUIRED', message: 'Campo obrigatório.' })
      continue
    }
    const problem = field.check(value)
    if (problem) issues.push({ path: field.key, code: 'INVALID', message: problem })
    else values[field.key] = value
  }
  const from = (values.validFrom ?? base?.validFrom ?? null) as string | null
  const to = (values.validTo ?? base?.validTo ?? null) as string | null
  if (from && to && to < from) {
    issues.push({
      path: 'validTo',
      code: 'INVALID_PERIOD',
      message: 'O fim da vigência é anterior ao início.',
    })
  }
  return { values, issues }
}
