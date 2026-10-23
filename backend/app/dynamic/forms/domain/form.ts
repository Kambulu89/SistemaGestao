/**
 * Formulários (C11): a organização visual dos campos de uma entidade, sem alterar as invariantes dela. O formulário
 * **refere** campos pelo código (nunca duplica a definição) e só os pode restringir: o que a entidade exige continua
 * a valer, e os registos escrevem-se sempre na entidade, com a sua autorização e validação (um campo escondido no
 * formulário que chegue no pedido continua sujeito a elas).
 */
/** O que o formulário precisa de saber de cada campo da entidade (o domínio não importa outros módulos). */
export interface FormFieldInfo {
  code: string
  required: boolean
  readOnly: boolean
  sensitive: boolean
  archived: boolean
  defaultValue: unknown
}

export type FormStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED'
export const FORM_MODES = ['create', 'edit', 'read'] as const
export type FormMode = (typeof FORM_MODES)[number]

export interface FormIssue {
  path: string
  code: string
  message: string
}

export type ConditionScalar = string | number | boolean | null

/** Condição declarativa de apresentação (dados, nunca código); os campos são códigos de campo da entidade. */
export type FormCondition =
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: ConditionScalar }
  | { op: 'in' | 'nin'; field: string; values: ConditionScalar[] }
  | { op: 'empty' | 'notEmpty'; field: string }
  | { op: 'and' | 'or'; conditions: FormCondition[] }
  | { op: 'not'; condition: FormCondition }

export interface FormBinding {
  kind: 'field'
  /** Código do campo da entidade. */
  field: string
  /** Colunas que ocupa na grelha da secção (por omissão 1). */
  span?: number
  label?: string
  placeholder?: string
  help?: string
  /** `false` esconde o campo neste formulário. */
  visible?: boolean
  /** `false` torna-o só de leitura neste formulário. */
  editable?: boolean
  /** `true` exige-o neste formulário; nunca relaxa o que a entidade exige. */
  required?: boolean
  visibleWhen?: FormCondition
  editableWhen?: FormCondition
  requiredWhen?: FormCondition
}

export interface FormSection {
  key: string
  title: string
  description?: string
  /** Colunas da grelha em ecrãs largos (1 a 3). */
  columns: number
  visibleWhen?: FormCondition
  items: FormBinding[]
}

export const FORM_CODE = /^[a-z][a-z0-9_]{1,49}$/
export const SECTION_KEY = /^[a-z][a-z0-9_]{0,39}$/
export const MAX_SECTIONS = 20
export const MAX_BINDINGS = 200
const MAX_CONDITION_DEPTH = 8
const MAX_CONDITION_NODES = 50
const MAX_IN_VALUES = 50
const FIELD_CODE = /^[a-z][a-z0-9_]{1,49}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isScalar = (value: unknown): value is ConditionScalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const COMPARISONS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']
const MEMBERSHIP = ['in', 'nin']
const PRESENCE = ['empty', 'notEmpty']

/** Valida a estrutura de uma condição e devolve-a normalizada (só as chaves conhecidas). */
export function normalizeCondition(
  raw: unknown,
  path: string,
  issues: FormIssue[],
  budget = { nodes: 0 },
  depth = 1
): FormCondition | null {
  const bad = (code: string, message: string) => {
    issues.push({ path, code, message })
    return null
  }
  if (!isRecord(raw) || typeof raw.op !== 'string') {
    return bad('INVALID_CONDITION', 'A condição tem de ser um objecto com «op».')
  }
  if (depth > MAX_CONDITION_DEPTH) return bad('CONDITION_TOO_DEEP', 'Condição demasiado aninhada.')
  if (++budget.nodes > MAX_CONDITION_NODES) {
    return bad('CONDITION_TOO_LARGE', `No máximo ${MAX_CONDITION_NODES} nós por condição.`)
  }
  const field = () => {
    if (typeof raw.field !== 'string' || !FIELD_CODE.test(raw.field)) {
      return bad('INVALID_CONDITION_FIELD', 'Indique o código de um campo.')
    }
    return raw.field
  }
  const op = raw.op
  if (COMPARISONS.includes(op)) {
    const f = field()
    if (f === null) return null
    if (!isScalar(raw.value)) return bad('INVALID_CONDITION_VALUE', 'Valor simples em falta.')
    return { op, field: f, value: raw.value } as FormCondition
  }
  if (MEMBERSHIP.includes(op)) {
    const f = field()
    if (f === null) return null
    if (
      !Array.isArray(raw.values) ||
      raw.values.length === 0 ||
      raw.values.length > MAX_IN_VALUES ||
      !raw.values.every(isScalar)
    ) {
      return bad('INVALID_CONDITION_VALUE', `Indique 1 a ${MAX_IN_VALUES} valores simples.`)
    }
    return { op, field: f, values: raw.values } as FormCondition
  }
  if (PRESENCE.includes(op)) {
    const f = field()
    return f === null ? null : ({ op, field: f } as FormCondition)
  }
  if (op === 'and' || op === 'or') {
    if (!Array.isArray(raw.conditions) || raw.conditions.length === 0) {
      return bad('INVALID_CONDITION', `«${op}» precisa de condições.`)
    }
    const conditions: FormCondition[] = []
    for (const [i, child] of raw.conditions.entries()) {
      const normalized = normalizeCondition(
        child,
        `${path}.conditions[${i}]`,
        issues,
        budget,
        depth + 1
      )
      if (normalized) conditions.push(normalized)
    }
    return conditions.length === raw.conditions.length ? { op, conditions } : null
  }
  if (op === 'not') {
    const child = normalizeCondition(raw.condition, `${path}.condition`, issues, budget, depth + 1)
    return child ? { op, condition: child } : null
  }
  return bad('UNKNOWN_OP', `A operação «${op}» não existe.`)
}

/** Códigos de campo que uma condição lê. */
export function conditionFields(condition: FormCondition): string[] {
  switch (condition.op) {
    case 'and':
    case 'or':
      return condition.conditions.flatMap(conditionFields)
    case 'not':
      return conditionFields(condition.condition)
    default:
      return [condition.field]
  }
}

const text = (
  raw: Record<string, unknown>,
  key: string,
  max: number,
  path: string,
  issues: FormIssue[]
): string | undefined => {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > max) {
    issues.push({
      path: `${path}.${key}`,
      code: 'INVALID_TEXT',
      message: `${key}: até ${max} caracteres.`,
    })
    return undefined
  }
  return value.trim() || undefined
}

function unknownKeys(
  raw: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: FormIssue[]
) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${path}.${key}`, code: 'UNKNOWN_KEY', message: `«${key}» não existe.` })
    }
  }
}

function normalizeBinding(raw: unknown, path: string, issues: FormIssue[]): FormBinding | null {
  const before = issues.length
  if (!isRecord(raw)) {
    issues.push({ path, code: 'INVALID_BINDING', message: 'Cada item é um objecto.' })
    return null
  }
  unknownKeys(
    raw,
    [
      'kind',
      'field',
      'span',
      'label',
      'placeholder',
      'help',
      'visible',
      'editable',
      'required',
      'visibleWhen',
      'editableWhen',
      'requiredWhen',
    ],
    path,
    issues
  )
  if (raw.kind !== 'field') {
    issues.push({
      path: `${path}.kind`,
      code: 'UNSUPPORTED_ITEM',
      message: 'Só existem itens do tipo «field».',
    })
  }
  if (typeof raw.field !== 'string' || !FIELD_CODE.test(raw.field)) {
    issues.push({
      path: `${path}.field`,
      code: 'INVALID_CONDITION_FIELD',
      message: 'Indique o código de um campo.',
    })
  }
  const binding: FormBinding = { kind: 'field', field: raw.field as string }
  if (raw.span !== undefined) {
    if (!Number.isInteger(raw.span) || (raw.span as number) < 1 || (raw.span as number) > 3) {
      issues.push({
        path: `${path}.span`,
        code: 'INVALID_SPAN',
        message: 'span: inteiro de 1 a 3.',
      })
    } else binding.span = raw.span as number
  }
  for (const [key, max] of [
    ['label', 120],
    ['placeholder', 160],
    ['help', 500],
  ] as const) {
    const value = text(raw, key, max, path, issues)
    if (value) binding[key] = value
  }
  for (const key of ['visible', 'editable', 'required'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') {
      issues.push({ path: `${path}.${key}`, code: 'INVALID_FLAG', message: `${key} é booleano.` })
    } else binding[key] = raw[key] as boolean
  }
  for (const key of ['visibleWhen', 'editableWhen', 'requiredWhen'] as const) {
    if (raw[key] === undefined) continue
    const condition = normalizeCondition(raw[key], `${path}.${key}`, issues)
    if (condition) binding[key] = condition
  }
  return issues.length > before ? null : binding
}

/** Valida a estrutura das secções (sem olhar para a entidade). */
export function normalizeSections(raw: unknown, issues: FormIssue[]): FormSection[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SECTIONS) {
    issues.push({
      path: 'sections',
      code: 'INVALID_SECTIONS',
      message: `Indique 1 a ${MAX_SECTIONS} secções.`,
    })
    return []
  }
  const sections: FormSection[] = []
  const keys = new Set<string>()
  let bindings = 0
  raw.forEach((item, i) => {
    const path = `sections[${i}]`
    if (!isRecord(item)) {
      issues.push({ path, code: 'INVALID_SECTION', message: 'Secção inválida.' })
      return
    }
    const before = issues.length
    unknownKeys(
      item,
      ['key', 'title', 'description', 'columns', 'visibleWhen', 'items'],
      path,
      issues
    )
    if (typeof item.key !== 'string' || !SECTION_KEY.test(item.key)) {
      issues.push({
        path: `${path}.key`,
        code: 'INVALID_CODE',
        message: 'Chave: a-z, 0-9 e _ (começa por letra, máx. 40).',
      })
    } else if (keys.has(item.key)) {
      issues.push({
        path: `${path}.key`,
        code: 'DUPLICATE_SECTION',
        message: 'Chave de secção repetida.',
      })
    } else keys.add(item.key)
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120) {
      issues.push({
        path: `${path}.title`,
        code: 'INVALID_TITLE',
        message: 'O título é obrigatório (máx. 120).',
      })
    }
    const columns = item.columns === undefined ? 1 : item.columns
    if (!Number.isInteger(columns) || (columns as number) < 1 || (columns as number) > 3) {
      issues.push({
        path: `${path}.columns`,
        code: 'INVALID_COLUMNS',
        message: 'columns: inteiro de 1 a 3.',
      })
    }
    const description = text(item, 'description', 500, path, issues)
    const visibleWhen =
      item.visibleWhen === undefined
        ? undefined
        : (normalizeCondition(item.visibleWhen, `${path}.visibleWhen`, issues) ?? undefined)
    const items: FormBinding[] = []
    if (!Array.isArray(item.items)) {
      issues.push({
        path: `${path}.items`,
        code: 'INVALID_ITEMS',
        message: 'items tem de ser uma lista.',
      })
    } else {
      item.items.forEach((entry, j) => {
        bindings += 1
        const binding = normalizeBinding(entry, `${path}.items[${j}]`, issues)
        if (binding) items.push(binding)
      })
    }
    if (bindings > MAX_BINDINGS) {
      issues.push({
        path: 'sections',
        code: 'TOO_MANY_FIELDS',
        message: `No máximo ${MAX_BINDINGS} campos.`,
      })
    }
    if (issues.length > before) return
    sections.push({
      key: item.key as string,
      title: (item.title as string).trim(),
      ...(description ? { description } : {}),
      columns: columns as number,
      ...(visibleWhen ? { visibleWhen } : {}),
      items,
    })
  })
  return sections
}

export function normalizeModes(raw: unknown, issues: FormIssue[]): FormMode[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((m) => (FORM_MODES as readonly string[]).includes(m as string)) ||
    new Set(raw).size !== raw.length
  ) {
    issues.push({
      path: 'modes',
      code: 'INVALID_MODES',
      message: `Indique os modos sem repetir: ${FORM_MODES.join(', ')}.`,
    })
    return []
  }
  return FORM_MODES.filter((m) => (raw as string[]).includes(m))
}

const hasDefault = (field: FormFieldInfo) =>
  field.defaultValue !== null && field.defaultValue !== undefined

/**
 * Verifica o formulário contra os campos da entidade (versão publicada em vigor): campos existentes, activos e
 * ligados uma só vez; condições só sobre campos activos e não sensíveis; e nada que torne impossível preencher um
 * campo obrigatório (escondê-lo, torná-lo só de leitura ou deixá-lo de fora nos modos de escrita).
 */
export function checkFormAgainstFields(
  sections: readonly FormSection[],
  modes: readonly FormMode[],
  fields: readonly FormFieldInfo[]
): FormIssue[] {
  const issues: FormIssue[] = []
  const byCode = new Map(fields.map((f) => [f.code, f]))
  const bound = new Set<string>()
  const readable = (code: string, path: string): boolean => {
    const field = byCode.get(code)
    if (!field || field.archived) {
      issues.push({
        path,
        code: 'FORM_UNKNOWN_FIELD',
        message: `O campo «${code}» não existe (ou está arquivado) nesta entidade.`,
      })
      return false
    }
    return true
  }
  const checkCondition = (condition: FormCondition | undefined, path: string) => {
    if (!condition) return
    for (const code of conditionFields(condition)) {
      if (!readable(code, path)) continue
      if (byCode.get(code)?.sensitive) {
        issues.push({
          path,
          code: 'FORM_SENSITIVE_CONDITION',
          message: `O campo sensível «${code}» não pode condicionar a apresentação.`,
        })
      }
    }
  }

  sections.forEach((section, i) => {
    const sectionPath = `sections[${i}]`
    checkCondition(section.visibleWhen, `${sectionPath}.visibleWhen`)
    section.items.forEach((binding, j) => {
      const path = `${sectionPath}.items[${j}]`
      if (bound.has(binding.field)) {
        issues.push({
          path: `${path}.field`,
          code: 'FORM_DUPLICATE_FIELD',
          message: `O campo «${binding.field}» já está no formulário.`,
        })
        return
      }
      bound.add(binding.field)
      if (!readable(binding.field, `${path}.field`)) return
      const field = byCode.get(binding.field) as FormFieldInfo
      if (binding.span && binding.span > section.columns) {
        issues.push({
          path: `${path}.span`,
          code: 'FORM_SPAN_TOO_WIDE',
          message: `Ocupa ${binding.span} colunas numa secção de ${section.columns}.`,
        })
      }
      if (binding.required && field.readOnly) {
        issues.push({
          path: `${path}.required`,
          code: 'FORM_REQUIRED_READ_ONLY',
          message: 'Um campo só de leitura não pode ser obrigatório.',
        })
      }
      for (const key of ['visibleWhen', 'editableWhen', 'requiredWhen'] as const) {
        checkCondition(binding[key], `${path}.${key}`)
      }
      // Escrever exige poder preencher o que a entidade exige.
      const writes = modes.includes('create') || modes.includes('edit')
      if (writes && field.required && !field.readOnly && !hasDefault(field)) {
        const hidden = binding.visible === false || binding.visibleWhen || section.visibleWhen
        if (hidden || binding.editable === false) {
          issues.push({
            path,
            code: 'FORM_HIDES_REQUIRED',
            message: `O campo obrigatório «${field.code}» não pode ficar escondido nem só de leitura sem outra forma de o preencher.`,
          })
        }
      }
    })
  })

  if (modes.includes('create') || modes.includes('edit')) {
    for (const field of fields) {
      if (field.archived || !field.required || field.readOnly || hasDefault(field)) continue
      if (!bound.has(field.code)) {
        issues.push({
          path: 'sections',
          code: 'FORM_MISSING_REQUIRED',
          message: `O campo obrigatório «${field.code}» tem de estar no formulário.`,
        })
      }
    }
  }
  return issues
}
