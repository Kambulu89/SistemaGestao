import {
  TEXTAREA_DEFAULT_MAX,
  TEXT_DEFAULT_MAX,
  decimalShape,
  type FieldSpec,
  type Issue,
} from '#dynamic/metadata/domain/field_types'
import { parseDecimal } from '#dynamic/metadata/domain/scalars'

export interface CompatibilityReport {
  /** Alterações que invalidariam registos ou valores antigos: sem migração, bloqueiam a publicação. */
  issues: Issue[]
  added: string[]
  removed: string[]
  changed: string[]
  /** Campos da nova versão já com os campos e opções retirados arquivados (valores antigos legíveis). */
  effective: FieldSpec[]
}

/** Compara dois limites do mesmo tipo: negativo, zero ou positivo (como `a - b`). */
function compare(spec: FieldSpec, a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (spec.type === 'DECIMAL' && typeof a === 'string' && typeof b === 'string') {
    const shape = decimalShape(spec.validation)
    const pa = parseDecimal(a, shape)
    const pb = parseDecimal(b, shape)
    if (pa.ok && pb.ok) return pa.scaled < pb.scaled ? -1 : pa.scaled > pb.scaled ? 1 : 0
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/** Pares (limite inferior, limite superior) por tipo, com o valor implícito quando não declarado. */
function bounds(spec: FieldSpec): {
  lower: string | null
  upper: string | null
  upperDefault?: number
} {
  switch (spec.type) {
    case 'TEXT':
      return { lower: 'minLength', upper: 'maxLength', upperDefault: TEXT_DEFAULT_MAX }
    case 'TEXTAREA':
      return { lower: 'minLength', upper: 'maxLength', upperDefault: TEXTAREA_DEFAULT_MAX }
    case 'MULTISELECT':
      return { lower: 'minSelected', upper: 'maxSelected' }
    case 'NUMBER':
    case 'DECIMAL':
    case 'DATE':
    case 'DATETIME':
      return { lower: 'min', upper: 'max' }
    default:
      return { lower: null, upper: null }
  }
}

function tightening(prev: FieldSpec, next: FieldSpec): string[] {
  const problems: string[] = []
  const { lower, upper, upperDefault } = bounds(prev)
  if (lower) {
    const before = prev.validation[lower]
    const after = next.validation[lower]
    if (after !== undefined && (before === undefined || compare(prev, after, before) > 0)) {
      problems.push(lower)
    }
  }
  if (upper) {
    const before = prev.validation[upper] ?? upperDefault
    const after = next.validation[upper] ?? upperDefault
    if (after !== undefined && (before === undefined || compare(prev, after, before) < 0)) {
      problems.push(upper)
    }
  }
  if (prev.type === 'DECIMAL') {
    for (const key of ['precision', 'scale']) {
      if (prev.validation[key] !== next.validation[key]) problems.push(key)
    }
  }
  if (prev.validation.pattern !== next.validation.pattern) problems.push('pattern')
  return problems
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Compara a versão publicada (`prev`) com o rascunho (`next`). Um campo retirado fica arquivado e uma
 * opção retirada fica arquivada; nada se apaga. O que invalidaria dados existentes (mudar o tipo,
 * apertar limites, tornar único, passar a obrigatório sem valor por omissão, tornar público um campo
 * sensível…) é reportado: sem mecanismo de migração, bloqueia a publicação.
 */
export function checkCompatibility(
  prev: readonly FieldSpec[],
  next: readonly FieldSpec[]
): CompatibilityReport {
  const issues: Issue[] = []
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  const prevByCode = new Map(prev.map((f) => [f.code, f]))
  const nextByCode = new Map(next.map((f) => [f.code, f]))
  const block = (code: string, issue: string, message: string) =>
    issues.push({ path: `fields.${code}`, code: issue, message })

  const effective: FieldSpec[] = []
  for (const field of next) {
    const before = prevByCode.get(field.code)
    if (!before || before.archived) {
      if (before?.archived) {
        block(
          field.code,
          'FIELD_CODE_RETIRED',
          'Este código de campo foi retirado e não pode ser reutilizado.'
        )
      } else {
        added.push(field.code)
        if (field.required && field.defaultValue === null) {
          block(
            field.code,
            'REQUIRED_WITHOUT_DEFAULT',
            'Um campo obrigatório novo precisa de valor por omissão.'
          )
        }
      }
      effective.push(field)
      continue
    }
    if (before.type !== field.type) {
      block(
        field.code,
        'FIELD_TYPE_CHANGED',
        `O tipo não muda em silêncio (${before.type} → ${field.type}).`
      )
    }
    if (before.referenceEntityId !== field.referenceEntityId) {
      block(field.code, 'REFERENCE_CHANGED', 'A entidade de destino não pode mudar.')
    }
    if (before.sensitive !== field.sensitive) {
      block(
        field.code,
        'SENSITIVE_CHANGED',
        'A classificação de sensibilidade é definitiva depois de publicada.'
      )
    }
    if (!before.required && field.required && field.defaultValue === null) {
      block(field.code, 'REQUIRED_WITHOUT_DEFAULT', 'Tornar obrigatório exige valor por omissão.')
    }
    if (before.validation.unique !== true && field.validation.unique === true) {
      block(
        field.code,
        'UNIQUE_ON_EXISTING',
        'Tornar único um campo publicado exige migração dos valores existentes.'
      )
    }
    if (before.type === field.type) {
      for (const key of tightening(before, field)) {
        block(
          field.code,
          'CONSTRAINT_TIGHTENED',
          `A regra "${key}" ficaria mais restritiva do que a dos registos existentes.`
        )
      }
    }
    // Opções retiradas ficam arquivadas, com o rótulo anterior.
    const options = [...field.options]
    for (const option of before.options) {
      if (!field.options.some((o) => o.code === option.code)) {
        options.push({ ...option, archived: true })
      }
    }
    const merged = { ...field, options }
    if (!sameJson(before, { ...merged, position: before.position })) changed.push(field.code)
    effective.push(merged)
  }

  for (const field of prev) {
    if (nextByCode.has(field.code)) continue
    if (!field.archived) removed.push(field.code)
    effective.push({ ...field, archived: true })
  }
  effective.forEach((f, i) => {
    f.position = i
  })
  return { issues, added, removed, changed, effective }
}
