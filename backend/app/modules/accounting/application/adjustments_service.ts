import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import {
  crudFind,
  crudInsert,
  crudList,
  crudUpdate,
  type CrudSpec,
  type Row,
} from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit, diff } from '#modules/audit/index'
import { tenantSettings } from '#modules/settings/index'
import { crud } from '#modules/accounting/application/setup_service'
import { createEntryInScope } from '#modules/accounting/application/entries_service'
import {
  accountIssues,
  CODE,
  costCenterIssue,
  entryFacts,
  ISO,
  journalIssue,
  legalEntityExists,
  optional,
  text,
  UUID,
} from '#modules/accounting/application/references'
import {
  dueMonths,
  evenShare,
  FREQUENCIES,
  type Frequency,
  lastMonth,
  monthIndex,
  SCHEDULE_KINDS,
  type ScheduleKind,
} from '#modules/accounting/domain/adjustments'
import { formatDecimal, parseDecimal, rescale } from '#modules/accounting/domain/decimal'
import { isMonth, monthEnd } from '#modules/accounting/domain/fixed_assets'

/**
 * Regularizações (6.7) — planos e provisões. Os planos geram, mês a mês, lançamentos em rascunho de recorrências
 * (linhas fixas) e de acréscimos/diferimentos (um total repartido exactamente por N meses). As provisões registam
 * constituições, reversões e utilizações, cada uma com o seu rascunho, sem nunca reverter/utilizar mais do que o saldo.
 * Os rascunhos seguem a aprovação normal (quem gera não aprova); apagar um rascunho liberta o mês/movimento.
 */
const STORE = 6
const monthOf = (d: string) => d.slice(0, 7)

export const SCHEDULE_SPEC = {
  table: 'adjustment_schedules',
  columns: {
    legalEntityId: 'legal_entity_id',
    code: 'code',
    name: 'name',
    kind: 'kind',
    frequency: 'frequency',
    journalId: 'journal_id',
    startMonth: 'start_month',
    endMonth: 'end_month',
    months: 'months',
    totalAmount: 'total_amount',
    debitAccountId: 'debit_account_id',
    creditAccountId: 'credit_account_id',
    costCenterId: 'cost_center_id',
    description: 'description',
    status: 'status',
  },
  dateColumns: ['start_month', 'end_month'],
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    adjustment_schedules_code_unique: {
      code: 'SCHEDULE_CODE_TAKEN',
      message: 'Já existe um plano com este código nesta entidade.',
    },
  },
} satisfies CrudSpec

export const PROVISION_SPEC = {
  table: 'provisions',
  columns: {
    legalEntityId: 'legal_entity_id',
    code: 'code',
    name: 'name',
    description: 'description',
    journalId: 'journal_id',
    expenseAccountId: 'expense_account_id',
    provisionAccountId: 'provision_account_id',
    reversalAccountId: 'reversal_account_id',
    costCenterId: 'cost_center_id',
    status: 'status',
  },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    provisions_code_unique: {
      code: 'PROVISION_CODE_TAKEN',
      message: 'Já existe uma provisão com este código nesta entidade.',
    },
  },
} satisfies CrudSpec

interface ScheduleRow extends Row {
  legalEntityId: string
  code: string
  name: string
  kind: ScheduleKind
  frequency: Frequency
  journalId: string
  startMonth: string
  endMonth: string | null
  months: number | null
  totalAmount: string | null
  debitAccountId: string | null
  creditAccountId: string | null
  costCenterId: string | null
  description: string | null
  status: string
}

interface TemplateLine {
  accountId: string
  debit: bigint
  credit: bigint
  costCenterId: string | null
  thirdPartyRef: string | null
  description: string | null
}

const toScale = (v: string, scale: number) =>
  rescale(parseDecimal(v, STORE)!, STORE, scale, 'HALF_UP')

async function scaleOf(scope: TenantScope) {
  return (await tenantSettings(scope)).amountScale
}

function presentSchedule(s: Row, scale: number) {
  return {
    ...s,
    startMonth: typeof s.startMonth === 'string' ? monthOf(s.startMonth) : s.startMonth,
    endMonth: typeof s.endMonth === 'string' ? monthOf(s.endMonth) : null,
    totalAmount:
      typeof s.totalAmount === 'string'
        ? formatDecimal(toScale(s.totalAmount, scale), scale)
        : null,
  }
}

async function templateLines(scope: TenantScope, scheduleId: string): Promise<TemplateLine[]> {
  const r = await scope.trx.rawQuery(
    `select account_id, debit::text as debit, credit::text as credit, cost_center_id, third_party_ref, description
       from adjustment_schedule_lines where tenant_id = ? and schedule_id = ? order by line_no`,
    [scope.context.tenantId, scheduleId]
  )
  return (r.rows as Record<string, string | null>[]).map((l) => ({
    accountId: l.account_id!,
    debit: parseDecimal(l.debit, STORE)!,
    credit: parseDecimal(l.credit, STORE)!,
    costCenterId: l.cost_center_id,
    thirdPartyRef: l.third_party_ref,
    description: l.description,
  }))
}

async function occurrences(scope: TenantScope, scheduleIds: string[]) {
  if (scheduleIds.length === 0) return []
  const r = await scope.trx.rawQuery(
    `select schedule_id as "scheduleId", to_char(month, 'YYYY-MM') as month, amount::text as amount, entry_id as "entryId"
       from adjustment_occurrences where tenant_id = ? and schedule_id = any(?::uuid[]) order by month`,
    [scope.context.tenantId, scheduleIds]
  )
  return r.rows as { scheduleId: string; month: string; amount: string; entryId: string }[]
}

/** Linhas do rascunho de um mês do plano (montantes na escala da empresa). */
function linesFor(s: ScheduleRow, template: TemplateLine[], month: string, scale: number) {
  const money = (v: bigint) => formatDecimal(v, scale)
  if (s.kind === 'RECURRING') {
    const lines = template.map((l) => ({
      accountId: l.accountId,
      debit: l.debit > 0n ? money(rescale(l.debit, STORE, scale, 'HALF_UP')) : null,
      credit: l.credit > 0n ? money(rescale(l.credit, STORE, scale, 'HALF_UP')) : null,
      costCenterId: l.costCenterId,
      thirdPartyRef: l.thirdPartyRef,
      description: l.description,
    }))
    const total = template.reduce((a, l) => a + rescale(l.debit, STORE, scale, 'HALF_UP'), 0n)
    return { lines, total }
  }
  const total = toScale(s.totalAmount!, scale)
  const share = evenShare(total, s.months!, monthIndex(s.startMonth, month))
  const description = `${s.name} (${monthIndex(s.startMonth, month)}/${s.months})`.slice(0, 300)
  return {
    total: share,
    lines: [
      {
        accountId: s.debitAccountId,
        debit: money(share),
        credit: null,
        costCenterId: s.costCenterId,
        description,
      },
      {
        accountId: s.creditAccountId,
        debit: null,
        credit: money(share),
        costCenterId: s.costCenterId,
        description,
      },
    ],
  }
}

/** Linhas de uma recorrência: 2 a 50, equilibradas, um só lado por linha. */
async function validateTemplate(
  scope: TenantScope,
  legalEntityId: string,
  raw: unknown,
  scale: number
) {
  const issues: ErrorDetail[] = []
  const lines: TemplateLine[] = []
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 50) {
    issues.push({ path: 'lines', code: 'MIN_LINES', message: 'Entre 2 e 50 linhas.' })
    return { issues, lines }
  }
  issues.push(
    ...(await accountIssues(
      scope,
      legalEntityId,
      raw.map((l: any) => l?.accountId),
      raw.map((_, i) => `lines.${i}.accountId`)
    ))
  )
  for (const [i, l] of (raw as any[]).entries()) {
    const debit = l?.debit ? parseDecimal(l.debit, scale) : 0n
    const credit = l?.credit ? parseDecimal(l.credit, scale) : 0n
    if (debit === null || credit === null || debit > 0n === credit > 0n)
      issues.push({
        path: `lines.${i}`,
        code: 'ONE_SIDE',
        message: `Débito ou crédito (positivo, até ${scale} casas), nunca os dois.`,
      })
    const cc = await costCenterIssue(
      scope,
      legalEntityId,
      l?.costCenterId,
      `lines.${i}.costCenterId`
    )
    if (cc) issues.push(cc)
    lines.push({
      accountId: text(l?.accountId),
      debit: rescale(debit ?? 0n, scale, STORE, 'HALF_UP'),
      credit: rescale(credit ?? 0n, scale, STORE, 'HALF_UP'),
      costCenterId: text(l?.costCenterId) || null,
      thirdPartyRef: optional(l?.thirdPartyRef, 60),
      description: optional(l?.description, 300),
    })
  }
  const d = lines.reduce((a, l) => a + l.debit, 0n)
  const c = lines.reduce((a, l) => a + l.credit, 0n)
  if (issues.length === 0 && d !== c)
    issues.push({
      path: 'lines',
      code: 'UNBALANCED',
      message: 'Débitos e créditos têm de ser iguais.',
    })
  return { issues, lines }
}

export class AdjustmentScheduleService {
  list(
    context: TenantContext,
    filter: { equals: Record<string, unknown>; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const scale = await scaleOf(scope)
      const page = await crudList(crud(context, scope.trx), SCHEDULE_SPEC, filter)
      return { ...page, items: page.items.map((s) => presentSchedule(s, scale)) }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const s = await crudFind(crud(context, scope.trx), SCHEDULE_SPEC, id)
      if (!s) throw ApiError.notFound()
      return detail(scope, s as ScheduleRow)
    })
  }

  /**
   * Plano. Com meses já gerados, um acréscimo/diferimento deixa de mudar valores, meses e contas (a repartição tem de
   * continuar exacta); numa recorrência, as linhas novas valem para os meses seguintes.
   */
  save(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const scale = await scaleOf(scope)
      const current = id
        ? ((await crudFind(s, SCHEDULE_SPEC, id, true)) as ScheduleRow | null)
        : null
      if (id && !current) throw ApiError.notFound()
      if (current && Number(input.expectedVersion) !== current.version)
        throw ApiError.versionConflict(current.version)
      const issues: ErrorDetail[] = []
      const values: Record<string, unknown> = {}
      const has = (k: string) => input[k] !== undefined || !current
      const used = current ? (await occurrences(scope, [current.id])).length > 0 : false
      const legalEntityId = current ? current.legalEntityId : text(input.legalEntityId)
      if (!current) {
        if (!(await legalEntityExists(scope, legalEntityId)))
          issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade legal.' })
        values.legalEntityId = legalEntityId
        if (!CODE.test(text(input.code)))
          issues.push({ path: 'code', code: 'INVALID', message: 'Código: até 30 caracteres.' })
        values.code = text(input.code)
      }
      const kind = (current?.kind ?? input.kind) as ScheduleKind
      if (!current) {
        if (!SCHEDULE_KINDS.includes(kind))
          issues.push({
            path: 'kind',
            code: 'INVALID',
            message: 'Recorrência, acréscimo ou diferimento.',
          })
        values.kind = kind
      }
      const locked = used && kind !== 'RECURRING'
      const frozen = (k: string) => {
        if (locked && input[k] !== undefined)
          issues.push({
            path: k,
            code: 'IN_USE',
            message: 'Já há meses gerados: este dado do acréscimo/diferimento já não muda.',
          })
        return locked
      }
      if (has('name')) {
        if (text(input.name).length < 2)
          issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 160 caracteres.' })
        values.name = text(input.name).slice(0, 160)
      }
      if (input.description !== undefined) values.description = optional(input.description, 300)
      if (has('journalId')) {
        const issue = legalEntityId
          ? await journalIssue(scope, legalEntityId, input.journalId)
          : null
        if (issue) issues.push(issue)
        values.journalId = text(input.journalId)
      }
      const start = has('startMonth')
        ? text(input.startMonth).slice(0, 7)
        : monthOf(current!.startMonth)
      if (has('startMonth')) {
        if (used && input.startMonth !== undefined)
          issues.push({
            path: 'startMonth',
            code: 'IN_USE',
            message: 'Já há meses gerados: o início já não muda.',
          })
        else if (!isMonth(start))
          issues.push({ path: 'startMonth', code: 'INVALID', message: 'Primeiro mês (AAAA-MM).' })
        else values.startMonth = `${start}-01`
      }
      if (input.status !== undefined) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
        values.status = input.status
      }
      let template: TemplateLine[] | null = null
      if (kind === 'RECURRING') {
        if (has('frequency')) {
          const f = input.frequency ?? 'MONTHLY'
          if (!FREQUENCIES.includes(f as Frequency))
            issues.push({
              path: 'frequency',
              code: 'INVALID',
              message: 'Mensal, trimestral ou anual.',
            })
          else if (used && current && f !== current.frequency)
            issues.push({ path: 'frequency', code: 'IN_USE', message: 'Já há meses gerados.' })
          values.frequency = f
        }
        if (input.endMonth !== undefined) {
          const end = text(input.endMonth).slice(0, 7)
          if (end && (!isMonth(end) || end < start))
            issues.push({
              path: 'endMonth',
              code: 'INVALID',
              message: 'Último mês igual ou posterior ao primeiro.',
            })
          values.endMonth = end ? `${end}-01` : null
        }
        if (has('lines')) {
          const v = await validateTemplate(scope, legalEntityId, input.lines, scale)
          issues.push(...v.issues)
          template = v.lines
        }
      } else if (kind) {
        if (has('months') && !frozen('months')) {
          if (
            !Number.isInteger(input.months) ||
            (input.months as number) < 1 ||
            (input.months as number) > 600
          )
            issues.push({ path: 'months', code: 'INVALID', message: 'N.º de meses (1 a 600).' })
          values.months = input.months
        }
        if (has('totalAmount') && !frozen('totalAmount')) {
          const total = parseDecimal(input.totalAmount, scale)
          if (total === null || total <= 0n)
            issues.push({
              path: 'totalAmount',
              code: 'INVALID',
              message: `Total: decimal positivo, até ${scale} casas.`,
            })
          else values.totalAmount = formatDecimal(total, scale)
        }
        const accountKeys = ['debitAccountId', 'creditAccountId'].filter(
          (k) => has(k) && !frozen(k)
        )
        if (accountKeys.length) {
          issues.push(
            ...(await accountIssues(
              scope,
              legalEntityId,
              accountKeys.map((k) => input[k]),
              accountKeys
            ))
          )
          for (const k of accountKeys) values[k] = text(input[k])
          const debit = values.debitAccountId ?? current?.debitAccountId
          const credit = values.creditAccountId ?? current?.creditAccountId
          if (debit && debit === credit)
            issues.push({
              path: 'creditAccountId',
              code: 'SAME_ACCOUNT',
              message: 'Contas a débito e a crédito diferentes.',
            })
        }
        if (has('costCenterId') && !frozen('costCenterId')) {
          const issue = await costCenterIssue(scope, legalEntityId, input.costCenterId)
          if (issue) issues.push(issue)
          values.costCenterId = text(input.costCenterId) || null
        }
      }
      if (issues.length) throw ApiError.validation(issues)
      const row = current
        ? Object.keys(values).length
          ? await crudUpdate(s, SCHEDULE_SPEC, current.id, current.version, values)
          : current
        : await crudInsert(s, SCHEDULE_SPEC, values)
      if (template) {
        await scope.trx.rawQuery(
          'delete from adjustment_schedule_lines where tenant_id = ? and schedule_id = ?',
          [context.tenantId, row.id]
        )
        for (const [i, l] of template.entries())
          await scope.trx.rawQuery(
            `insert into adjustment_schedule_lines (tenant_id, created_by, updated_by, schedule_id, line_no, account_id, debit,
               credit, cost_center_id, third_party_ref, description) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              context.tenantId,
              context.userId,
              context.userId,
              row.id,
              i + 1,
              l.accountId,
              formatDecimal(l.debit, STORE),
              formatDecimal(l.credit, STORE),
              l.costCenterId,
              l.thirdPartyRef,
              l.description,
            ] as never[]
          )
      }
      await audit(scope, {
        action: current ? 'adjustment_schedule.updated' : 'adjustment_schedule.created',
        entityType: 'adjustment_schedule',
        entityId: row.id,
        changes: diff(current, row, Object.keys(SCHEDULE_SPEC.columns)),
        metadata: template ? { lines: template.length } : undefined,
      })
      return detail(scope, row as ScheduleRow)
    })
  }

  /** O que seria gerado até `upTo`, sem gravar. */
  preview(context: TenantContext, legalEntityId: string, upTo: string) {
    return runInTenant(context, async (scope) => {
      await assertEntityMonth(scope, legalEntityId, upTo)
      const { items, scale } = await due(scope, legalEntityId, upTo, false)
      return summary(items, scale)
    })
  }

  /**
   * Gera os rascunhos devidos até `upTo` (um por plano e mês, idempotente). Uma geração de cada vez por entidade;
   * a restrição única impede o mesmo mês duas vezes.
   */
  generate(context: TenantContext, legalEntityId: string, upTo: string) {
    return runInTenant(context, async (scope) => {
      await assertEntityMonth(scope, legalEntityId, upTo)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `${context.tenantId}:adj:${legalEntityId}`,
      ])
      const { items, scale } = await due(scope, legalEntityId, upTo, true)
      if (items.length === 0)
        throw ApiError.conflict('NOTHING_DUE', `Não há regularizações por gerar até ${upTo}.`)
      const created = []
      for (const it of items) {
        const { entry } = await createEntryInScope(
          scope,
          {
            legalEntityId,
            journalId: it.schedule.journalId,
            entryDate: monthEnd(it.month),
            reference: it.schedule.code,
            description: `${it.schedule.name} — ${it.month}`.slice(0, 500),
            sourceRef: `ADJ:${it.schedule.id}:${it.month}`,
            idempotencyKey: `adj:${it.schedule.id}:${it.month}`,
            lines: it.lines,
          },
          'ADJUSTMENT'
        )
        await scope.trx.rawQuery(
          `insert into adjustment_occurrences (tenant_id, created_by, updated_by, schedule_id, month, amount, entry_id)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            context.userId,
            context.userId,
            it.schedule.id,
            `${it.month}-01`,
            formatDecimal(it.total, scale),
            entry.id,
          ] as never[]
        )
        created.push({
          entryId: entry.id,
          scheduleCode: it.schedule.code,
          month: it.month,
          total: formatDecimal(it.total, scale),
        })
      }
      await audit(scope, {
        action: 'adjustment_schedule.generated',
        entityType: 'legal_entity',
        entityId: legalEntityId,
        metadata: { upTo, entries: created.length },
      })
      return { ...summary(items, scale), entries: created }
    })
  }
}

async function assertEntityMonth(scope: TenantScope, legalEntityId: string, month: string) {
  if (UUID.test(legalEntityId) && !(await legalEntityExists(scope, legalEntityId)))
    throw ApiError.notFound()
  const issues: ErrorDetail[] = []
  if (!UUID.test(legalEntityId))
    issues.push({ path: 'legalEntityId', code: 'INVALID', message: 'Entidade legal.' })
  if (!isMonth(month)) issues.push({ path: 'upTo', code: 'INVALID', message: 'Mês AAAA-MM.' })
  if (issues.length) throw ApiError.validation(issues)
}

async function due(scope: TenantScope, legalEntityId: string, upTo: string, lock: boolean) {
  const scale = await scaleOf(scope)
  const r = await scope.trx.rawQuery(
    `select id from adjustment_schedules where tenant_id = ? and legal_entity_id = ? and status = 'ACTIVE'
      order by code${lock ? ' for update' : ''}`,
    [scope.context.tenantId, legalEntityId]
  )
  const ids = (r.rows as { id: string }[]).map((x) => x.id)
  const done = new Set((await occurrences(scope, ids)).map((o) => `${o.scheduleId}|${o.month}`))
  const s = crud(scope.context, scope.trx)
  const items = []
  for (const id of ids) {
    const sched = (await crudFind(s, SCHEDULE_SPEC, id)) as ScheduleRow
    const template = sched.kind === 'RECURRING' ? await templateLines(scope, id) : []
    if (sched.kind === 'RECURRING' && template.length === 0) continue
    const plan = {
      kind: sched.kind,
      frequency: sched.frequency,
      startMonth: monthOf(sched.startMonth),
      endMonth: sched.endMonth ? monthOf(sched.endMonth) : null,
      months: sched.months,
    }
    const view = { ...sched, startMonth: plan.startMonth }
    for (const month of dueMonths(plan, upTo)) {
      if (done.has(`${id}|${month}`)) continue
      const { lines, total } = linesFor(view, template, month, scale)
      items.push({ schedule: view, month, lines, total })
    }
  }
  return { items, scale }
}

function summary(items: { schedule: ScheduleRow; month: string; total: bigint }[], scale: number) {
  return {
    rows: items.map((i) => ({
      scheduleId: i.schedule.id,
      code: i.schedule.code,
      name: i.schedule.name,
      kind: i.schedule.kind,
      month: i.month,
      total: formatDecimal(i.total, scale),
    })),
    total: formatDecimal(
      items.reduce((a, i) => a + i.total, 0n),
      scale
    ),
  }
}

async function detail(scope: TenantScope, s: ScheduleRow) {
  const scale = await scaleOf(scope)
  const occ = await occurrences(scope, [s.id])
  const facts = await entryFacts(
    scope,
    occ.map((o) => o.entryId)
  )
  const template = await templateLines(scope, s.id)
  const view = presentSchedule(s, scale)
  return {
    ...view,
    lastMonth:
      s.kind !== 'RECURRING' && s.months ? lastMonth(view.startMonth as string, s.months) : null,
    lines: template.map((l) => ({
      accountId: l.accountId,
      debit: l.debit > 0n ? formatDecimal(rescale(l.debit, STORE, scale, 'HALF_UP'), scale) : null,
      credit:
        l.credit > 0n ? formatDecimal(rescale(l.credit, STORE, scale, 'HALF_UP'), scale) : null,
      costCenterId: l.costCenterId,
      thirdPartyRef: l.thirdPartyRef,
      description: l.description,
    })),
    occurrences: occ.map((o) => ({
      month: o.month,
      amount: formatDecimal(toScale(o.amount, scale), scale),
      entryId: o.entryId,
      entryNumber: facts.get(o.entryId)?.number ?? null,
      entryStatus: facts.get(o.entryId)?.status ?? null,
    })),
  }
}

// ---------------------------------------------------------------- provisões

interface ProvisionRow extends Row {
  legalEntityId: string
  code: string
  name: string
  journalId: string
  expenseAccountId: string
  provisionAccountId: string
  reversalAccountId: string
  costCenterId: string | null
  status: string
}

const MOVEMENT_TYPES = ['CONSTITUTION', 'REVERSAL', 'USE'] as const

/**
 * Saldo da provisão: constituições − reversões − utilizações. `balance` conta todos os movimentos cujo lançamento
 * existe e não foi estornado (rascunhos incluídos, para não se reverter duas vezes o mesmo valor); `postedBalance`
 * só os contabilizados.
 */
async function balances(scope: TenantScope, provisionIds: string[], scale: number) {
  const out = new Map<string, { balance: string; postedBalance: string }>()
  if (provisionIds.length === 0) return out
  const r = await scope.trx.rawQuery(
    `select m.provision_id as id,
            round(coalesce(sum(case when m.type = 'CONSTITUTION' then m.amount else -m.amount end), 0), ?::int)::text as balance,
            round(coalesce(sum(case when e.status <> 'POSTED' then 0 when m.type = 'CONSTITUTION' then m.amount else -m.amount end), 0), ?::int)::text as posted
       from provision_movements m join journal_entries e on e.tenant_id = m.tenant_id and e.id = m.entry_id
      where m.tenant_id = ? and m.provision_id = any(?::uuid[]) and e.reversed_by_id is null
      group by m.provision_id`,
    [scale, scale, scope.context.tenantId, provisionIds]
  )
  for (const row of r.rows as { id: string; balance: string; posted: string }[])
    out.set(row.id, { balance: row.balance, postedBalance: row.posted })
  return out
}

export class ProvisionService {
  list(
    context: TenantContext,
    filter: { equals: Record<string, unknown>; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const scale = await scaleOf(scope)
      const page = await crudList(crud(context, scope.trx), PROVISION_SPEC, filter)
      const b = await balances(
        scope,
        page.items.map((p) => p.id),
        scale
      )
      const zero = formatDecimal(0n, scale)
      return {
        ...page,
        items: page.items.map((p) => ({
          ...p,
          balance: b.get(p.id)?.balance ?? zero,
          postedBalance: b.get(p.id)?.postedBalance ?? zero,
        })),
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const p = await crudFind(crud(context, scope.trx), PROVISION_SPEC, id)
      if (!p) throw ApiError.notFound()
      return provisionDetail(scope, p as ProvisionRow)
    })
  }

  save(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      const current = id
        ? ((await crudFind(s, PROVISION_SPEC, id, true)) as ProvisionRow | null)
        : null
      if (id && !current) throw ApiError.notFound()
      if (current && Number(input.expectedVersion) !== current.version)
        throw ApiError.versionConflict(current.version)
      const issues: ErrorDetail[] = []
      const values: Record<string, unknown> = {}
      const has = (k: string) => input[k] !== undefined || !current
      const legalEntityId = current ? current.legalEntityId : text(input.legalEntityId)
      if (!current) {
        if (!(await legalEntityExists(scope, legalEntityId)))
          issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade legal.' })
        values.legalEntityId = legalEntityId
        if (!CODE.test(text(input.code)))
          issues.push({ path: 'code', code: 'INVALID', message: 'Código: até 30 caracteres.' })
        values.code = text(input.code)
      }
      if (has('name')) {
        if (text(input.name).length < 2)
          issues.push({ path: 'name', code: 'REQUIRED', message: 'Nome de 2 a 160 caracteres.' })
        values.name = text(input.name).slice(0, 160)
      }
      if (input.description !== undefined) values.description = optional(input.description, 300)
      if (has('journalId')) {
        const issue = await journalIssue(scope, legalEntityId, input.journalId)
        if (issue) issues.push(issue)
        values.journalId = text(input.journalId)
      }
      const used = current
        ? (
            await scope.trx.rawQuery(
              'select 1 from provision_movements where tenant_id = ? and provision_id = ? limit 1',
              [context.tenantId, current.id]
            )
          ).rows.length > 0
        : false
      const keys = ['expenseAccountId', 'provisionAccountId', 'reversalAccountId'].filter(has)
      if (keys.length) {
        issues.push(
          ...(await accountIssues(
            scope,
            legalEntityId,
            keys.map((k) => input[k]),
            keys
          ))
        )
        if (
          used &&
          input.provisionAccountId !== undefined &&
          input.provisionAccountId !== current!.provisionAccountId
        )
          issues.push({
            path: 'provisionAccountId',
            code: 'IN_USE',
            message: 'Já há movimentos: a conta da provisão já não muda.',
          })
        for (const k of keys) values[k] = text(input[k])
      }
      if (has('costCenterId')) {
        const issue = await costCenterIssue(scope, legalEntityId, input.costCenterId)
        if (issue) issues.push(issue)
        values.costCenterId = text(input.costCenterId) || null
      }
      if (input.status !== undefined) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'ACTIVE ou INACTIVE.' })
        values.status = input.status
      }
      if (issues.length) throw ApiError.validation(issues)
      const row = current
        ? await crudUpdate(s, PROVISION_SPEC, current.id, current.version, values)
        : await crudInsert(s, PROVISION_SPEC, values)
      await audit(scope, {
        action: current ? 'provision.updated' : 'provision.created',
        entityType: 'provision',
        entityId: row.id,
        changes: diff(current, row, Object.keys(PROVISION_SPEC.columns)),
      })
      return provisionDetail(scope, row as ProvisionRow)
    })
  }

  /**
   * Movimento da provisão com o seu rascunho:
   * - constituição/reforço: débito do gasto, crédito da provisão;
   * - reversão: débito da provisão, crédito do rendimento de reversão;
   * - utilização: débito da provisão, crédito da conta indicada (p. ex. o credor que se pagou).
   * Reversão e utilização nunca excedem o saldo (a provisão fica bloqueada durante a operação).
   */
  move(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const p = (await crudFind(
        crud(context, scope.trx),
        PROVISION_SPEC,
        id,
        true
      )) as ProvisionRow | null
      if (!p) throw ApiError.notFound()
      const scale = await scaleOf(scope)
      const issues: ErrorDetail[] = []
      const type = input.type as (typeof MOVEMENT_TYPES)[number]
      if (!MOVEMENT_TYPES.includes(type))
        issues.push({
          path: 'type',
          code: 'INVALID',
          message: 'Constituição, reversão ou utilização.',
        })
      const date = text(input.date)
      if (!ISO.test(date))
        issues.push({ path: 'date', code: 'REQUIRED', message: 'Data (AAAA-MM-DD).' })
      const amount = parseDecimal(input.amount, scale)
      if (amount === null || amount <= 0n)
        issues.push({
          path: 'amount',
          code: 'INVALID',
          message: `Montante positivo, até ${scale} casas.`,
        })
      if (text(input.reason).length < 3)
        issues.push({ path: 'reason', code: 'REQUIRED', message: 'Motivo do movimento.' })
      if (type === 'CONSTITUTION' && p.status !== 'ACTIVE')
        issues.push({ path: 'type', code: 'INACTIVE', message: 'A provisão está inactiva.' })
      if (type === 'USE')
        issues.push(
          ...(await accountIssues(
            scope,
            p.legalEntityId,
            [input.counterAccountId],
            ['counterAccountId']
          ))
        )
      if (issues.length) throw ApiError.validation(issues)
      if (type !== 'CONSTITUTION') {
        const balance = parseDecimal(
          (await balances(scope, [p.id], scale)).get(p.id)?.balance ?? '0',
          scale
        )!
        if (amount! > balance)
          throw ApiError.validation([
            {
              path: 'amount',
              code: 'EXCEEDS_BALANCE',
              message: `O saldo da provisão é ${formatDecimal(balance, scale)}.`,
            },
          ])
      }
      const value = formatDecimal(amount!, scale)
      const [debitId, creditId] =
        type === 'CONSTITUTION'
          ? [p.expenseAccountId, p.provisionAccountId]
          : type === 'REVERSAL'
            ? [p.provisionAccountId, p.reversalAccountId]
            : [p.provisionAccountId, text(input.counterAccountId)]
      const description = `${p.name}: ${text(input.reason)}`.slice(0, 300)
      const { entry } = await createEntryInScope(
        scope,
        {
          legalEntityId: p.legalEntityId,
          journalId: p.journalId,
          entryDate: date,
          reference: p.code,
          description,
          sourceRef: `PRV:${p.id}`,
          lines: [
            {
              accountId: debitId,
              debit: value,
              credit: null,
              costCenterId: p.costCenterId,
              description,
            },
            {
              accountId: creditId,
              debit: null,
              credit: value,
              costCenterId: p.costCenterId,
              thirdPartyRef: type === 'USE' ? optional(input.thirdPartyRef, 60) : null,
              description,
            },
          ],
        },
        'PROVISION'
      )
      await scope.trx.rawQuery(
        `insert into provision_movements (tenant_id, created_by, updated_by, provision_id, type, movement_date, amount,
           counter_account_id, reason, entry_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          p.id,
          type,
          date,
          value,
          type === 'USE' ? text(input.counterAccountId) : null,
          text(input.reason).slice(0, 300),
          entry.id,
        ] as never[]
      )
      await audit(scope, {
        action: 'provision.moved',
        entityType: 'provision',
        entityId: p.id,
        metadata: { type, amount: value, date, entryId: entry.id },
      })
      return provisionDetail(scope, p)
    })
  }
}

async function provisionDetail(scope: TenantScope, p: ProvisionRow) {
  const scale = await scaleOf(scope)
  const r = await scope.trx.rawQuery(
    `select m.id, m.type, m.movement_date::text as date, round(m.amount, ?::int)::text as amount,
            m.counter_account_id as "counterAccountId", m.reason, m.entry_id as "entryId", m.created_at as "createdAt"
       from provision_movements m where m.tenant_id = ? and m.provision_id = ? order by m.movement_date, m.created_at`,
    [scale, scope.context.tenantId, p.id]
  )
  const moves = r.rows as { entryId: string }[]
  const facts = await entryFacts(
    scope,
    moves.map((m) => m.entryId)
  )
  const b = (await balances(scope, [p.id], scale)).get(p.id)
  const zero = formatDecimal(0n, scale)
  return {
    ...p,
    balance: b?.balance ?? zero,
    postedBalance: b?.postedBalance ?? zero,
    movements: moves.map((m) => ({
      ...m,
      entryNumber: facts.get(m.entryId)?.number ?? null,
      entryStatus: facts.get(m.entryId)?.status ?? null,
      reversed: facts.get(m.entryId)?.reversed ?? false,
    })),
  }
}

/** Regularizações (planos) por gerar até ao mês (para a checklist de fecho). */
export async function adjustmentsDue(scope: TenantScope, legalEntityId: string, month: string) {
  return (await due(scope, legalEntityId, month, false)).items.length
}
