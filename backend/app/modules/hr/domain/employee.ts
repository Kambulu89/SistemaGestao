/**
 * Ficha do colaborador (7.1). Campo da API (camelCase) → coluna. Os campos pessoais são sensíveis: só os vê e altera
 * quem tem `hr.sensitive` no âmbito do colaborador (ou o próprio, quando a sua membership está ligada à ficha).
 */
export const GENERAL_FIELDS = {
  code: 'code',
  fullName: 'full_name',
  workEmail: 'work_email',
  workPhone: 'work_phone',
  legalEntityId: 'legal_entity_id',
  branchId: 'branch_id',
  departmentId: 'department_id',
  positionId: 'position_id',
  managerId: 'manager_id',
  costCenterId: 'cost_center_id',
  membershipId: 'membership_id',
  hireDate: 'hire_date',
  status: 'status',
} as const

export const SENSITIVE_FIELDS = {
  birthDate: 'birth_date',
  nationality: 'nationality',
  idDocumentType: 'id_document_type',
  idDocumentNumber: 'id_document_number',
  idDocumentExpiry: 'id_document_expiry',
  taxId: 'tax_id',
  socialSecurityNumber: 'social_security_number',
  personalEmail: 'personal_email',
  personalPhone: 'personal_phone',
  addressLine: 'address_line',
  city: 'city',
  province: 'province',
  countryCode: 'country_code',
  emergencyName: 'emergency_name',
  emergencyPhone: 'emergency_phone',
  emergencyRelation: 'emergency_relation',
  educationLevel: 'education_level',
  educationField: 'education_field',
  bankName: 'bank_name',
  bankIban: 'bank_iban',
} as const

export type GeneralField = keyof typeof GENERAL_FIELDS
export type SensitiveField = keyof typeof SENSITIVE_FIELDS
export const SENSITIVE_KEYS = Object.keys(SENSITIVE_FIELDS) as SensitiveField[]
export const DATE_FIELDS = new Set(['hireDate', 'birthDate', 'idDocumentExpiry'])

export const EMPLOYEE_STATUSES = ['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]
/** Mudanças de estado permitidas pela ficha; a cessação (TERMINATED) é feita pelo processo do 7.11. */
export const STATUS_TRANSITIONS: Record<EmployeeStatus, EmployeeStatus[]> = {
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE'],
  TERMINATED: [],
}

export const ID_DOCUMENT_TYPES = ['BI', 'PASSPORT', 'RESIDENCE_CARD', 'OTHER'] as const
export const EDUCATION_LEVELS = [
  'NONE',
  'PRIMARY',
  'SECONDARY',
  'TECHNICAL',
  'BACHELOR',
  'LICENTIATE',
  'MASTER',
  'DOCTORATE',
] as const

export interface FieldIssue {
  path: string
  code: string
  message: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[0-9 ()-]{6,40}$/
const IDENT = /^[A-Za-z0-9./-]{4,30}$/
const ISO_COUNTRY = /^[A-Z]{2}$/

const isDate = (v: unknown) =>
  typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)

/**
 * Normaliza e valida os campos recebidos (só os presentes). Devolve os valores limpos e os problemas; campos
 * desconhecidos são ignorados. `today` serve para recusar datas futuras de nascimento.
 */
export function normalizeEmployee(
  input: Record<string, unknown>,
  today: string,
  validIban: (iban: string) => boolean
) {
  const values: Record<string, unknown> = {}
  const issues: FieldIssue[] = []
  const bad = (path: string, code: string, message: string) => issues.push({ path, code, message })
  const keys = [...Object.keys(GENERAL_FIELDS), ...SENSITIVE_KEYS]
  for (const key of keys) {
    if (!(key in input)) continue
    let v = text(input[key])
    if (v === '') v = null
    values[key] = v
    if (v === null || v === undefined) continue
    if (typeof v !== 'string') {
      bad(key, 'INVALID', 'Valor inválido.')
      continue
    }
    if (DATE_FIELDS.has(key) && !isDate(v)) bad(key, 'INVALID_DATE', 'Data inválida (AAAA-MM-DD).')
    if (key === 'code' && !CODE.test(v))
      bad(key, 'INVALID_CODE', 'Código: letras, números, . _ - (até 30).')
    if (key === 'fullName' && (v.length < 2 || v.length > 160))
      bad(key, 'INVALID', 'Nome entre 2 e 160 caracteres.')
    if ((key === 'workEmail' || key === 'personalEmail') && !EMAIL.test(v))
      bad(key, 'INVALID_EMAIL', 'Email inválido.')
    if (['workPhone', 'personalPhone', 'emergencyPhone'].includes(key) && !PHONE.test(v))
      bad(key, 'INVALID_PHONE', 'Telefone inválido.')
    if (['taxId', 'socialSecurityNumber', 'idDocumentNumber'].includes(key) && !IDENT.test(v))
      bad(key, 'INVALID_IDENTIFIER', 'Identificador inválido (4 a 30 letras, números, . / -).')
    if (key === 'nationality' || key === 'countryCode') {
      values[key] = v.toUpperCase()
      if (!ISO_COUNTRY.test(values[key] as string))
        bad(key, 'INVALID_COUNTRY', 'País em código ISO de 2 letras (ex.: AO).')
    }
    if (key === 'idDocumentType' && !(ID_DOCUMENT_TYPES as readonly string[]).includes(v))
      bad(key, 'INVALID', 'Tipo de documento inválido.')
    if (key === 'educationLevel' && !(EDUCATION_LEVELS as readonly string[]).includes(v))
      bad(key, 'INVALID', 'Nível de escolaridade inválido.')
    if (key === 'bankIban') {
      const iban = v.replace(/\s+/g, '').toUpperCase()
      values[key] = iban
      if (!validIban(iban)) bad(key, 'INVALID_IBAN', 'IBAN inválido.')
    }
    if (key === 'status' && !(EMPLOYEE_STATUSES as readonly string[]).includes(v))
      bad(key, 'INVALID', 'Estado inválido.')
    if (key.endsWith('Id') && key !== 'taxId' && !/^[0-9a-f-]{36}$/i.test(v))
      bad(key, 'INVALID', 'Identificador inválido.')
  }
  if (isDate(values.birthDate) && (values.birthDate as string) > today)
    bad('birthDate', 'FUTURE_DATE', 'A data de nascimento não pode ser futura.')
  return { values, issues }
}

/** Data de nascimento antes da admissão (quando ambas existem). */
export function birthBeforeHire(birthDate: unknown, hireDate: unknown) {
  return !(typeof birthDate === 'string' && typeof hireDate === 'string' && birthDate >= hireDate)
}

/** Diferenças entre dois estados da ficha; os campos sensíveis só dizem que mudaram (sem valores). */
export function employeeChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of [...Object.keys(GENERAL_FIELDS), ...SENSITIVE_KEYS]) {
    if (!(key in after)) continue
    const a = before[key] ?? null
    const b = after[key] ?? null
    if (a === b) continue
    changes[key] = (SENSITIVE_KEYS as string[]).includes(key)
      ? { from: '[RESERVADO]', to: '[RESERVADO]' }
      : { from: a, to: b }
  }
  return changes
}
