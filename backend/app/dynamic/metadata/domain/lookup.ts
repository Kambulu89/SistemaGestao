import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'

/**
 * Valores relacionados (C10, `LOOKUP`): mostram um campo do registo apontado por uma referência da mesma
 * entidade. São **lidos em tempo real** do registo de origem, nunca copiados nem guardados: a autorização
 * do destino aplica-se a cada leitura e o valor reflecte sempre o que a pessoa pode ver.
 */
export const LOOKUP_ON_MISSING = ['empty', 'error'] as const
export type LookupOnMissing = (typeof LOOKUP_ON_MISSING)[number]

/** Tipos do campo de origem que se podem mostrar (escalares; sem cadeias de lookups nem colecções). */
export const LOOKUP_SOURCE_TYPES = [
  'TEXT',
  'TEXTAREA',
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
  'FORMULA',
] as const

export interface StoredLookup {
  relationField: string
  sourceField: string
  onMissing: LookupOnMissing
  /** Derivados pelo servidor do campo de origem ao gravar a definição (a interface precisa deles para formatar). */
  sourceType?: string
  scale?: number
}

export function lookupOf(spec: FieldSpec): StoredLookup | null {
  return spec.type === 'LOOKUP' ? (spec.validation as unknown as StoredLookup) : null
}

/**
 * Verifica, dentro de uma versão, a relação de cada valor relacionado: existe, não está arquivada e é uma
 * referência a entidade. O que depende da entidade de destino verifica-se na aplicação.
 */
export function checkLookupSet(fields: readonly FieldSpec[]): { code: string; issue: Issue }[] {
  const problems: { code: string; issue: Issue }[] = []
  const byCode = new Map(fields.map((f) => [f.code, f]))
  for (const field of fields) {
    const lookup = lookupOf(field)
    if (!lookup || field.archived) continue
    const report = (code: string, message: string) =>
      problems.push({
        code: field.code,
        issue: { path: 'validation.relationField', code, message },
      })
    const relation = byCode.get(lookup.relationField)
    if (!relation) {
      report('LOOKUP_UNKNOWN_RELATION', `O campo de relação "${lookup.relationField}" não existe.`)
    } else if (relation.archived) {
      report('LOOKUP_ARCHIVED_RELATION', `O campo de relação "${relation.code}" está arquivado.`)
    } else if (relation.type !== 'ENTITY_REFERENCE') {
      report('LOOKUP_RELATION_NOT_REFERENCE', `"${relation.code}" não é uma referência a entidade.`)
    }
  }
  return problems
}

/** Campos de relação obrigatórios para guardar (`onMissing: 'error'`) que ainda não têm valor. */
export function missingLookupRelations(
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, unknown>>
): Issue[] {
  const issues: Issue[] = []
  for (const field of fields) {
    const lookup = lookupOf(field)
    if (!lookup || field.archived || lookup.onMissing !== 'error') continue
    const value = values[lookup.relationField]
    if (value === undefined || value === null || value === '') {
      issues.push({
        path: `data.${lookup.relationField}`,
        code: 'LOOKUP_RELATION_REQUIRED',
        message: `Indique este campo: é necessário para «${field.label}».`,
      })
    }
  }
  return issues
}
