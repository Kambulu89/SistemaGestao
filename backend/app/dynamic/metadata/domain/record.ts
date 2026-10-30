import {
  CODE_PATTERN,
  MAX_RECORD_BYTES,
  type FieldSpec,
  type Issue,
} from '#dynamic/metadata/domain/field_types'
import { computeFormulaValues } from '#dynamic/metadata/domain/formula'
import { missingLookupRelations } from '#dynamic/metadata/domain/lookup'
import { isSearchable } from '#dynamic/metadata/domain/presentation'
import { validateValue } from '#dynamic/metadata/domain/value'

export type RecordValues = Record<string, unknown>

const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)

export interface RecordValidation {
  values: RecordValues
  issues: Issue[]
}

/**
 * Valida os dados de um registo contra os campos de **uma versão**. Em criação os campos em falta
 * recebem o valor por omissão; numa alteração (`previous` presente) `input` é parcial e `null` apaga
 * o valor. Desconhecidos, só de leitura e arquivados nunca são aceites; o resultado é normalizado.
 */
export function validateRecordData(
  fields: readonly FieldSpec[],
  input: unknown,
  previous: RecordValues | null
): RecordValidation {
  const issues: Issue[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      values: {},
      issues: [{ path: 'data', code: 'INVALID_DATA', message: 'data tem de ser um objecto.' }],
    }
  }
  const body = input as Record<string, unknown>
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_RECORD_BYTES) {
    return {
      values: {},
      issues: [{ path: 'data', code: 'DATA_TOO_LARGE', message: 'Os dados excedem 64 KB.' }],
    }
  }
  const byCode = new Map(fields.map((f) => [f.code, f]))
  const values: RecordValues = { ...(previous ?? {}) }
  const rejected = new Set<string>()

  for (const key of Object.keys(body)) {
    const spec = CODE_PATTERN.test(key) ? byCode.get(key) : undefined
    const path = `data.${key}`
    if (!spec) {
      issues.push({ path, code: 'UNKNOWN_FIELD', message: 'Campo desconhecido nesta versão.' })
      continue
    }
    rejected.add(key)
    if (spec.archived) {
      issues.push({
        path,
        code: 'ARCHIVED_FIELD',
        message: 'Campo arquivado: já não aceita valores.',
      })
      continue
    }
    if (spec.readOnly) {
      issues.push({ path, code: 'READ_ONLY', message: 'Campo só de leitura.' })
      continue
    }
    const raw = body[key]
    if (raw === null) {
      delete values[key]
      rejected.delete(key)
      continue
    }
    const result = validateValue(spec, raw, previous?.[key])
    if (result.ok) {
      values[key] = result.value
      rejected.delete(key)
    } else issues.push({ path, code: result.code, message: result.message })
  }

  for (const spec of fields) {
    // Um valor já recusado não gera também «obrigatório».
    if (spec.archived || has(values, spec.code) || rejected.has(spec.code)) continue
    if (spec.defaultValue !== null && spec.defaultValue !== undefined) {
      values[spec.code] = spec.defaultValue
    } else if (spec.required) {
      issues.push({ path: `data.${spec.code}`, code: 'REQUIRED', message: 'Campo obrigatório.' })
    }
  }
  // As fórmulas calculam-se sempre no servidor, sobre os valores finais (um resultado vazio apaga o anterior).
  for (const [code, result] of Object.entries(computeFormulaValues(fields, values))) {
    if (result === null) delete values[code]
    else values[code] = result
  }
  issues.push(...missingLookupRelations(fields, values))
  return { values, issues }
}

export interface ReferenceUse {
  path: string
  kind: 'ENTITY' | 'USER'
  /** Entidade de destino (só `ENTITY`). */
  entityId: string | null
  id: string
}

/** Referências presentes nos valores, para a aplicação verificar a existência no tenant. */
export function collectReferences(
  fields: readonly FieldSpec[],
  values: RecordValues
): ReferenceUse[] {
  const uses: ReferenceUse[] = []
  for (const spec of fields) {
    const value = values[spec.code]
    if (spec.archived || typeof value !== 'string') continue
    if (spec.type === 'ENTITY_REFERENCE') {
      uses.push({
        path: `data.${spec.code}`,
        kind: 'ENTITY',
        entityId: spec.referenceEntityId,
        id: value,
      })
    } else if (spec.type === 'USER_REFERENCE') {
      uses.push({ path: `data.${spec.code}`, kind: 'USER', entityId: null, id: value })
    }
  }
  return uses
}

/** Chave de comparação dos campos únicos (texto sem distinção de maiúsculas). */
export function uniqueKeys(
  fields: readonly FieldSpec[],
  values: RecordValues
): { fieldCode: string; key: string }[] {
  const keys: { fieldCode: string; key: string }[] = []
  for (const spec of fields) {
    if (spec.archived || spec.validation.unique !== true) continue
    const value = values[spec.code]
    if (value === undefined || value === null) continue
    keys.push({ fieldCode: spec.code, key: String(value).trim().toLowerCase() })
  }
  return keys
}

/** Texto pesquisável: só campos de texto **não sensíveis** e não excluídos (a pesquisa nunca revela dados protegidos). */
export function searchText(fields: readonly FieldSpec[], values: RecordValues): string {
  const parts: string[] = []
  for (const spec of fields) {
    const value = values[spec.code]
    if (!isSearchable(spec) || typeof value !== 'string') continue
    if (spec.type === 'SELECT' || spec.type === 'RADIO') {
      parts.push(spec.options.find((o) => o.code === value)?.label ?? value)
    } else parts.push(value)
  }
  return parts.join(' ').toLowerCase().slice(0, 2000)
}

/** Separa os valores sensíveis (guardados e auditados à parte) dos restantes. */
export function partition(
  fields: readonly FieldSpec[],
  values: RecordValues
): { data: RecordValues; sensitive: RecordValues } {
  const sensitiveCodes = new Set(fields.filter((f) => f.sensitive).map((f) => f.code))
  const data: RecordValues = {}
  const sensitive: RecordValues = {}
  for (const [key, value] of Object.entries(values)) {
    ;(sensitiveCodes.has(key) ? sensitive : data)[key] = value
  }
  return { data, sensitive }
}
