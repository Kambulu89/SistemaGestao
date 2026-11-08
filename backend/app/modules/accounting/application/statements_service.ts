import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { tenantSettings } from '#modules/settings/index'
import { optional, text, UUID } from '#modules/accounting/application/references'
import { formatDecimal, parseDecimal } from '#modules/accounting/domain/decimal'
import {
  computeLines,
  lineFor,
  type Mapping,
  PROFIT_NATURES,
  SCOPE,
  STATEMENT_KINDS,
  type StatementKind,
  type TemplateLine,
  validateTemplate,
} from '#modules/accounting/domain/statements'

/**
 * Demonstrações financeiras (6.8). Modelos versionados por plano de contas (rascunho → publicado → retirado; o
 * publicado não muda) e demonstrações calculadas a pedido a partir dos lançamentos contabilizados, com verificação:
 * contas com saldo sem linha ("não mapeadas") e igualdade das linhas de controlo (p. ex. activo = passivo + capital).
 */
const CODE = /^[A-Za-z0-9._-]{1,30}$/

interface TemplateRow {
  id: string
  version: number
  chart_id: string
  code: string
  name: string
  kind: StatementKind
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'
  check_a: string | null
  check_b: string | null
  published_at: string | null
}

const signed = (v: string, scale: number) => {
  const neg = v.startsWith('-')
  const x = parseDecimal(neg ? v.slice(1) : v, scale)!
  return neg ? -x : x
}

async function loadTemplate(scope: TenantScope, id: string, lock = false) {
  if (!UUID.test(id)) return null
  const r = await scope.trx.rawQuery(
    `select id, template_version as version, chart_id, code, name, kind, status, check_a, check_b, published_at
       from statement_templates where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as TemplateRow | undefined) ?? null
}

async function linesOf(scope: TenantScope, templateId: string): Promise<TemplateLine[]> {
  const r = await scope.trx.rawQuery(
    `select line_no as "lineNo", code, label, kind, sign, formula, note_ref as "noteRef"
       from statement_template_lines where tenant_id = ? and template_id = ? order by line_no`,
    [scope.context.tenantId, templateId]
  )
  return r.rows as TemplateLine[]
}

async function mappingsOf(scope: TenantScope, templateId: string): Promise<Mapping[]> {
  const r = await scope.trx.rawQuery(
    `select line_code as "lineCode", account_prefix as prefix, balance_rule as rule
       from statement_template_mappings where tenant_id = ? and template_id = ? order by line_code, account_prefix`,
    [scope.context.tenantId, templateId]
  )
  return r.rows as Mapping[]
}

async function view(scope: TenantScope, t: TemplateRow) {
  return {
    id: t.id,
    version: t.version,
    chartId: t.chart_id,
    code: t.code,
    name: t.name,
    kind: t.kind,
    status: t.status,
    checkA: t.check_a,
    checkB: t.check_b,
    publishedAt: t.published_at,
    lines: await linesOf(scope, t.id),
    mappings: await mappingsOf(scope, t.id),
  }
}

/** Normaliza linhas e mapeamentos vindos da API (os mapeamentos também podem vir dentro de cada linha). */
function normalize(input: Record<string, unknown>) {
  const rawLines = Array.isArray(input.lines) ? input.lines : []
  const lines: TemplateLine[] = rawLines.slice(0, 300).map((l: any, i: number) => ({
    lineNo: i + 1,
    code: text(l?.code) || null,
    label: text(l?.label),
    kind: l?.kind,
    sign: Number(l?.sign) === -1 ? -1 : 1,
    formula: text(l?.formula) || null,
    noteRef: optional(l?.noteRef, 20),
  }))
  const mappings: Mapping[] = []
  for (const l of rawLines as any[])
    for (const m of Array.isArray(l?.mappings) ? l.mappings : [])
      mappings.push({ lineCode: text(l?.code), prefix: text(m?.prefix), rule: m?.rule ?? 'ANY' })
  return { lines, mappings, count: rawLines.length }
}

function checkIssues(
  kind: StatementKind,
  lines: TemplateLine[],
  a: string | null,
  b: string | null
): ErrorDetail[] {
  const codes = new Set(lines.map((l) => l.code).filter(Boolean))
  const issues: ErrorDetail[] = []
  if (a && !codes.has(a))
    issues.push({ path: 'checkA', code: 'UNKNOWN_LINE', message: `A linha ${a} não existe.` })
  if (b && !codes.has(b))
    issues.push({ path: 'checkB', code: 'UNKNOWN_LINE', message: `A linha ${b} não existe.` })
  if (b && !a) issues.push({ path: 'checkA', code: 'REQUIRED', message: 'Indique as duas linhas.' })
  if (kind === 'BALANCE_SHEET' && a && !b)
    issues.push({ path: 'checkB', code: 'REQUIRED', message: 'O balanço compara duas linhas.' })
  return issues
}

async function writeContent(
  scope: TenantScope,
  templateId: string,
  lines: TemplateLine[],
  mappings: Mapping[]
) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  await scope.trx.rawQuery(
    'delete from statement_template_lines where tenant_id = ? and template_id = ?',
    [t, templateId]
  )
  await scope.trx.rawQuery(
    'delete from statement_template_mappings where tenant_id = ? and template_id = ?',
    [t, templateId]
  )
  for (const l of lines)
    await scope.trx.rawQuery(
      `insert into statement_template_lines (tenant_id, created_by, updated_by, template_id, line_no, code, label, kind, sign, formula, note_ref)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        u,
        u,
        templateId,
        l.lineNo,
        l.code,
        l.label,
        l.kind,
        l.sign,
        l.formula,
        l.noteRef,
      ] as never[]
    )
  for (const m of mappings)
    await scope.trx.rawQuery(
      `insert into statement_template_mappings (tenant_id, created_by, updated_by, template_id, line_code, account_prefix, balance_rule)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [t, u, u, templateId, m.lineCode, m.prefix, m.rule]
    )
}

async function guardedInsert<T>(scope: TenantScope, fn: () => Promise<T>) {
  await scope.trx.rawQuery('savepoint stmt_tpl')
  try {
    const r = await fn()
    await scope.trx.rawQuery('release savepoint stmt_tpl')
    return r
  } catch (error) {
    const c = constraintOf(error)
    if (c === 'statement_templates_one_draft' || c === 'statement_templates_version_unique') {
      await scope.trx.rawQuery('rollback to savepoint stmt_tpl')
      throw ApiError.conflict(
        'DRAFT_EXISTS',
        'Já existe um modelo com este código em rascunho (ou esta versão) neste plano.'
      )
    }
    throw error
  }
}

export class StatementTemplateService {
  list(context: TenantContext, q: { chartId?: string; kind?: string; status?: string }) {
    return runInTenant(context, async (scope) => {
      const where = ['tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (q.chartId) (where.push('chart_id = ?'), params.push(q.chartId))
      if (q.kind) (where.push('kind = ?'), params.push(q.kind))
      if (q.status) (where.push('status = ?'), params.push(q.status))
      const r = await scope.trx.rawQuery(
        `select id, template_version as version, chart_id as "chartId", code, name, kind, status, published_at as "publishedAt"
           from statement_templates where ${where.join(' and ')} order by code, template_version desc limit 500`,
        params as never[]
      )
      return r.rows
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const t = await loadTemplate(scope, id)
      if (!t) throw ApiError.notFound()
      return view(scope, t)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const issues: ErrorDetail[] = []
      const chartId = text(input.chartId)
      const chart = UUID.test(chartId)
        ? (
            await scope.trx.rawQuery(
              'select id from account_charts where tenant_id = ? and id = ?',
              [context.tenantId, chartId]
            )
          ).rows[0]
        : null
      if (!chart) issues.push({ path: 'chartId', code: 'NOT_FOUND', message: 'Plano de contas.' })
      const code = text(input.code)
      if (!CODE.test(code))
        issues.push({ path: 'code', code: 'INVALID', message: 'Código: até 30 caracteres.' })
      const kind = input.kind as StatementKind
      if (!STATEMENT_KINDS.includes(kind))
        issues.push({
          path: 'kind',
          code: 'INVALID',
          message: 'Balanço ou demonstração de resultados.',
        })
      if (text(input.name).length < 2)
        issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 160 caracteres.' })
      const { lines, mappings, count } = normalize(input)
      if (count > 300)
        issues.push({ path: 'lines', code: 'TOO_MANY', message: 'No máximo 300 linhas.' })
      if (STATEMENT_KINDS.includes(kind)) {
        issues.push(...validateTemplate(kind, lines, mappings))
        issues.push(
          ...checkIssues(kind, lines, text(input.checkA) || null, text(input.checkB) || null)
        )
      }
      if (issues.length) throw ApiError.validation(issues)
      const existing = await scope.trx.rawQuery(
        'select 1 from statement_templates where tenant_id = ? and chart_id = ? and code = ? limit 1',
        [context.tenantId, chartId, code]
      )
      if (existing.rows.length)
        throw ApiError.conflict(
          'TEMPLATE_CODE_TAKEN',
          'Já existe um modelo com este código neste plano: crie uma nova versão.'
        )
      const id = await guardedInsert(scope, async () => {
        const r = await scope.trx.rawQuery(
          `insert into statement_templates (tenant_id, created_by, updated_by, chart_id, code, template_version, name, kind, check_a, check_b)
           values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            context.userId,
            context.userId,
            chartId,
            code,
            text(input.name).slice(0, 160),
            kind,
            text(input.checkA) || null,
            text(input.checkB) || null,
          ] as never[]
        )
        return (r.rows[0] as { id: string }).id
      })
      await writeContent(scope, id, lines, mappings)
      await audit(scope, {
        action: 'statement_template.created',
        entityType: 'statement_template',
        entityId: id,
        metadata: { code, kind, lines: lines.length, mappings: mappings.length },
      })
      return view(scope, (await loadTemplate(scope, id))!)
    })
  }

  /** Só rascunhos mudam; as linhas e os mapeamentos são substituídos de uma vez. */
  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const t = await loadTemplate(scope, id, true)
      if (!t) throw ApiError.notFound()
      if (t.status !== 'DRAFT')
        throw ApiError.conflict('NOT_DRAFT', 'Um modelo publicado não muda: crie uma nova versão.')
      const issues: ErrorDetail[] = []
      const name = input.name === undefined ? t.name : text(input.name)
      if (name.length < 2)
        issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 160 caracteres.' })
      const content = input.lines !== undefined ? normalize(input) : null
      const lines = content?.lines ?? (await linesOf(scope, t.id))
      const mappings = content?.mappings ?? (await mappingsOf(scope, t.id))
      const a = input.checkA === undefined ? t.check_a : text(input.checkA) || null
      const b = input.checkB === undefined ? t.check_b : text(input.checkB) || null
      issues.push(...validateTemplate(t.kind, lines, mappings), ...checkIssues(t.kind, lines, a, b))
      if (issues.length) throw ApiError.validation(issues)
      await scope.trx.rawQuery(
        `update statement_templates set name = ?, check_a = ?, check_b = ?, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [name.slice(0, 160), a, b, context.userId, context.tenantId, t.id] as never[]
      )
      if (content) await writeContent(scope, t.id, lines, mappings)
      await audit(scope, {
        action: 'statement_template.updated',
        entityType: 'statement_template',
        entityId: t.id,
        metadata: { version: t.version, lines: lines.length, mappings: mappings.length },
      })
      return view(scope, (await loadTemplate(scope, t.id))!)
    })
  }

  /** Publica o rascunho (validado de novo) e retira a versão publicada anterior do mesmo código. */
  publish(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const t = await loadTemplate(scope, id, true)
      if (!t) throw ApiError.notFound()
      if (t.status !== 'DRAFT') throw ApiError.conflict('NOT_DRAFT', 'Só um rascunho se publica.')
      const lines = await linesOf(scope, t.id)
      const mappings = await mappingsOf(scope, t.id)
      const issues = [
        ...validateTemplate(t.kind, lines, mappings),
        ...checkIssues(t.kind, lines, t.check_a, t.check_b),
      ]
      if (lines.length === 0)
        issues.push({ path: 'lines', code: 'REQUIRED', message: 'O modelo não tem linhas.' })
      if (issues.length) throw ApiError.validation(issues)
      const previous = await scope.trx.rawQuery(
        `update statement_templates set status = 'RETIRED', updated_by = ?, updated_at = now()
          where tenant_id = ? and chart_id = ? and code = ? and status = 'PUBLISHED' returning template_version as version`,
        [context.userId, context.tenantId, t.chart_id, t.code]
      )
      await scope.trx.rawQuery(
        `update statement_templates set status = 'PUBLISHED', published_at = now(), updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, t.id]
      )
      await audit(scope, {
        action: 'statement_template.published',
        entityType: 'statement_template',
        entityId: t.id,
        metadata: {
          code: t.code,
          version: t.version,
          retired: (previous.rows as { version: number }[]).map((r) => r.version),
        },
      })
      return view(scope, (await loadTemplate(scope, t.id))!)
    })
  }

  /** Nova versão (rascunho) a partir desta, com as mesmas linhas e mapeamentos. */
  newVersion(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const t = await loadTemplate(scope, id, true)
      if (!t) throw ApiError.notFound()
      if (t.status === 'DRAFT')
        throw ApiError.conflict('IS_DRAFT', 'Este modelo já é um rascunho: altere-o directamente.')
      const max = await scope.trx.rawQuery(
        'select max(template_version)::int as v from statement_templates where tenant_id = ? and chart_id = ? and code = ?',
        [context.tenantId, t.chart_id, t.code]
      )
      const version = (max.rows[0] as { v: number }).v + 1
      const newId = await guardedInsert(scope, async () => {
        const r = await scope.trx.rawQuery(
          `insert into statement_templates (tenant_id, created_by, updated_by, chart_id, code, template_version, name, kind, check_a, check_b)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            context.userId,
            context.userId,
            t.chart_id,
            t.code,
            version,
            t.name,
            t.kind,
            t.check_a,
            t.check_b,
          ] as never[]
        )
        return (r.rows[0] as { id: string }).id
      })
      await writeContent(scope, newId, await linesOf(scope, t.id), await mappingsOf(scope, t.id))
      await audit(scope, {
        action: 'statement_template.versioned',
        entityType: 'statement_template',
        entityId: newId,
        metadata: { from: t.version, version },
      })
      return view(scope, (await loadTemplate(scope, newId))!)
    })
  }

  remove(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const t = await loadTemplate(scope, id, true)
      if (!t) throw ApiError.notFound()
      if (t.status !== 'DRAFT')
        throw ApiError.conflict(
          'NOT_DRAFT',
          'Só rascunhos se apagam; os publicados ficam no histórico.'
        )
      await scope.trx.rawQuery('delete from statement_templates where tenant_id = ? and id = ?', [
        context.tenantId,
        t.id,
      ])
      await audit(scope, {
        action: 'statement_template.deleted',
        entityType: 'statement_template',
        entityId: t.id,
        metadata: { code: t.code, version: t.version },
      })
    })
  }
}

// ---------------------------------------------------------------- cálculo

interface Year {
  id: string
  legal_entity_id: string
  code: string
  start_date: string
  end_date: string
}

async function yearOf(scope: TenantScope, id: string) {
  if (!UUID.test(id)) return null
  const r = await scope.trx.rawQuery(
    `select id, legal_entity_id, code, start_date::text as start_date, end_date::text as end_date
       from fiscal_years where tenant_id = ? and id = ?`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as Year | undefined) ?? null
}

/** Saldos contabilizados (débito − crédito, moeda funcional) por conta, no intervalo de períodos da demonstração. */
async function balances(
  scope: TenantScope,
  year: Year,
  kind: StatementKind,
  toPeriod: number,
  scale: number
) {
  const r = await scope.trx.rawQuery(
    `select a.id, a.code, a.name, a.nature, a.chart_id,
            round(sum(l.debit_functional - l.credit_functional), ?::int)::text as balance
       from journal_lines l
       join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
       join fiscal_periods p on p.tenant_id = e.tenant_id and p.id = e.period_id
       join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ? and e.fiscal_year_id = ? and e.status = 'POSTED' and p.number <= ?
        ${kind === 'INCOME_STATEMENT' ? `and p.kind = 'NORMAL'` : ''}
      group by a.id`,
    [scale, scope.context.tenantId, year.id, toPeriod]
  )
  return (
    r.rows as {
      id: string
      code: string
      name: string
      nature: string
      chart_id: string
      balance: string
    }[]
  )
    .map((x) => ({ ...x, value: signed(x.balance, scale) }))
    .filter((x) => x.value !== 0n)
}

async function compute(
  scope: TenantScope,
  t: TemplateRow,
  lines: TemplateLine[],
  mappings: Mapping[],
  year: Year,
  toPeriod: number,
  scale: number
) {
  const all = await balances(scope, year, t.kind, toPeriod, scale)
  const inScope = all.filter((a) => SCOPE[t.kind].includes(a.nature))
  const raw = new Map<string, bigint>()
  const detail = new Map<string, { code: string; name: string; amount: bigint }[]>()
  const unmapped: { code: string; name: string; balance: bigint }[] = []
  for (const a of inScope) {
    const line = a.chart_id === t.chart_id ? lineFor(a.code, a.value, mappings) : null
    if (!line) {
      unmapped.push({ code: a.code, name: a.name, balance: a.value })
      continue
    }
    raw.set(line, (raw.get(line) ?? 0n) + a.value)
    if (!detail.has(line)) detail.set(line, [])
    detail.get(line)!.push({ code: a.code, name: a.name, amount: a.value })
  }
  const profitRaw = all
    .filter((a) => PROFIT_NATURES.includes(a.nature))
    .reduce((s, a) => s + a.value, 0n)
  const hasNetIncome = lines.some((l) => l.kind === 'NET_INCOME')
  if (t.kind === 'BALANCE_SHEET' && !hasNetIncome && profitRaw !== 0n)
    unmapped.push({
      code: '—',
      name: 'Resultado do período (sem linha de resultado líquido)',
      balance: profitRaw,
    })
  const values = computeLines(lines, raw, profitRaw)
  return {
    values,
    detail,
    unmapped,
    profitRaw,
    inScopeTotal: inScope.reduce((s, a) => s + a.value, 0n),
  }
}

export interface StatementQuery {
  templateId: string
  fiscalYearId: string
  toPeriod?: number
  compareFiscalYearId?: string
}

export class StatementService {
  /**
   * Demonstração de um exercício (até um período) com coluna comparativa opcional. Confere quando não há contas com
   * saldo sem linha e as linhas de controlo coincidem (balanço: as duas linhas; resultados: a linha indicada e o
   * resultado do razão).
   */
  generate(context: TenantContext, q: StatementQuery) {
    return runInTenant(context, async (scope) => {
      const t = await loadTemplate(scope, q.templateId)
      const year = await yearOf(scope, q.fiscalYearId)
      if (!t || !year) throw ApiError.notFound()
      const chart = await scope.trx.rawQuery(
        'select legal_entity_id from account_charts where tenant_id = ? and id = ?',
        [context.tenantId, t.chart_id]
      )
      const chartEntity = (chart.rows[0] as { legal_entity_id: string }).legal_entity_id
      const compare = q.compareFiscalYearId ? await yearOf(scope, q.compareFiscalYearId) : null
      if (q.compareFiscalYearId && !compare) throw ApiError.notFound()
      const issues: ErrorDetail[] = []
      if (year.legal_entity_id !== chartEntity)
        issues.push({
          path: 'fiscalYearId',
          code: 'OTHER_ENTITY',
          message: 'O exercício é de outra entidade legal.',
        })
      if (compare && compare.legal_entity_id !== chartEntity)
        issues.push({
          path: 'compareFiscalYearId',
          code: 'OTHER_ENTITY',
          message: 'O exercício comparativo é de outra entidade.',
        })
      if (issues.length) throw ApiError.validation(issues)
      const scale = (await tenantSettings(scope)).amountScale
      const lines = await linesOf(scope, t.id)
      const mappings = await mappingsOf(scope, t.id)
      const maxPeriod = async (y: Year) =>
        (
          (
            await scope.trx.rawQuery(
              'select max(number)::int as n from fiscal_periods where tenant_id = ? and fiscal_year_id = ?',
              [context.tenantId, y.id]
            )
          ).rows[0] as { n: number }
        ).n
      const toPeriod = q.toPeriod ?? (await maxPeriod(year))
      const current = await compute(scope, t, lines, mappings, year, toPeriod, scale)
      const previous = compare
        ? await compute(scope, t, lines, mappings, compare, await maxPeriod(compare), scale)
        : null
      const m = (v: bigint) => formatDecimal(v, scale)
      const checkFor = (c: typeof current) => {
        if (t.kind === 'BALANCE_SHEET' && t.check_a && t.check_b) {
          const a = c.values.get(t.check_a) ?? 0n
          const b = c.values.get(t.check_b) ?? 0n
          return { a: m(a), b: m(b), ok: a === b }
        }
        if (t.kind === 'INCOME_STATEMENT' && t.check_a) {
          const a = c.values.get(t.check_a) ?? 0n
          const ledger = -c.profitRaw
          return { a: m(a), b: m(ledger), ok: a === ledger }
        }
        return null
      }
      const check = checkFor(current)
      const notes = await scope.trx.rawQuery(
        `select id, number, title, body from statement_notes where tenant_id = ? and fiscal_year_id = ? order by number`,
        [context.tenantId, year.id]
      )
      return {
        template: {
          id: t.id,
          code: t.code,
          name: t.name,
          kind: t.kind,
          version: t.version,
          status: t.status,
        },
        fiscalYear: { id: year.id, code: year.code, toPeriod },
        compareFiscalYear: compare ? { id: compare.id, code: compare.code } : null,
        lines: lines.map((l) => ({
          lineNo: l.lineNo,
          code: l.code,
          label: l.label,
          kind: l.kind,
          noteRef: l.noteRef,
          value: l.code ? m(current.values.get(l.code) ?? 0n) : null,
          previous: l.code && previous ? m(previous.values.get(l.code) ?? 0n) : null,
          accounts:
            l.kind === 'ACCOUNTS' && l.code
              ? (current.detail.get(l.code) ?? []).map((a) => ({
                  code: a.code,
                  name: a.name,
                  amount: m(a.amount * BigInt(l.sign)),
                }))
              : [],
        })),
        unmapped: current.unmapped.map((u) => ({
          code: u.code,
          name: u.name,
          balance: m(u.balance),
        })),
        previousUnmapped: previous?.unmapped.length ?? 0,
        netIncome: m(-current.profitRaw),
        check,
        consistent: current.unmapped.length === 0 && (check?.ok ?? true),
        notes: notes.rows,
      }
    })
  }
}

// ---------------------------------------------------------------- notas

export class StatementNoteService {
  list(context: TenantContext, fiscalYearId: string) {
    return runInTenant(context, async (scope) => {
      if (!(await yearOf(scope, fiscalYearId))) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `select id, version, number, title, body, updated_at as "updatedAt" from statement_notes
          where tenant_id = ? and fiscal_year_id = ? order by number`,
        [context.tenantId, fiscalYearId]
      )
      return r.rows
    })
  }

  save(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const issues: ErrorDetail[] = []
      const current = id
        ? ((
            await scope.trx.rawQuery(
              'select id, version, fiscal_year_id from statement_notes where tenant_id = ? and id = ? for update',
              [context.tenantId, UUID.test(id) ? id : null] as never[]
            )
          ).rows[0] as { id: string; version: number; fiscal_year_id: string } | undefined)
        : undefined
      if (id && !current) throw ApiError.notFound()
      if (current && Number(input.expectedVersion) !== current.version)
        throw ApiError.versionConflict(current.version)
      const fiscalYearId = current ? current.fiscal_year_id : text(input.fiscalYearId)
      if (!current && !(await yearOf(scope, fiscalYearId)))
        issues.push({ path: 'fiscalYearId', code: 'NOT_FOUND', message: 'Exercício.' })
      const number = Number(input.number)
      if (!Number.isInteger(number) || number < 1 || number > 999)
        issues.push({ path: 'number', code: 'INVALID', message: 'Número da nota (1 a 999).' })
      if (text(input.title).length < 2)
        issues.push({ path: 'title', code: 'REQUIRED', message: 'Título da nota.' })
      if (text(input.body).length < 1 || text(input.body).length > 20000)
        issues.push({
          path: 'body',
          code: 'REQUIRED',
          message: 'Texto da nota (até 20 000 caracteres).',
        })
      if (issues.length) throw ApiError.validation(issues)
      await scope.trx.rawQuery('savepoint stmt_note')
      try {
        const r = current
          ? await scope.trx.rawQuery(
              `update statement_notes set number = ?, title = ?, body = ?, updated_by = ?, updated_at = now(),
                 version = version + 1 where tenant_id = ? and id = ? returning id`,
              [
                number,
                text(input.title).slice(0, 200),
                text(input.body),
                context.userId,
                context.tenantId,
                current.id,
              ]
            )
          : await scope.trx.rawQuery(
              `insert into statement_notes (tenant_id, created_by, updated_by, fiscal_year_id, number, title, body)
               values (?, ?, ?, ?, ?, ?, ?) returning id`,
              [
                context.tenantId,
                context.userId,
                context.userId,
                fiscalYearId,
                number,
                text(input.title).slice(0, 200),
                text(input.body),
              ]
            )
        await scope.trx.rawQuery('release savepoint stmt_note')
        const noteId = (r.rows[0] as { id: string }).id
        await audit(scope, {
          action: current ? 'statement_note.updated' : 'statement_note.created',
          entityType: 'statement_note',
          entityId: noteId,
          metadata: { fiscalYearId, number },
        })
        const out = await scope.trx.rawQuery(
          'select id, version, number, title, body from statement_notes where tenant_id = ? and id = ?',
          [context.tenantId, noteId]
        )
        return out.rows[0]
      } catch (error) {
        if (constraintOf(error) === 'statement_notes_number_unique') {
          await scope.trx.rawQuery('rollback to savepoint stmt_note')
          throw ApiError.conflict(
            'NOTE_NUMBER_TAKEN',
            `Já existe a nota ${number} neste exercício.`
          )
        }
        throw error
      }
    })
  }

  remove(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        'delete from statement_notes where tenant_id = ? and id = ? returning number, fiscal_year_id',
        [context.tenantId, UUID.test(id) ? id : null] as never[]
      )
      const row = r.rows[0] as { number: number; fiscal_year_id: string } | undefined
      if (!row) throw ApiError.notFound()
      await audit(scope, {
        action: 'statement_note.deleted',
        entityType: 'statement_note',
        entityId: id,
        metadata: { number: row.number, fiscalYearId: row.fiscal_year_id },
      })
    })
  }
}
