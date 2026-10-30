import type {
  FieldPresentation,
  FieldSpec,
  FieldType,
  Issue,
} from '#dynamic/metadata/domain/field_types'

/** Apresentação da entidade: nome no plural e ícone (o nome singular é o `name`). */
export interface EntityPresentation {
  pluralName?: string
  icon?: string
}

/** Tipos que a listagem sabe ordenar e filtrar (por valor exacto) e pesquisar por texto. */
const ORDERABLE: readonly FieldType[] = [
  'TEXT',
  'NUMBER',
  'DECIMAL',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'EMAIL',
  'PHONE',
  'URL',
  'SELECT',
  'RADIO',
]
const SORTABLE_TYPES: readonly FieldType[] = [...ORDERABLE, 'FORMULA']
const FILTERABLE_TYPES: readonly FieldType[] = [...ORDERABLE, 'FORMULA', 'USER_REFERENCE']
const SEARCHABLE_TYPES: readonly FieldType[] = [
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'URL',
  'SELECT',
  'RADIO',
]

const ICON = /^[a-z][a-z0-9-]{0,39}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownKeys(
  raw: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: Issue[]
) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        code: 'UNKNOWN_PRESENTATION',
        message: `"${key}" não existe.`,
      })
    }
  }
}

export function normalizeEntityPresentation(raw: unknown, issues: Issue[], path = 'presentation') {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    issues.push({
      path,
      code: 'INVALID_PRESENTATION',
      message: 'presentation tem de ser um objecto.',
    })
    return {}
  }
  unknownKeys(raw, ['pluralName', 'icon'], path, issues)
  const result: EntityPresentation = {}
  if (raw.pluralName !== undefined) {
    if (
      typeof raw.pluralName !== 'string' ||
      !raw.pluralName.trim() ||
      raw.pluralName.length > 160
    ) {
      issues.push({
        path: `${path}.pluralName`,
        code: 'INVALID_NAME',
        message: 'Nome no plural: 1 a 160 caracteres.',
      })
    } else result.pluralName = raw.pluralName.trim()
  }
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string' || !ICON.test(raw.icon)) {
      issues.push({
        path: `${path}.icon`,
        code: 'INVALID_ICON',
        message: 'Ícone: a-z, 0-9 e - (até 40).',
      })
    } else result.icon = raw.icon
  }
  return result
}

export function normalizeFieldPresentation(
  raw: unknown,
  type: FieldType,
  sensitive: boolean,
  issues: Issue[],
  path: string
): FieldPresentation {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    issues.push({
      path,
      code: 'INVALID_PRESENTATION',
      message: 'presentation tem de ser um objecto.',
    })
    return {}
  }
  unknownKeys(
    raw,
    ['description', 'placeholder', 'searchable', 'filterable', 'sortable'],
    path,
    issues
  )
  const result: FieldPresentation = {}
  for (const [key, max] of [
    ['description', 500],
    ['placeholder', 160],
  ] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > max) {
      issues.push({
        path: `${path}.${key}`,
        code: 'INVALID_TEXT',
        message: `${key}: até ${max} caracteres.`,
      })
    } else if (value.trim()) result[key] = value.trim()
  }
  const flags: ['searchable' | 'filterable' | 'sortable', readonly FieldType[]][] = [
    ['searchable', SEARCHABLE_TYPES],
    ['filterable', FILTERABLE_TYPES],
    ['sortable', SORTABLE_TYPES],
  ]
  for (const [key, types] of flags) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      issues.push({ path: `${path}.${key}`, code: 'INVALID_FLAG', message: `${key} é booleano.` })
    } else if (value && !types.includes(type)) {
      issues.push({
        path: `${path}.${key}`,
        code: 'NOT_SUPPORTED',
        message: `Campos ${type} não podem ser ${key === 'searchable' ? 'pesquisados' : key === 'filterable' ? 'filtrados' : 'ordenados'}.`,
      })
    } else if (value && sensitive) {
      issues.push({
        path: `${path}.${key}`,
        code: 'SENSITIVE',
        message: 'Um campo sensível não entra em pesquisas, filtros nem ordenações.',
      })
    } else result[key] = value
  }
  return result
}

/** Sem indicação explícita, um campo de texto não sensível é pesquisável; `false` retira-o. */
export const isSearchable = (spec: FieldSpec): boolean =>
  !spec.archived &&
  !spec.sensitive &&
  SEARCHABLE_TYPES.includes(spec.type) &&
  spec.presentation.searchable !== false

export const isSortable = (spec: FieldSpec): boolean =>
  !spec.archived &&
  !spec.sensitive &&
  SORTABLE_TYPES.includes(spec.type) &&
  spec.presentation.sortable !== false

export const isFilterable = (spec: FieldSpec): boolean =>
  !spec.archived &&
  !spec.sensitive &&
  FILTERABLE_TYPES.includes(spec.type) &&
  spec.presentation.filterable !== false
