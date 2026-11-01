export const UNIT_TYPES = ['BRANCH', 'DEPARTMENT', 'SECTION', 'TEAM', 'OTHER'] as const
export type UnitType = (typeof UNIT_TYPES)[number]

export interface Organization {
  id: string
  code: string
  legalName: string
  tradeName: string | null
  countryCode: string
  taxId: string | null
  baseCurrency: string
  fiscalYearStartMonth: number
  addressId: string | null
  active: boolean
  version: number
}

export interface OrganizationUnit {
  id: string
  organizationId: string
  parentId: string | null
  code: string
  name: string
  type: UnitType
  managerMembershipId: string | null
  timezone: string | null
  active: boolean
  version: number
}

export interface CostCenter {
  id: string
  organizationId: string
  parentId: string | null
  code: string
  name: string
  responsibleMembershipId: string | null
  active: boolean
  version: number
}

export interface TeamMember {
  id: string
  unitId: string
  membershipId: string
  startsOn: string
  endsOn: string | null
  roleLabel: string | null
}

export interface MembershipScope {
  id: string
  membershipId: string
  organizationId: string
  organizationUnitId: string | null
  includeDescendants: boolean
}

export interface FieldIssue {
  path: string
  code: string
  message: string
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/

export const isValidNodeCode = (code: string): boolean => CODE.test(code)

/** Validação dos campos de uma organização (todos os campos obrigatórios quando `partial` é falso). */
export function organizationIssues(
  input: Partial<
    Pick<
      Organization,
      'code' | 'legalName' | 'countryCode' | 'baseCurrency' | 'fiscalYearStartMonth'
    >
  >,
  partial = false
): FieldIssue[] {
  const issues: FieldIssue[] = []
  const need = (value: unknown) => !partial || value !== undefined
  if (need(input.code) && !isValidNodeCode(input.code ?? '')) {
    issues.push({
      path: 'code',
      code: 'INVALID_CODE',
      message: 'Código inválido (letras, dígitos, _ . -; máx. 40).',
    })
  }
  if (need(input.legalName) && !(input.legalName ?? '').trim()) {
    issues.push({ path: 'legalName', code: 'REQUIRED', message: 'Indique a designação legal.' })
  }
  if (need(input.countryCode) && !/^[A-Z]{2}$/.test(input.countryCode ?? '')) {
    issues.push({
      path: 'countryCode',
      code: 'INVALID_COUNTRY',
      message: 'País ISO 3166-1 alfa-2 em maiúsculas (ex.: AO).',
    })
  }
  if (need(input.baseCurrency) && !/^[A-Z]{3}$/.test(input.baseCurrency ?? '')) {
    issues.push({
      path: 'baseCurrency',
      code: 'INVALID_CURRENCY',
      message: 'Moeda ISO 4217 em maiúsculas (ex.: AOA).',
    })
  }
  const month = input.fiscalYearStartMonth
  if (month !== undefined && !(Number.isInteger(month) && month >= 1 && month <= 12)) {
    issues.push({
      path: 'fiscalYearStartMonth',
      code: 'INVALID_MONTH',
      message: 'Mês entre 1 e 12.',
    })
  }
  return issues
}

/**
 * Árvore genérica (unidades e centros de custo): `parents` mapeia cada id para o seu pai (ou `null`).
 * Devolve a cadeia de antepassados de `id`, do pai imediato para cima. Protege contra dados já corrompidos.
 */
export function ancestorsOf(parents: ReadonlyMap<string, string | null>, id: string): string[] {
  const chain: string[] = []
  const seen = new Set<string>([id])
  let current = parents.get(id) ?? null
  while (current !== null && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = parents.get(current) ?? null
  }
  return chain
}

/** Mover `id` para debaixo de `newParentId` cria um ciclo se for ele próprio ou um seu descendente. */
export function wouldCreateCycle(
  parents: ReadonlyMap<string, string | null>,
  id: string,
  newParentId: string | null
): boolean {
  if (newParentId === null) return false
  return newParentId === id || ancestorsOf(parents, newParentId).includes(id)
}
