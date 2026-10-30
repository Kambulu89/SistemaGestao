/**
 * Relatórios, painéis e pesquisa (S04): regras puras. Um relatório é uma **consulta declarativa** sobre um dataset
 * registado em código: o cliente só escolhe campos, filtros, agrupamento e medidas de uma lista fechada, e o SQL nasce
 * aqui a partir de expressões fixas do dataset. Nunca há SQL, nomes de coluna nem operadores vindos do cliente.
 */

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export const FIELD_TYPES = ['string', 'enum', 'date', 'decimal', 'integer'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export interface DatasetField {
  code: string
  label: string
  type: FieldType
  /** Expressão SQL fixa (definida em código), sobre o `from` do dataset. */
  expression: string
  enumValues?: readonly string[]
  /** Permissão adicional para ver o campo (campos sensíveis): sem ela o campo fica oculto. */
  permission?: string
}

export interface DatasetDefinition {
  code: string
  name: string
  description: string
  /** Permissão para ler o dataset. */
  permission: string
  /** Fragmento `FROM` fixo; tem de filtrar `tenant_id = :tenant`. */
  from: string
  /** Condição fixa adicional (por exemplo, só facturas emitidas). */
  where?: string
  fields: readonly DatasetField[]
  /** Ordem por omissão dos detalhes (expressões fixas). */
  defaultSort: string
  /** Datas, denominadores e fórmulas, documentados (uma frase por linha). */
  documentation: readonly string[]
}

export const FILTER_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'contains',
] as const
export type FilterOp = (typeof FILTER_OPS)[number]

const OPS_BY_TYPE: Record<FieldType, readonly FilterOp[]> = {
  string: ['eq', 'neq', 'contains', 'in'],
  enum: ['eq', 'neq', 'in'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  decimal: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  integer: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
}

export const MEASURE_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max'] as const
export type MeasureFunction = (typeof MEASURE_FUNCTIONS)[number]

export interface Filter {
  field: string
  op: FilterOp
  value: unknown
}

export interface Measure {
  fn: MeasureFunction
  field?: string
  alias: string
}

export interface SortSpec {
  field: string
  dir: 'asc' | 'desc'
}

export interface ReportQuery {
  select: string[]
  filters: Filter[]
  groupBy: string[]
  measures: Measure[]
  sort: SortSpec[]
}

export const MAX_FILTERS = 20
export const MAX_IN_VALUES = 100
export const MAX_MEASURES = 10
export const MAX_GROUPS = 4
export const MAX_PAGE = 500
const ALIAS = /^[a-z][a-z0-9_]{0,29}$/
const DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export const isAggregated = (query: ReportQuery): boolean =>
  query.groupBy.length > 0 || query.measures.length > 0

/** Os campos visíveis para quem corre o relatório: os sensíveis e os escondidos por ABAC ficam de fora. */
export function visibleFields(
  dataset: DatasetDefinition,
  hidden: ReadonlySet<string>
): DatasetField[] {
  return dataset.fields.filter((f) => !hidden.has(f.code))
}

function checkValue(field: DatasetField, op: FilterOp, value: unknown, path: string): Issue[] {
  const scalar = (v: unknown, at: string): Issue | null => {
    switch (field.type) {
      case 'date':
        return isIsoDate(v) ? null : issue(at, 'INVALID_VALUE', 'Data inválida (AAAA-MM-DD).')
      case 'decimal':
        return typeof v === 'string' && DECIMAL.test(v)
          ? null
          : issue(at, 'INVALID_VALUE', 'Decimal inválido (texto, até 6 casas).')
      case 'integer':
        return typeof v === 'number' && Number.isInteger(v)
          ? null
          : issue(at, 'INVALID_VALUE', 'Inteiro inválido.')
      case 'enum':
        return typeof v === 'string' && (field.enumValues ?? []).includes(v)
          ? null
          : issue(at, 'INVALID_VALUE', 'Valor fora da lista permitida.')
      default:
        return typeof v === 'string' && v.length > 0 && v.length <= 200
          ? null
          : issue(at, 'INVALID_VALUE', 'Texto inválido (1 a 200 caracteres).')
    }
  }
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
      return [issue(path, 'INVALID_VALUE', `Indique de 1 a ${MAX_IN_VALUES} valores.`)]
    }
    return value.map((v, i) => scalar(v, `${path}.${i}`)).filter((x): x is Issue => x !== null)
  }
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      return [issue(path, 'INVALID_VALUE', 'Indique o início e o fim.')]
    }
    return value.map((v, i) => scalar(v, `${path}.${i}`)).filter((x): x is Issue => x !== null)
  }
  const single = scalar(value, path)
  return single ? [single] : []
}

/**
 * Valida a consulta contra o dataset e os campos visíveis. Um campo oculto ou desconhecido em filtros, agrupamento,
 * medidas ou ordenação é recusado (`FIELD_NOT_ALLOWED`), nunca ignorado em silêncio: o resultado não pode depender de um
 * campo que a pessoa não vê. Só a **lista de colunas** de detalhe se reduz aos campos visíveis (ver `omitHidden`).
 */
export function validateQuery(
  dataset: DatasetDefinition,
  raw: Partial<Record<keyof ReportQuery, unknown>>,
  hidden: ReadonlySet<string>
): { value?: ReportQuery; issues: Issue[] } {
  const issues: Issue[] = []
  const fields = new Map(dataset.fields.map((f) => [f.code, f]))
  const known = (code: unknown, path: string, allowHidden = false): DatasetField | null => {
    const field = typeof code === 'string' ? fields.get(code) : undefined
    if (!field || (!allowHidden && hidden.has(field.code))) {
      issues.push(issue(path, 'FIELD_NOT_ALLOWED', 'Campo desconhecido ou sem acesso.'))
      return null
    }
    return field
  }
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

  const select = list(raw.select).filter((c): c is string => typeof c === 'string')
  const groupBy = list(raw.groupBy)
  const measuresRaw = list(raw.measures)
  const filtersRaw = list(raw.filters)
  const sortRaw = list(raw.sort)

  if (select.length !== list(raw.select).length || select.length > 50) {
    issues.push(issue('select', 'INVALID', 'Lista de campos inválida.'))
  }
  if (groupBy.length > MAX_GROUPS) {
    issues.push(issue('groupBy', 'TOO_MANY', `No máximo ${MAX_GROUPS} agrupamentos.`))
  }
  if (measuresRaw.length > MAX_MEASURES) {
    issues.push(issue('measures', 'TOO_MANY', `No máximo ${MAX_MEASURES} medidas.`))
  }
  if (filtersRaw.length > MAX_FILTERS) {
    issues.push(issue('filters', 'TOO_MANY', `No máximo ${MAX_FILTERS} filtros.`))
  }

  const outSelect: string[] = []
  select.forEach((code, i) => {
    // Em detalhe, um campo oculto sai da lista (o relatório guardado continua a correr para quem o vê).
    const field = fields.get(code)
    if (!field) issues.push(issue(`select.${i}`, 'FIELD_NOT_ALLOWED', 'Campo desconhecido.'))
    else if (!hidden.has(code) && !outSelect.includes(code)) outSelect.push(code)
  })

  const outGroup: string[] = []
  groupBy.forEach((code, i) => {
    const field = known(code, `groupBy.${i}`)
    if (field && !outGroup.includes(field.code)) outGroup.push(field.code)
  })

  const aliases = new Set<string>()
  const outMeasures: Measure[] = []
  measuresRaw.forEach((entry, i) => {
    const m = (entry ?? {}) as Record<string, unknown>
    const path = `measures.${i}`
    const fn = m['fn']
    if (!(MEASURE_FUNCTIONS as readonly unknown[]).includes(fn)) {
      issues.push(issue(`${path}.fn`, 'INVALID', 'Função de medida inválida.'))
      return
    }
    const alias = typeof m['alias'] === 'string' ? m['alias'] : ''
    if (!ALIAS.test(alias) || fields.has(alias) || aliases.has(alias)) {
      issues.push(issue(`${path}.alias`, 'INVALID', 'Alias inválido ou repetido (a-z, 0-9 e _).'))
      return
    }
    aliases.add(alias)
    if (fn === 'count' && (m['field'] === undefined || m['field'] === null)) {
      outMeasures.push({ fn: 'count', alias })
      return
    }
    const field = known(m['field'], `${path}.field`)
    if (!field) return
    const numeric = field.type === 'decimal' || field.type === 'integer'
    const ordered = numeric || field.type === 'date'
    if (
      ((fn === 'sum' || fn === 'avg') && !numeric) ||
      ((fn === 'min' || fn === 'max') && !ordered)
    ) {
      issues.push(issue(`${path}.fn`, 'INVALID', 'Esta função não se aplica ao tipo do campo.'))
      return
    }
    outMeasures.push({ fn: fn as MeasureFunction, field: field.code, alias })
  })

  const outFilters: Filter[] = []
  filtersRaw.forEach((entry, i) => {
    const f = (entry ?? {}) as Record<string, unknown>
    const path = `filters.${i}`
    const field = known(f['field'], `${path}.field`)
    if (!field) return
    const op = f['op']
    if (
      !(FILTER_OPS as readonly unknown[]).includes(op) ||
      !OPS_BY_TYPE[field.type].includes(op as FilterOp)
    ) {
      issues.push(issue(`${path}.op`, 'INVALID', 'Operador inválido para este campo.'))
      return
    }
    const problems = checkValue(field, op as FilterOp, f['value'], `${path}.value`)
    if (problems.length) issues.push(...problems)
    else outFilters.push({ field: field.code, op: op as FilterOp, value: f['value'] })
  })

  const aggregated = outGroup.length > 0 || outMeasures.length > 0
  if (aggregated) {
    for (const code of outSelect) {
      if (!outGroup.includes(code)) {
        issues.push(
          issue('select', 'SELECT_NOT_GROUPED', `O campo ${code} tem de estar no agrupamento.`)
        )
      }
    }
  } else if (outSelect.length === 0) {
    issues.push(issue('select', 'REQUIRED', 'Escolha pelo menos um campo visível.'))
  }

  const columns = aggregated ? [...outGroup, ...outMeasures.map((m) => m.alias)] : outSelect
  const outSort: SortSpec[] = []
  sortRaw.forEach((entry, i) => {
    const s = (entry ?? {}) as Record<string, unknown>
    const field = s['field']
    if (
      typeof field !== 'string' ||
      !columns.includes(field) ||
      (s['dir'] !== 'asc' && s['dir'] !== 'desc')
    ) {
      issues.push(
        issue(`sort.${i}`, 'INVALID', 'Ordene por uma coluna do resultado (asc ou desc).')
      )
      return
    }
    outSort.push({ field, dir: s['dir'] })
  })

  if (issues.length) return { issues }
  return {
    value: {
      select: outSelect,
      filters: outFilters,
      groupBy: outGroup,
      measures: outMeasures,
      sort: outSort,
    },
    issues,
  }
}

export interface BuiltQuery {
  sql: string
  countSql: string
  bindings: Record<string, unknown>
  columns: { code: string; label: string; type: FieldType | 'measure' }[]
}

const quoteAlias = (alias: string) => `"${alias}"`

/** Expressão de saída de um campo: datas em texto ISO, decimais em texto (nunca float). */
function outputOf(field: DatasetField): string {
  if (field.type === 'date') return `to_char(${field.expression}, 'YYYY-MM-DD')`
  if (field.type === 'decimal') return `cast(${field.expression} as text)`
  return `(${field.expression})`
}

/**
 * Constrói o SQL parametrizado. As expressões vêm do dataset (código); os valores vão sempre por parâmetros nomeados.
 * O filtro do tenant é do próprio dataset (`:tenant`) e a RLS aplica-se por cima.
 */
export function buildQuery(
  dataset: DatasetDefinition,
  query: ReportQuery,
  tenantId: string,
  page: { limit: number; offset: number }
): BuiltQuery {
  const fields = new Map(dataset.fields.map((f) => [f.code, f]))
  const bindings: Record<string, unknown> = { tenant: tenantId }
  const where: string[] = [dataset.where ? `(${dataset.where})` : 'true']
  let n = 0
  const bind = (value: unknown): string => {
    const name = `p${n++}`
    bindings[name] = value
    return `:${name}`
  }
  for (const f of query.filters) {
    const field = fields.get(f.field) as DatasetField
    const e = `(${field.expression})`
    const castTo = field.type === 'decimal' ? 'numeric' : field.type === 'date' ? 'date' : null
    const v = (value: unknown) => (castTo ? `cast(${bind(value)} as ${castTo})` : bind(value))
    switch (f.op) {
      case 'eq':
        where.push(`${e} = ${v(f.value)}`)
        break
      case 'neq':
        where.push(`${e} <> ${v(f.value)}`)
        break
      case 'gt':
        where.push(`${e} > ${v(f.value)}`)
        break
      case 'gte':
        where.push(`${e} >= ${v(f.value)}`)
        break
      case 'lt':
        where.push(`${e} < ${v(f.value)}`)
        break
      case 'lte':
        where.push(`${e} <= ${v(f.value)}`)
        break
      case 'between': {
        const [from, to] = f.value as [unknown, unknown]
        where.push(`${e} between ${v(from)} and ${v(to)}`)
        break
      }
      case 'in': {
        const parts = (f.value as unknown[]).map((x) => v(x))
        where.push(`${e} in (${parts.join(', ')})`)
        break
      }
      case 'contains': {
        const text = String(f.value).replace(/[\\%_]/g, (c) => `\\${c}`)
        where.push(`${e} ilike ${bind(`%${text}%`)} escape '\\'`)
        break
      }
    }
  }
  const aggregated = isAggregated(query)
  const columns: BuiltQuery['columns'] = []
  const selectParts: string[] = []
  const groupExprs: string[] = []
  const orderBy: Record<string, string> = {}
  const add = (field: DatasetField) => {
    selectParts.push(`${outputOf(field)} as ${quoteAlias(field.code)}`)
    columns.push({ code: field.code, label: field.label, type: field.type })
    orderBy[field.code] = `(${field.expression})`
  }
  if (aggregated) {
    for (const code of query.groupBy) {
      const field = fields.get(code) as DatasetField
      add(field)
      groupExprs.push(`(${field.expression})`)
    }
    for (const m of query.measures) {
      const field = m.field ? (fields.get(m.field) as DatasetField) : null
      const e = field ? `(${field.expression})` : '*'
      let expr: string
      if (m.fn === 'count') expr = `cast(count(${e}) as int)`
      else if (m.fn === 'sum') expr = `cast(sum(${e}) as text)`
      else if (m.fn === 'avg') expr = `cast(round(avg(${e}), 4) as text)`
      else {
        const inner = `${m.fn}(${e})`
        expr = field?.type === 'date' ? `to_char(${inner}, 'YYYY-MM-DD')` : `cast(${inner} as text)`
      }
      selectParts.push(`${expr} as ${quoteAlias(m.alias)}`)
      columns.push({ code: m.alias, label: m.alias, type: 'measure' })
      orderBy[m.alias] = quoteAlias(m.alias)
    }
  } else {
    for (const code of query.select) add(fields.get(code) as DatasetField)
  }
  const from = `${dataset.from} where ${where.join(' and ')}`
  const group = groupExprs.length ? ` group by ${groupExprs.join(', ')}` : ''
  let order: string
  if (query.sort.length) {
    order = query.sort.map((s) => `${orderBy[s.field]} ${s.dir}`).join(', ')
  } else if (aggregated) {
    order = groupExprs.length ? groupExprs.join(', ') : '1'
  } else order = dataset.defaultSort
  const limit = bind(page.limit)
  const offset = bind(page.offset)
  const sql = `select ${selectParts.join(', ')} from ${from}${group} order by ${order} limit ${limit} offset ${offset}`
  const countSql =
    aggregated && groupExprs.length === 0
      ? 'select cast(1 as int) as total'
      : `select cast(count(*) as int) as total from (select 1 from ${from}${group}) g`
  return { sql, countSql, bindings, columns }
}

// --- CSV --------------------------------------------------------------------------------------------

/**
 * Neutraliza células que uma folha de cálculo executaria como fórmula (`=`, `+`, `-`, `@`, tabulação, retorno de carro):
 * prefixa-as com apóstrofo. Números negativos legítimos (`-12.50`) mantêm-se: são valores, não fórmulas.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text) && !/^-\d+(\.\d+)?$/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const csvLine = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`

// --- painéis ----------------------------------------------------------------------------------------

export const WIDGET_TYPES = ['KPI', 'TABLE', 'BAR', 'LINE', 'PIE'] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]
export const MIN_REFRESH_SECONDS = 30

export interface WidgetInput {
  title: string
  type: WidgetType
  reportId: string
  layout: { x: number; y: number; w: number; h: number }
  filters: unknown[]
  refreshSeconds: number
}

export function normalizeWidget(raw: Record<string, unknown>): {
  value?: WidgetInput
  issues: Issue[]
} {
  const issues: Issue[] = []
  const title = typeof raw['title'] === 'string' ? raw['title'].trim() : ''
  if (!title || title.length > 160)
    issues.push(issue('title', 'REQUIRED', 'Indique o título (até 160 caracteres).'))
  if (!(WIDGET_TYPES as readonly unknown[]).includes(raw['type'])) {
    issues.push(issue('type', 'INVALID', 'Tipo de widget inválido.'))
  }
  if (typeof raw['reportId'] !== 'string')
    issues.push(issue('reportId', 'REQUIRED', 'Indique o relatório.'))
  const refresh = raw['refreshSeconds'] === undefined ? 300 : raw['refreshSeconds']
  if (
    typeof refresh !== 'number' ||
    !Number.isInteger(refresh) ||
    refresh < MIN_REFRESH_SECONDS ||
    refresh > 86400
  ) {
    issues.push(
      issue(
        'refreshSeconds',
        'INVALID',
        `A actualização é de ${MIN_REFRESH_SECONDS} a 86400 segundos.`
      )
    )
  }
  const l = (raw['layout'] ?? {}) as Record<string, unknown>
  const dim = (key: string, min: number, max: number, fallback: number) => {
    const v = l[key] === undefined ? fallback : l[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      issues.push(issue(`layout.${key}`, 'INVALID', `Valor de ${key} entre ${min} e ${max}.`))
      return fallback
    }
    return v
  }
  const layout = {
    x: dim('x', 0, 11, 0),
    y: dim('y', 0, 200, 0),
    w: dim('w', 1, 12, 6),
    h: dim('h', 1, 12, 4),
  }
  const filters = Array.isArray(raw['filters']) ? raw['filters'] : []
  if (issues.length) return { issues }
  return {
    value: {
      title,
      type: raw['type'] as WidgetType,
      reportId: raw['reportId'] as string,
      layout,
      filters,
      refreshSeconds: refresh as number,
    },
    issues,
  }
}

/**
 * Filtros globais de um painel num widget: só se aplicam os campos que o dataset do widget conhece; os outros ficam
 * de fora e são devolvidos para o painel dizer que não se aplicaram (nunca falham em silêncio).
 */
export function applyGlobalFilters(
  dataset: DatasetDefinition,
  widgetFilters: readonly Filter[],
  globalFilters: readonly Filter[]
): { filters: Filter[]; ignored: Filter[] } {
  const known = new Set(dataset.fields.map((f) => f.code))
  const applied = globalFilters.filter((f) => known.has(f.field))
  return {
    filters: [...widgetFilters, ...applied],
    ignored: globalFilters.filter((f) => !known.has(f.field)),
  }
}

// --- pesquisa ---------------------------------------------------------------------------------------

/** Excerto à volta da primeira ocorrência de um termo, em texto simples (o cliente escapa ao apresentar). */
export function snippetOf(text: string, terms: readonly string[], radius = 60): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return text.slice(0, radius * 2).trim()
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

export function searchTerms(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6)
}
