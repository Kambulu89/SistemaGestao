import {
  CODE_PATTERN,
  MAX_FIELDS_PER_VERSION,
  MAX_OPTIONS,
  OPTION_CODE_PATTERN,
  TEXTAREA_DEFAULT_MAX,
  TEXT_DEFAULT_MAX,
  PLANNED_FIELD_TYPES,
  SUPPORTED_FIELD_TYPES,
  isSupportedType,
  type FieldOption,
  type FieldSpec,
  type FieldType,
  type Issue,
} from '#dynamic/metadata/domain/field_types'
import {
  checkPattern,
  parseDate,
  parseDecimal,
  parseInstant,
} from '#dynamic/metadata/domain/scalars'
import { validateValue } from '#dynamic/metadata/domain/value'

/** Definição de um campo tal como chega da API (a entidade de destino já vem resolvida para id). */
export interface FieldInput {
  code?: unknown
  label?: unknown
  type?: unknown
  required?: unknown
  defaultValue?: unknown
  validation?: unknown
  options?: unknown
  referenceEntityId?: unknown
  sensitive?: unknown
  readOnly?: unknown
}

/** Chaves de `validation` aceites por tipo: qualquer outra é recusada (nada se ignora em silêncio). */
const VALIDATION_KEYS: Record<FieldType, readonly string[]> = {
  TEXT: ['minLength', 'maxLength', 'pattern', 'unique'],
  TEXTAREA: ['minLength', 'maxLength'],
  NUMBER: ['min', 'max', 'unique'],
  DECIMAL: ['precision', 'scale', 'min', 'max', 'unique'],
  BOOLEAN: [],
  DATE: ['min', 'max', 'unique'],
  DATETIME: ['min', 'max'],
  EMAIL: ['unique'],
  PHONE: ['unique'],
  URL: ['unique'],
  SELECT: [],
  RADIO: [],
  MULTISELECT: ['minSelected', 'maxSelected'],
  ENTITY_REFERENCE: [],
  USER_REFERENCE: [],
}

const OPTION_TYPES: readonly FieldType[] = ['SELECT', 'RADIO', 'MULTISELECT']
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

function checkValidation(
  type: FieldType,
  raw: unknown,
  path: string,
  issues: Issue[]
): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {}
  if (!isRecord(raw)) {
    issues.push({ path, code: 'INVALID_VALIDATION', message: 'validation tem de ser um objecto.' })
    return {}
  }
  const allowed = VALIDATION_KEYS[type]
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        code: 'UNKNOWN_VALIDATION',
        message: `A regra "${key}" não existe para campos ${type}.`,
      })
    }
  }
  const v = { ...raw }
  const bad = (key: string, message: string) =>
    issues.push({ path: `${path}.${key}`, code: 'INVALID_VALIDATION', message })

  if ('unique' in v && typeof v.unique !== 'boolean') bad('unique', 'unique é booleano.')

  if (type === 'TEXT' || type === 'TEXTAREA') {
    const ceiling = type === 'TEXT' ? TEXT_DEFAULT_MAX : TEXTAREA_DEFAULT_MAX
    if ('minLength' in v && !isInt(v.minLength, 0, ceiling))
      bad('minLength', `minLength é um inteiro de 0 a ${ceiling}.`)
    if ('maxLength' in v && !isInt(v.maxLength, 1, ceiling))
      bad('maxLength', `maxLength é um inteiro de 1 a ${ceiling}.`)
    if (
      isInt(v.minLength, 0, ceiling) &&
      isInt(v.maxLength, 1, ceiling) &&
      v.minLength > v.maxLength
    ) {
      bad('minLength', 'minLength excede maxLength.')
    }
    if ('pattern' in v) {
      if (typeof v.pattern !== 'string') bad('pattern', 'pattern é texto.')
      else {
        const issue = checkPattern(v.pattern)
        if (issue) issues.push({ ...issue, path: `${path}.pattern` })
      }
    }
  }

  if (type === 'NUMBER') {
    for (const key of ['min', 'max']) {
      if (key in v && !(typeof v[key] === 'number' && Number.isSafeInteger(v[key]))) {
        bad(key, `${key} é um inteiro.`)
      }
    }
    if (typeof v.min === 'number' && typeof v.max === 'number' && v.min > v.max) {
      bad('min', 'min excede max.')
    }
  }

  if (type === 'DECIMAL') {
    if (!isInt(v.precision, 1, 19)) bad('precision', 'precision (1 a 19) é obrigatório.')
    if (!isInt(v.scale, 0, 6)) bad('scale', 'scale (0 a 6) é obrigatório.')
    else if (isInt(v.precision, 1, 19) && v.scale > v.precision)
      bad('scale', 'scale excede precision.')
    if (isInt(v.precision, 1, 19) && isInt(v.scale, 0, 6)) {
      const shape = { precision: v.precision, scale: v.scale }
      for (const key of ['min', 'max']) {
        if (key in v) {
          const parsed = typeof v[key] === 'string' ? parseDecimal(v[key] as string, shape) : null
          if (!parsed?.ok) bad(key, `${key} é um decimal em texto dentro da precisão e escala.`)
          else v[key] = parsed.canonical
        }
      }
      if (typeof v.min === 'string' && typeof v.max === 'string') {
        const lo = parseDecimal(v.min, shape)
        const hi = parseDecimal(v.max, shape)
        if (lo?.ok && hi?.ok && lo.scaled > hi.scaled) bad('min', 'min excede max.')
      }
    }
  }

  if (type === 'DATE' || type === 'DATETIME') {
    for (const key of ['min', 'max']) {
      if (key in v) {
        const parsed =
          typeof v[key] === 'string'
            ? type === 'DATE'
              ? parseDate(v[key] as string)
              : parseInstant(v[key] as string)
            : null
        if (!parsed)
          bad(
            key,
            `${key} é ${type === 'DATE' ? 'uma data AAAA-MM-DD' : 'um instante ISO 8601 com fuso'}.`
          )
        else v[key] = parsed
      }
    }
    if (typeof v.min === 'string' && typeof v.max === 'string' && v.min > v.max) {
      bad('min', 'min excede max.')
    }
  }

  if (type === 'MULTISELECT') {
    for (const key of ['minSelected', 'maxSelected']) {
      if (key in v && !isInt(v[key], 0, MAX_OPTIONS))
        bad(key, `${key} é um inteiro de 0 a ${MAX_OPTIONS}.`)
    }
    if (
      isInt(v.minSelected, 0, MAX_OPTIONS) &&
      isInt(v.maxSelected, 0, MAX_OPTIONS) &&
      v.minSelected > v.maxSelected
    ) {
      bad('minSelected', 'minSelected excede maxSelected.')
    }
  }
  return v
}

function checkOptions(type: FieldType, raw: unknown, path: string, issues: Issue[]): FieldOption[] {
  if (!OPTION_TYPES.includes(type)) {
    if (raw !== undefined && !(Array.isArray(raw) && raw.length === 0)) {
      issues.push({ path, code: 'OPTIONS_NOT_ALLOWED', message: `Campos ${type} não têm opções.` })
    }
    return []
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPTIONS) {
    issues.push({ path, code: 'INVALID_OPTIONS', message: `Indique 1 a ${MAX_OPTIONS} opções.` })
    return []
  }
  const seen = new Set<string>()
  const options: FieldOption[] = []
  raw.forEach((item, i) => {
    const at = `${path}[${i}]`
    if (!isRecord(item)) {
      issues.push({ path: at, code: 'INVALID_OPTION', message: 'Opção inválida.' })
      return
    }
    const { code, label } = item
    if (typeof code !== 'string' || !OPTION_CODE_PATTERN.test(code)) {
      issues.push({
        path: `${at}.code`,
        code: 'INVALID_CODE',
        message: 'Código: a-z, 0-9 e _ (máx. 50).',
      })
    } else if (seen.has(code)) {
      issues.push({
        path: `${at}.code`,
        code: 'DUPLICATE_OPTION',
        message: 'Código de opção repetido.',
      })
    } else {
      seen.add(code)
    }
    if (typeof label !== 'string' || !label.trim() || label.length > 120) {
      issues.push({
        path: `${at}.label`,
        code: 'INVALID_LABEL',
        message: 'O rótulo é obrigatório (máx. 120).',
      })
    }
    if ('archived' in item && item.archived !== false) {
      issues.push({
        path: `${at}.archived`,
        code: 'READ_ONLY',
        message: 'As opções são arquivadas pela publicação.',
      })
    }
    if (typeof code === 'string' && typeof label === 'string') {
      options.push({ code, label: label.trim() })
    }
  })
  return options
}

/** Valida e normaliza a definição de um campo. Devolve `null` se houver problemas (ver `issues`). */
export function normalizeField(
  input: FieldInput,
  position: number,
  issues: Issue[],
  path = `fields[${position}]`
): FieldSpec | null {
  const before = issues.length
  const add = (suffix: string, code: string, message: string) =>
    issues.push({ path: `${path}.${suffix}`, code, message })

  const { code, label, type } = input
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    add('code', 'INVALID_CODE', 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).')
  }
  if (typeof label !== 'string' || !label.trim() || label.length > 120) {
    add('label', 'INVALID_LABEL', 'O rótulo é obrigatório (máx. 120).')
  }
  if (!isSupportedType(type)) {
    if (typeof type === 'string' && type in PLANNED_FIELD_TYPES) {
      add(
        'type',
        'FIELD_TYPE_NOT_SUPPORTED',
        `O tipo ${type} ainda não está disponível (${PLANNED_FIELD_TYPES[type]}).`
      )
    } else {
      add(
        'type',
        'INVALID_TYPE',
        `Tipo inválido. Disponíveis: ${SUPPORTED_FIELD_TYPES.join(', ')}.`
      )
    }
    return null
  }
  for (const flag of ['required', 'sensitive', 'readOnly'] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') {
      add(flag, 'INVALID_FLAG', `${flag} é booleano.`)
    }
  }
  const validation = checkValidation(type, input.validation, `${path}.validation`, issues)
  const options = checkOptions(type, input.options, `${path}.options`, issues)

  let referenceEntityId: string | null = null
  if (type === 'ENTITY_REFERENCE') {
    if (typeof input.referenceEntityId !== 'string') {
      add('referenceEntityCode', 'REFERENCE_REQUIRED', 'Indique a entidade de destino.')
    } else referenceEntityId = input.referenceEntityId
  } else if (input.referenceEntityId !== undefined && input.referenceEntityId !== null) {
    add(
      'referenceEntityCode',
      'REFERENCE_NOT_ALLOWED',
      `Campos ${type} não têm entidade de destino.`
    )
  }

  const sensitive = input.sensitive === true
  if (validation.unique === true) {
    if (sensitive)
      add('validation.unique', 'UNIQUE_SENSITIVE', 'Um campo sensível não pode ser único.')
    if (input.defaultValue !== undefined && input.defaultValue !== null) {
      add('defaultValue', 'UNIQUE_DEFAULT', 'Um campo único não tem valor por omissão.')
    }
  }

  if (issues.length > before) return null
  const spec: FieldSpec = {
    code: code as string,
    label: (label as string).trim(),
    type,
    required: input.required === true,
    defaultValue: null,
    validation,
    options,
    position,
    referenceEntityId,
    sensitive,
    readOnly: input.readOnly === true,
    archived: false,
  }

  // O valor por omissão passa pelas mesmas regras do campo (um valor inválido nunca é publicado).
  if (input.defaultValue !== undefined && input.defaultValue !== null) {
    if (type === 'ENTITY_REFERENCE' || type === 'USER_REFERENCE') {
      add('defaultValue', 'DEFAULT_NOT_ALLOWED', 'Uma referência não tem valor por omissão.')
      return null
    }
    const result = validateValue(spec, input.defaultValue, null)
    if (!result.ok) {
      issues.push({ path: `${path}.defaultValue`, code: result.code, message: result.message })
      return null
    }
    spec.defaultValue = result.value
  }
  if (spec.readOnly && spec.required && spec.defaultValue === null) {
    add(
      'readOnly',
      'READ_ONLY_REQUIRED',
      'Um campo obrigatório só de leitura precisa de valor por omissão.'
    )
    return null
  }
  return spec
}

/** Valida o conjunto de campos de uma versão (códigos únicos, limite). */
export function normalizeFields(raw: unknown, issues: Issue[]): FieldSpec[] {
  if (!Array.isArray(raw)) {
    issues.push({ path: 'fields', code: 'INVALID_FIELDS', message: 'fields tem de ser uma lista.' })
    return []
  }
  if (raw.length > MAX_FIELDS_PER_VERSION) {
    issues.push({
      path: 'fields',
      code: 'TOO_MANY_FIELDS',
      message: `No máximo ${MAX_FIELDS_PER_VERSION} campos.`,
    })
    return []
  }
  const seen = new Set<string>()
  const specs: FieldSpec[] = []
  raw.forEach((item, i) => {
    if (!isRecord(item)) {
      issues.push({ path: `fields[${i}]`, code: 'INVALID_FIELD', message: 'Campo inválido.' })
      return
    }
    const spec = normalizeField(item as FieldInput, i, issues)
    if (!spec) return
    if (seen.has(spec.code)) {
      issues.push({
        path: `fields[${i}].code`,
        code: 'DUPLICATE_FIELD',
        message: 'Código de campo repetido.',
      })
      return
    }
    seen.add(spec.code)
    specs.push(spec)
  })
  return specs
}
