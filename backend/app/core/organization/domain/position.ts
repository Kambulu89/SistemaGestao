/**
 * Cargo (função) da estrutura organizacional. Não é uma pessoa: existe sem ocupante e pode ser ocupado por vários
 * colaboradores (o módulo de RH liga-lhe os contratos). Tem departamento por omissão, cargo superior e descrição funcional.
 */
export const POSITION_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type PositionStatus = (typeof POSITION_STATUSES)[number]

export interface Position {
  id: string
  code: string
  name: string
  description: string | null
  jobFamily: string | null
  category: string | null
  hierarchyLevel: number | null
  departmentId: string | null
  parentId: string | null
  responsibilities: string | null
  competencies: string[]
  academicRequirements: string | null
  recommendedExperience: string | null
  status: PositionStatus
  version: number
  createdAt: Date
  updatedAt: Date
}

export type PositionValues = Omit<Position, 'id' | 'version' | 'createdAt' | 'updatedAt'>

export interface PositionIssue {
  path: string
  code: string
  message: string
}

const CODE = /^[A-Za-z0-9._-]{1,40}$/
const MAX_COMPETENCIES = 50

const clean = (value: unknown, max: number): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? text.slice(0, max) : null
}

/**
 * Normaliza e valida os campos de um cargo. Em `partial` só valida o que vier; o código é imutável depois de criado
 * (os outros módulos e documentos referem-no).
 */
export function normalizePosition(
  input: Record<string, unknown>,
  partial: boolean,
  issues: PositionIssue[]
): Partial<PositionValues> {
  const values: Partial<PositionValues> = {}
  if (!partial) {
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    if (!CODE.test(code)) {
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'O código usa 1–40 caracteres: letras, algarismos, ponto, hífen ou _.',
      })
    }
    values.code = code
  }
  if (!partial || input.name !== undefined) {
    const name = clean(input.name, 160)
    if (!name) issues.push({ path: 'name', code: 'REQUIRED', message: 'Indique a designação.' })
    values.name = name ?? ''
  }
  const texts: [keyof PositionValues, string, number][] = [
    ['description', 'description', 4000],
    ['jobFamily', 'jobFamily', 80],
    ['category', 'category', 80],
    ['responsibilities', 'responsibilities', 4000],
    ['academicRequirements', 'academicRequirements', 1000],
    ['recommendedExperience', 'recommendedExperience', 200],
  ]
  for (const [key, field, max] of texts) {
    if (!partial || input[field] !== undefined)
      (values as Record<string, unknown>)[key] = clean(input[field], max)
  }
  if (!partial || input.hierarchyLevel !== undefined) {
    const level = input.hierarchyLevel
    if (level === null || level === undefined) values.hierarchyLevel = null
    else if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 20) {
      issues.push({
        path: 'hierarchyLevel',
        code: 'INVALID_LEVEL',
        message: 'O nível hierárquico é um inteiro de 1 a 20.',
      })
    } else values.hierarchyLevel = level as number
  }
  for (const key of ['departmentId', 'parentId'] as const) {
    if (!partial || input[key] !== undefined) {
      values[key] = typeof input[key] === 'string' && input[key] ? (input[key] as string) : null
    }
  }
  if (!partial || input.competencies !== undefined) {
    const list = Array.isArray(input.competencies) ? input.competencies : []
    const competencies = [
      ...new Set(list.map((c) => clean(c, 120)).filter((c): c is string => c !== null)),
    ]
    if (competencies.length > MAX_COMPETENCIES) {
      issues.push({
        path: 'competencies',
        code: 'TOO_MANY',
        message: `No máximo ${MAX_COMPETENCIES} competências.`,
      })
    }
    values.competencies = competencies
  }
  if (!partial || input.status !== undefined) {
    const status = input.status ?? 'ACTIVE'
    if (!POSITION_STATUSES.includes(status as PositionStatus)) {
      issues.push({ path: 'status', code: 'INVALID_STATUS', message: 'Estado inválido.' })
    }
    values.status = status as PositionStatus
  }
  return values
}
