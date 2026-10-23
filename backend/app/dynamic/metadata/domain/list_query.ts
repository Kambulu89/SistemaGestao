import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
import { isFilterable, isSortable } from '#dynamic/metadata/domain/presentation'
import { parseDecimal } from '#dynamic/metadata/domain/scalars'
import { decimalShape } from '#dynamic/metadata/domain/field_types'
import { validateValue } from '#dynamic/metadata/domain/value'

export type SortDirection = 'asc' | 'desc'

/** Ordenação já resolvida: uma coluna de sistema ou um campo da versão em vigor (nunca texto do cliente em SQL). */
export type ResolvedSort =
  | { kind: 'SYSTEM'; column: 'created_at' | 'updated_at'; direction: SortDirection }
  | { kind: 'FIELD'; field: FieldSpec; direction: SortDirection }

export interface ResolvedFilter {
  field: FieldSpec
  /** Valor já normalizado como o armazenado (texto em minúsculas, decimal canónico…). */
  value: string | number | boolean
}

const SORT = /^([A-Za-z][A-Za-z0-9_]*):(asc|desc)$/

/**
 * Resolve `sort` (`createdAt:desc`, `matricula:asc`) e `filter.<campo>=valor` contra os campos da versão
 * publicada em vigor. Só entram campos ordenáveis/filtráveis e não sensíveis; um valor inválido é um erro de
 * validação com o caminho do filtro.
 */
export function resolveListQuery(
  fields: readonly FieldSpec[],
  sort: string | undefined,
  filters: Readonly<Record<string, string>>
): { sort: ResolvedSort | null; filters: ResolvedFilter[]; issues: Issue[] } {
  const issues: Issue[] = []
  const byCode = new Map(fields.map((f) => [f.code, f]))

  let resolvedSort: ResolvedSort | null = null
  if (sort !== undefined) {
    const match = SORT.exec(sort)
    if (!match) {
      issues.push({ path: 'sort', code: 'INVALID_SORT', message: 'Use campo:asc ou campo:desc.' })
    } else {
      const [, key, direction] = match as unknown as [string, string, SortDirection]
      if (key === 'createdAt' || key === 'updatedAt') {
        resolvedSort = {
          kind: 'SYSTEM',
          column: key === 'createdAt' ? 'created_at' : 'updated_at',
          direction,
        }
      } else {
        const field = byCode.get(key)
        if (field && isSortable(field)) resolvedSort = { kind: 'FIELD', field, direction }
        else
          issues.push({
            path: 'sort',
            code: 'NOT_SORTABLE',
            message: `Não se ordena por "${key}".`,
          })
      }
    }
  }

  const resolvedFilters: ResolvedFilter[] = []
  for (const [code, raw] of Object.entries(filters)) {
    const path = `filter.${code}`
    const field = byCode.get(code)
    if (!field || !isFilterable(field)) {
      issues.push({ path, code: 'NOT_FILTERABLE', message: `Não se filtra por "${code}".` })
      continue
    }
    const value = filterValue(field, raw)
    if (value === null) {
      issues.push({
        path,
        code: 'INVALID_FILTER',
        message: 'Valor de filtro inválido para este campo.',
      })
    } else resolvedFilters.push({ field, value })
  }
  return { sort: resolvedSort, filters: resolvedFilters, issues }
}

function filterValue(field: FieldSpec, raw: string): string | number | boolean | null {
  switch (field.type) {
    case 'TEXT':
      return raw.trim().toLowerCase()
    case 'NUMBER':
      return /^-?\d{1,15}$/.test(raw) ? Number(raw) : null
    case 'DECIMAL': {
      const parsed = parseDecimal(raw, decimalShape(field.validation))
      return parsed.ok ? parsed.canonical : null
    }
    case 'BOOLEAN':
      return raw === 'true' ? true : raw === 'false' ? false : null
    case 'SELECT':
    case 'RADIO':
    case 'EMAIL':
    case 'PHONE':
    case 'URL':
    case 'DATE':
    case 'DATETIME':
    case 'USER_REFERENCE': {
      const result = validateValue(field, raw, raw)
      return result.ok && typeof result.value === 'string' ? result.value : null
    }
    default:
      return null
  }
}
