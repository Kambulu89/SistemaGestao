import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { tenantSettings } from '#modules/settings/index'
import {
  createEntryInScope,
  lockEntry,
  postInScope,
  reverseInScope,
} from '#modules/accounting/application/entries_service'
import { periodsOf, crud } from '#modules/accounting/application/setup_service'
import { depreciationDue } from '#modules/accounting/application/fixed_assets_service'
import { adjustmentsDue } from '#modules/accounting/application/adjustments_service'
import {
  accountIssues,
  journalIssue,
  optional,
  text,
  UUID,
} from '#modules/accounting/application/references'
import { formatDecimal, parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Fecho (6.10). Cada período tem uma checklist: verificações automáticas (lançamentos por contabilizar, rascunhos,
 * eventos de integração falhados, depreciações e regularizações por gerar, actualizações cambiais pendentes, períodos
 * anteriores abertos) e tarefas manuais. Fechar um período com bloqueios é impossível; com avisos, exige que se
 * reconheçam (fica na auditoria). O encerramento do exercício apura os resultados para a conta indicada, transporta
 * os saldos de balanço para a abertura do exercício seguinte e fecha tudo; a reabertura estorna ambos.
 */
export type CheckStatus = 'OK' | 'WARNING' | 'BLOCKING'
export interface CheckItem {
  code: string
  label: string
  status: CheckStatus
  count: number
  message: string
}

interface PeriodRow {
  id: string
  number: number
  kind: 'OPENING' | 'NORMAL' | 'CLOSING'
  name: string
  status: string
  start_date: string
  end_date: string
  fiscal_year_id: string
  year_status: string
  legal_entity_id: string
}

interface YearRow {
  id: string
  version: number
  legal_entity_id: string
  code: string
  start_date: string
  end_date: string
  status: string
}

const signed = (v: string, scale: number) => {
  const neg = v.startsWith('-')
  const x = parseDecimal(neg ? v.slice(1) : v, scale)!
  return neg ? -x : x
}

async function loadPeriod(scope: TenantScope, id: string, lock = false) {
  if (!UUID.test(id)) return null
  const r = await scope.trx.rawQuery(
    `select p.id, p.number, p.kind, p.name, p.status, p.start_date::text as start_date, p.end_date::text as end_date,
            p.fiscal_year_id, y.status as year_status, y.legal_entity_id
       from fiscal_periods p join fiscal_years y on y.tenant_id = p.tenant_id and y.id = p.fiscal_year_id
      where p.tenant_id = ? and p.id = ?${lock ? ' for update of p' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as PeriodRow | undefined) ?? null
}

async function loadYear(scope: TenantScope, id: string, lock = false) {
  if (!UUID.test(id)) return null
  const r = await scope.trx.rawQuery(
    `select id, version, legal_entity_id, code, start_date::text as start_date, end_date::text as end_date, status
       from fiscal_years where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as YearRow | undefined) ?? null
}

const count = async (scope: TenantScope, sql: string, params: unknown[]) =>
  ((await scope.trx.rawQuery(sql, params as never[])).rows[0] as { n: number }).n

/** Verificações automáticas e tarefas manuais de um período. */
async function checklist(scope: TenantScope, p: PeriodRow): Promise<CheckItem[]> {
  const t = scope.context.tenantId
  const items: CheckItem[] = []
  const add = (
    code: string,
    label: string,
    n: number,
    bad: CheckStatus,
    message: (n: number) => string
  ) =>
    items.push({
      code,
      label,
      count: n,
      status: n > 0 ? bad : 'OK',
      message: n > 0 ? message(n) : 'Sem pendências.',
    })

  add(
    'PENDING_ENTRIES',
    'Lançamentos submetidos ou aprovados por contabilizar',
    await count(
      scope,
      `select count(*)::int as n from journal_entries where tenant_id = ? and period_id = ? and status in ('SUBMITTED','APPROVED')`,
      [t, p.id]
    ),
    'BLOCKING',
    (n) => `${n} lançamento(s) a meio do fluxo: contabilize-os ou rejeite-os.`
  )
  const totals = (
    await scope.trx.rawQuery(
      `select coalesce(sum(l.debit_functional), 0) = coalesce(sum(l.credit_functional), 0) as ok
         from journal_lines l join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
        where l.tenant_id = ? and e.period_id = ? and e.status = 'POSTED'`,
      [t, p.id]
    )
  ).rows[0] as { ok: boolean }
  add(
    'UNBALANCED',
    'Débitos iguais aos créditos',
    totals.ok ? 0 : 1,
    'BLOCKING',
    () => 'Os débitos e os créditos contabilizados no período não coincidem: contacte o suporte.'
  )
  add(
    'DRAFT_ENTRIES',
    'Rascunhos no período',
    await count(
      scope,
      `select count(*)::int as n from journal_entries where tenant_id = ? and period_id = ? and status = 'DRAFT'`,
      [t, p.id]
    ),
    'WARNING',
    (n) => `${n} rascunho(s) ficarão por contabilizar neste período.`
  )
  add(
    'FAILED_EVENTS',
    'Eventos de integração falhados',
    await count(
      scope,
      `select count(*)::int as n from posting_events where tenant_id = ? and legal_entity_id = ? and status = 'FAILED'
          and occurred_on between ?::date and ?::date`,
      [t, p.legal_entity_id, p.start_date, p.end_date]
    ),
    'WARNING',
    (n) => `${n} evento(s) de outros módulos não chegaram ao razão: reprocesse-os.`
  )
  if (p.kind === 'NORMAL') {
    const month = p.start_date.slice(0, 7)
    add(
      'DEPRECIATION_DUE',
      'Depreciações do período',
      await depreciationDue(scope, p.legal_entity_id, month),
      'WARNING',
      (n) => `${n} quota(s) de depreciação até ${month} por processar.`
    )
    add(
      'ADJUSTMENTS_DUE',
      'Regularizações do período',
      await adjustmentsDue(scope, p.legal_entity_id, month),
      'WARNING',
      (n) => `${n} regularização(ões) até ${month} por gerar.`
    )
  }
  add(
    'FX_PENDING',
    'Diferenças cambiais por contabilizar',
    await count(
      scope,
      `select count(*)::int as n from fx_revaluations r join journal_entries e on e.tenant_id = r.tenant_id and e.id = r.entry_id
        where r.tenant_id = ? and r.legal_entity_id = ? and e.status <> 'POSTED' and r.revaluation_date <= ?::date`,
      [t, p.legal_entity_id, p.end_date]
    ),
    'WARNING',
    (n) => `${n} actualização(ões) cambial(ais) em rascunho.`
  )
  add(
    'EARLIER_OPEN',
    'Períodos anteriores fechados',
    await count(
      scope,
      `select count(*)::int as n from fiscal_periods where tenant_id = ? and fiscal_year_id = ? and number < ? and status = 'OPEN'`,
      [t, p.fiscal_year_id, p.number]
    ),
    'WARNING',
    (n) => `${n} período(s) anterior(es) ainda aberto(s).`
  )
  add(
    'TASKS_OPEN',
    'Tarefas da checklist concluídas',
    await count(
      scope,
      'select count(*)::int as n from close_tasks where tenant_id = ? and period_id = ? and done = false',
      [t, p.id]
    ),
    'WARNING',
    (n) => `${n} tarefa(s) manual(is) por concluir.`
  )
  return items
}

async function tasksOf(scope: TenantScope, periodId: string) {
  const r = await scope.trx.rawQuery(
    `select id, version, title, done, done_by as "doneBy", done_at as "doneAt", note
       from close_tasks where tenant_id = ? and period_id = ? order by created_at, title`,
    [scope.context.tenantId, periodId]
  )
  return r.rows as { id: string; version: number; title: string; done: boolean }[]
}

function gate(items: CheckItem[], acknowledge: boolean) {
  const blocking = items.filter((i) => i.status === 'BLOCKING')
  if (blocking.length)
    throw new ApiError(
      409,
      'CLOSE_BLOCKED',
      blocking.map((i) => i.message).join(' '),
      blocking.map((i) => ({ path: i.code, code: i.code, message: i.message }))
    )
  const warnings = items.filter((i) => i.status === 'WARNING')
  if (warnings.length && !acknowledge)
    throw new ApiError(
      409,
      'CLOSE_WARNINGS',
      'Há avisos na checklist: confirme que quer fechar mesmo assim.',
      warnings.map((i) => ({ path: i.code, code: i.code, message: i.message }))
    )
  return warnings.map((w) => ({ code: w.code, count: w.count }))
}

export class ClosingService {
  checklist(context: TenantContext, periodId: string) {
    return runInTenant(context, async (scope) => {
      const p = await loadPeriod(scope, periodId)
      if (!p) throw ApiError.notFound()
      const items = await checklist(scope, p)
      return {
        period: { id: p.id, number: p.number, kind: p.kind, name: p.name, status: p.status },
        items,
        tasks: await tasksOf(scope, p.id),
        canClose: p.status === 'OPEN' && !items.some((i) => i.status === 'BLOCKING'),
      }
    })
  }

  /**
   * Fecha um período: bloqueia o período (quem estiver a contabilizar nele termina primeiro), corre a checklist e só
   * fecha sem bloqueios e com os avisos reconhecidos.
   */
  closePeriod(
    context: TenantContext,
    periodId: string,
    input: { acknowledgeWarnings?: boolean; reason?: string | null }
  ) {
    return runInTenant(context, async (scope) => {
      const p = await loadPeriod(scope, periodId, true)
      if (!p) throw ApiError.notFound()
      if (p.status === 'CLOSED')
        throw ApiError.conflict('PERIOD_ALREADY', 'O período já está fechado.')
      if (p.year_status === 'CLOSED')
        throw ApiError.conflict('FISCAL_YEAR_CLOSED', 'O exercício está fechado.')
      const acknowledged = gate(await checklist(scope, p), input.acknowledgeWarnings === true)
      await scope.trx.rawQuery(
        `update fiscal_periods set status = 'CLOSED', updated_at = now(), updated_by = ?, version = version + 1
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, p.id]
      )
      await audit(scope, {
        action: 'fiscal_period.closed',
        entityType: 'fiscal_year',
        entityId: p.fiscal_year_id,
        changes: { [`period:${p.name}`]: { from: 'OPEN', to: 'CLOSED' } },
        metadata: {
          ...(acknowledged.length ? { acknowledgedWarnings: acknowledged } : {}),
          ...(input.reason ? { reason: input.reason.trim() } : {}),
        },
      })
      return periodsOf(crud(context, scope.trx), p.fiscal_year_id)
    })
  }

  // ------------------------------------------------------------ tarefas manuais

  addTask(context: TenantContext, periodId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const p = await loadPeriod(scope, periodId)
      if (!p) throw ApiError.notFound()
      const title = text(input.title)
      if (title.length < 3 || title.length > 200)
        throw ApiError.validation([
          { path: 'title', code: 'REQUIRED', message: 'Descrição da tarefa (3 a 200 caracteres).' },
        ])
      await scope.trx.rawQuery('savepoint close_task')
      try {
        await scope.trx.rawQuery(
          `insert into close_tasks (tenant_id, created_by, updated_by, period_id, title) values (?, ?, ?, ?, ?)`,
          [context.tenantId, context.userId, context.userId, p.id, title]
        )
        await scope.trx.rawQuery('release savepoint close_task')
      } catch (error) {
        if (constraintOf(error) === 'close_tasks_title_unique') {
          await scope.trx.rawQuery('rollback to savepoint close_task')
          throw ApiError.conflict('TASK_EXISTS', 'Esta tarefa já existe neste período.')
        }
        throw error
      }
      await audit(scope, {
        action: 'close_task.created',
        entityType: 'fiscal_year',
        entityId: p.fiscal_year_id,
        metadata: { period: p.name, title },
      })
      return tasksOf(scope, p.id)
    })
  }

  /** Copia as tarefas do período anterior (por concluir), para não as escrever todos os meses. */
  copyTasks(context: TenantContext, periodId: string) {
    return runInTenant(context, async (scope) => {
      const p = await loadPeriod(scope, periodId)
      if (!p) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `insert into close_tasks (tenant_id, created_by, updated_by, period_id, title)
         select t.tenant_id, ?, ?, ?, t.title from close_tasks t
           join fiscal_periods q on q.tenant_id = t.tenant_id and q.id = t.period_id
          where t.tenant_id = ? and q.fiscal_year_id = ? and q.number = (
            select max(number) from fiscal_periods x
             where x.tenant_id = ? and x.fiscal_year_id = ? and x.number < ?
               and exists (select 1 from close_tasks y where y.tenant_id = x.tenant_id and y.period_id = x.id))
         on conflict (tenant_id, period_id, title) do nothing returning id`,
        [
          context.userId,
          context.userId,
          p.id,
          context.tenantId,
          p.fiscal_year_id,
          context.tenantId,
          p.fiscal_year_id,
          p.number,
        ]
      )
      if (r.rows.length)
        await audit(scope, {
          action: 'close_task.copied',
          entityType: 'fiscal_year',
          entityId: p.fiscal_year_id,
          metadata: { period: p.name, tasks: r.rows.length },
        })
      return tasksOf(scope, p.id)
    })
  }

  updateTask(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select t.id, t.version, t.period_id, t.title, t.done, p.status from close_tasks t
           join fiscal_periods p on p.tenant_id = t.tenant_id and p.id = t.period_id
          where t.tenant_id = ? and t.id = ? for update of t`,
        [context.tenantId, UUID.test(id) ? id : null] as never[]
      )
      const task = r.rows[0] as
        | {
            id: string
            version: number
            period_id: string
            title: string
            done: boolean
            status: string
          }
        | undefined
      if (!task) throw ApiError.notFound()
      if (Number(input.expectedVersion) !== task.version)
        throw ApiError.versionConflict(task.version)
      if (task.status === 'CLOSED')
        throw ApiError.conflict(
          'PERIOD_CLOSED',
          'O período está fechado: reabra-o para mudar a checklist.'
        )
      const done = input.done === undefined ? task.done : input.done === true
      await scope.trx.rawQuery(
        `update close_tasks set done = ?, done_by = ?, done_at = ?, note = ?, updated_by = ?, updated_at = now(),
           version = version + 1 where tenant_id = ? and id = ?`,
        [
          done,
          done ? context.userId : null,
          done ? new Date().toISOString() : null,
          optional(input.note, 500),
          context.userId,
          context.tenantId,
          task.id,
        ] as never[]
      )
      await audit(scope, {
        action: done ? 'close_task.done' : 'close_task.reopened',
        entityType: 'close_task',
        entityId: task.id,
        metadata: { title: task.title },
      })
      return tasksOf(scope, task.period_id)
    })
  }

  deleteTask(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `delete from close_tasks t using fiscal_periods p
          where t.tenant_id = ? and t.id = ? and p.tenant_id = t.tenant_id and p.id = t.period_id and p.status = 'OPEN'
          returning t.period_id, t.title`,
        [context.tenantId, UUID.test(id) ? id : null] as never[]
      )
      const row = r.rows[0] as { period_id: string; title: string } | undefined
      if (!row) throw ApiError.notFound()
      await audit(scope, {
        action: 'close_task.deleted',
        entityType: 'close_task',
        entityId: id,
        metadata: { title: row.title },
      })
    })
  }

  // ------------------------------------------------------------ exercício

  /** Estado do encerramento do exercício: períodos, resultado a apurar, exercícios seguintes e checklist. */
  yearStatus(context: TenantContext, fiscalYearId: string) {
    return runInTenant(context, async (scope) => {
      const y = await loadYear(scope, fiscalYearId)
      if (!y) throw ApiError.notFound()
      const scale = (await tenantSettings(scope)).amountScale
      const periods = await periodsOf(crud(context, scope.trx), y.id)
      const closing = periods.find((p) => p.kind === 'CLOSING')!
      const pl = await profitAndLoss(scope, y, scale)
      const next = await scope.trx.rawQuery(
        `select id, code, start_date::text as "startDate", status from fiscal_years
          where tenant_id = ? and legal_entity_id = ? and start_date > ?::date order by start_date limit 3`,
        [context.tenantId, y.legal_entity_id, y.end_date]
      )
      const history = await scope.trx.rawQuery(
        `select c.id, c.status, c.created_at as "closedAt", c.reopened_at as "reopenedAt", c.reopen_reason as "reopenReason",
                round(c.net_result, ?::int)::text as "netResult", ce.number as "closingEntryNumber", oe.number as "openingEntryNumber",
                c.closing_entry_id as "closingEntryId", c.opening_entry_id as "openingEntryId"
           from fiscal_year_closings c
           left join journal_entries ce on ce.tenant_id = c.tenant_id and ce.id = c.closing_entry_id
           left join journal_entries oe on oe.tenant_id = c.tenant_id and oe.id = c.opening_entry_id
          where c.tenant_id = ? and c.fiscal_year_id = ? order by c.created_at desc`,
        [scale, context.tenantId, y.id]
      )
      const closingPeriod = await loadPeriod(scope, closing.id)
      return {
        fiscalYear: { id: y.id, code: y.code, status: y.status, endDate: y.end_date },
        openPeriods: periods
          .filter((p) => p.kind !== 'CLOSING' && p.status === 'OPEN')
          .map((p) => p.name),
        profitAndLoss: pl.groups.map((g) => ({ ...g, balance: formatDecimal(g.balance, scale) })),
        netResult: formatDecimal(-pl.net, scale),
        nextFiscalYears: next.rows,
        checklist: closingPeriod ? await checklist(scope, closingPeriod) : [],
        history: history.rows,
      }
    })
  }

  /**
   * Encerra o exercício: todos os períodos (excepto o de regularizações) têm de estar fechados; os avisos da
   * checklist do período de regularizações têm de ser reconhecidos. Gera e contabiliza no período de regularizações o
   * apuramento (contas de resultados saldadas contra a conta de resultado) e, se pedido, o transporte dos saldos de
   * balanço para a abertura do exercício seguinte; fecha o período de regularizações e o exercício.
   */
  closeYear(context: TenantContext, fiscalYearId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const y = await loadYear(scope, fiscalYearId, true)
      if (!y) throw ApiError.notFound()
      if (y.status === 'CLOSED')
        throw ApiError.conflict('YEAR_ALREADY_CLOSED', 'O exercício já está encerrado.')
      const periods = await scope.trx.rawQuery(
        `select id, number, kind, name, status from fiscal_periods where tenant_id = ? and fiscal_year_id = ?
          order by number for update`,
        [context.tenantId, y.id]
      )
      const rows = periods.rows as {
        id: string
        number: number
        kind: string
        name: string
        status: string
      }[]
      const closing = rows.find((p) => p.kind === 'CLOSING')!
      const issues: ErrorDetail[] = []
      const open = rows.filter((p) => p.kind !== 'CLOSING' && p.status === 'OPEN')
      if (open.length)
        throw ApiError.conflict(
          'PERIODS_OPEN',
          `Feche primeiro os períodos: ${open.map((p) => p.name).join(', ')}.`
        )
      if (closing.status !== 'OPEN')
        throw ApiError.conflict(
          'CLOSING_PERIOD_CLOSED',
          'O período de regularizações está fechado: reabra-o para encerrar o exercício.'
        )
      const resultAccountId = text(input.resultAccountId)
      issues.push(
        ...(await accountIssues(scope, y.legal_entity_id, [resultAccountId], ['resultAccountId']))
      )
      if (issues.length === 0) {
        const nature = await scope.trx.rawQuery(
          'select nature from accounts where tenant_id = ? and id = ?',
          [context.tenantId, resultAccountId]
        )
        if ((nature.rows[0] as { nature: string }).nature !== 'EQUITY')
          issues.push({
            path: 'resultAccountId',
            code: 'NOT_EQUITY',
            message: 'A conta de resultado tem de ser de capital próprio.',
          })
      }
      const journal = await journalIssue(scope, y.legal_entity_id, input.journalId)
      if (journal) issues.push(journal)
      let next: (YearRow & { opening_period_id: string; opening_status: string }) | null = null
      const nextId = text(input.nextFiscalYearId)
      if (nextId) {
        const n = await loadYear(scope, nextId, true)
        if (!n || n.legal_entity_id !== y.legal_entity_id || n.start_date <= y.end_date)
          issues.push({
            path: 'nextFiscalYearId',
            code: 'INVALID',
            message: 'Exercício seguinte da mesma entidade legal.',
          })
        else {
          const op = (
            await scope.trx.rawQuery(
              `select id, status from fiscal_periods where tenant_id = ? and fiscal_year_id = ? and kind = 'OPENING' for update`,
              [context.tenantId, n.id]
            )
          ).rows[0] as { id: string; status: string }
          next = { ...n, opening_period_id: op.id, opening_status: op.status }
          if (n.status !== 'OPEN' || op.status !== 'OPEN')
            issues.push({
              path: 'nextFiscalYearId',
              code: 'CLOSED',
              message: 'A abertura do exercício seguinte está fechada.',
            })
          const used = await count(
            scope,
            `select count(*)::int as n from journal_entries where tenant_id = ? and period_id = ? and status = 'POSTED'
                and reversed_by_id is null and reversal_of_id is null`,
            [context.tenantId, op.id]
          )
          if (used > 0)
            issues.push({
              path: 'nextFiscalYearId',
              code: 'OPENING_NOT_EMPTY',
              message:
                'O exercício seguinte já tem lançamentos de abertura: não se transportam saldos por cima.',
            })
        }
      }
      if (issues.length) throw ApiError.validation(issues)
      const closingPeriod = (await loadPeriod(scope, closing.id))!
      const acknowledged = gate(
        await checklist(scope, closingPeriod),
        input.acknowledgeWarnings === true
      )

      const scale = (await tenantSettings(scope)).amountScale
      const m = (v: bigint) => formatDecimal(v < 0n ? -v : v, scale)
      const pl = await profitAndLoss(scope, y, scale)
      let closingEntryId: string | null = null
      if (pl.groups.length) {
        const lines: Record<string, unknown>[] = pl.groups.map((g) => ({
          accountId: g.accountId,
          debit: g.balance < 0n ? m(g.balance) : null,
          credit: g.balance > 0n ? m(g.balance) : null,
          costCenterId: g.costCenterId,
          description: 'Apuramento de resultados',
        }))
        if (pl.net !== 0n)
          lines.push({
            accountId: resultAccountId,
            debit: pl.net > 0n ? m(pl.net) : null,
            credit: pl.net < 0n ? m(pl.net) : null,
            description: 'Resultado líquido do exercício',
          })
        closingEntryId = await postGenerated(
          scope,
          {
            legalEntityId: y.legal_entity_id,
            journalId: text(input.journalId),
            entryDate: y.end_date,
            periodId: closing.id,
            reference: `ENC ${y.code}`,
            description: `Apuramento de resultados do exercício ${y.code}`,
            sourceRef: `YEAR:${y.id}`,
            lines,
          },
          'YEAR_CLOSE'
        )
      }
      let openingEntryId: string | null = null
      if (next) {
        const bs = await balanceSheet(scope, y, scale)
        if (bs.length > 499)
          throw ApiError.validation([
            {
              path: 'nextFiscalYearId',
              code: 'TOO_MANY_LINES',
              message: 'Mais de 499 saldos a transportar.',
            },
          ])
        if (bs.length)
          openingEntryId = await postGenerated(
            scope,
            {
              legalEntityId: y.legal_entity_id,
              journalId: text(input.journalId),
              entryDate: next.start_date,
              periodId: next.opening_period_id,
              reference: `ABE ${next.code}`,
              description: `Saldos transportados do exercício ${y.code}`,
              sourceRef: `YEAR:${y.id}`,
              lines: bs.map((g) => ({
                accountId: g.accountId,
                debit: g.balance > 0n ? m(g.balance) : null,
                credit: g.balance < 0n ? m(g.balance) : null,
                thirdPartyRef: g.thirdPartyRef,
                costCenterId: g.costCenterId,
                description: 'Saldo transportado',
              })),
            },
            'YEAR_OPENING'
          )
      }
      await scope.trx.rawQuery(
        `update fiscal_periods set status = 'CLOSED', updated_at = now(), updated_by = ?, version = version + 1
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, closing.id]
      )
      await scope.trx.rawQuery(
        `update fiscal_years set status = 'CLOSED', updated_at = now(), updated_by = ?, version = version + 1
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, y.id]
      )
      const rec = await scope.trx.rawQuery(
        `insert into fiscal_year_closings (tenant_id, created_by, updated_by, fiscal_year_id, result_account_id, journal_id,
           closing_entry_id, next_fiscal_year_id, opening_entry_id, net_result, acknowledged)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) returning id`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          y.id,
          resultAccountId,
          text(input.journalId),
          closingEntryId,
          next?.id ?? null,
          openingEntryId,
          formatDecimal(-pl.net, scale),
          JSON.stringify(acknowledged),
        ] as never[]
      )
      await audit(scope, {
        action: 'fiscal_year.closed',
        entityType: 'fiscal_year',
        entityId: y.id,
        changes: { status: { from: 'OPEN', to: 'CLOSED' } },
        metadata: {
          closingId: (rec.rows[0] as { id: string }).id,
          netResult: formatDecimal(-pl.net, scale),
          closingEntryId,
          openingEntryId,
          nextFiscalYearId: next?.id ?? null,
          ...(acknowledged.length ? { acknowledgedWarnings: acknowledged } : {}),
        },
      })
      return {
        fiscalYearId: y.id,
        status: 'CLOSED',
        netResult: formatDecimal(-pl.net, scale),
        closingEntryId,
        openingEntryId,
      }
    })
  }

  /**
   * Reabre o exercício (motivo obrigatório): estorna o transporte (na abertura do exercício seguinte, que tem de estar
   * aberta) e o apuramento (no período de regularizações, que volta a abrir). Os períodos mensais continuam fechados.
   */
  reopenYear(context: TenantContext, fiscalYearId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const y = await loadYear(scope, fiscalYearId, true)
      if (!y) throw ApiError.notFound()
      const reason = text(input.reason)
      if (reason.length < 5)
        throw ApiError.validation([
          { path: 'reason', code: 'REQUIRED', message: 'Indique o motivo da reabertura.' },
        ])
      if (y.status !== 'CLOSED')
        throw ApiError.conflict('YEAR_NOT_CLOSED', 'O exercício não está encerrado.')
      const rec = (
        await scope.trx.rawQuery(
          `select id, closing_entry_id, opening_entry_id, next_fiscal_year_id from fiscal_year_closings
            where tenant_id = ? and fiscal_year_id = ? and status = 'ACTIVE' for update`,
          [context.tenantId, y.id]
        )
      ).rows[0] as
        | {
            id: string
            closing_entry_id: string | null
            opening_entry_id: string | null
            next_fiscal_year_id: string | null
          }
        | undefined
      const closing = (
        await scope.trx.rawQuery(
          `select id, end_date::text as end_date from fiscal_periods where tenant_id = ? and fiscal_year_id = ? and kind = 'CLOSING' for update`,
          [context.tenantId, y.id]
        )
      ).rows[0] as { id: string; end_date: string }
      const reversals: { id: string; number: unknown }[] = []
      if (rec?.opening_entry_id) {
        const n = (await loadYear(scope, rec.next_fiscal_year_id!, true))!
        const op = (
          await scope.trx.rawQuery(
            `select id, status from fiscal_periods where tenant_id = ? and fiscal_year_id = ? and kind = 'OPENING' for update`,
            [context.tenantId, n.id]
          )
        ).rows[0] as { id: string; status: string }
        if (n.status !== 'OPEN' || op.status !== 'OPEN')
          throw ApiError.conflict(
            'NEXT_OPENING_CLOSED',
            `A abertura do exercício ${n.code} está fechada: reabra-a antes de reabrir este exercício.`
          )
        const entry = await lockEntry(scope, rec.opening_entry_id, true)
        const r = (await reverseInScope(scope, entry!, {
          date: n.start_date,
          periodId: op.id,
          description: `Anulação do transporte de saldos (${reason})`.slice(0, 500),
        })) as Record<string, unknown>
        reversals.push({ id: r.id as string, number: r.number })
      }
      await scope.trx.rawQuery(
        `update fiscal_years set status = 'OPEN', updated_at = now(), updated_by = ?, version = version + 1
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, y.id]
      )
      await scope.trx.rawQuery(
        `update fiscal_periods set status = 'OPEN', updated_at = now(), updated_by = ?, version = version + 1
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, closing.id]
      )
      if (rec?.closing_entry_id) {
        const entry = await lockEntry(scope, rec.closing_entry_id, true)
        const r = (await reverseInScope(scope, entry!, {
          date: closing.end_date,
          periodId: closing.id,
          description: `Anulação do apuramento de resultados (${reason})`.slice(0, 500),
        })) as Record<string, unknown>
        reversals.push({ id: r.id as string, number: r.number })
      }
      if (rec)
        await scope.trx.rawQuery(
          `update fiscal_year_closings set status = 'REVERSED', reopened_by = ?, reopened_at = now(), reopen_reason = ?,
             updated_by = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
          [context.userId, reason.slice(0, 500), context.userId, context.tenantId, rec.id]
        )
      await audit(scope, {
        action: 'fiscal_year.reopened',
        entityType: 'fiscal_year',
        entityId: y.id,
        changes: { status: { from: 'CLOSED', to: 'OPEN' } },
        metadata: { reason, reversals },
      })
      return { fiscalYearId: y.id, status: 'OPEN', reversals }
    })
  }
}

async function postGenerated(scope: TenantScope, input: Record<string, unknown>, source: string) {
  const { entry } = await createEntryInScope(scope, input, source)
  const locked = await lockEntry(scope, entry.id, true)
  const posted = await postInScope(scope, locked!)
  return posted.id as string
}

/** Saldos das contas de resultados do exercício (todos os períodos), por conta e centro de custo. */
async function profitAndLoss(scope: TenantScope, y: YearRow, scale: number) {
  const r = await scope.trx.rawQuery(
    `select a.id as "accountId", a.code, a.name, l.cost_center_id as "costCenterId",
            round(sum(l.debit_functional - l.credit_functional), ?::int)::text as balance
       from journal_lines l
       join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
       join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ? and e.fiscal_year_id = ? and e.status = 'POSTED' and a.nature in ('REVENUE','EXPENSE')
      group by a.id, l.cost_center_id order by a.code`,
    [scale, scope.context.tenantId, y.id]
  )
  const groups = (
    r.rows as {
      accountId: string
      code: string
      name: string
      costCenterId: string | null
      balance: string
    }[]
  )
    .map((g) => ({ ...g, balance: signed(g.balance, scale) }))
    .filter((g) => g.balance !== 0n)
  return { groups, net: groups.reduce((s, g) => s + g.balance, 0n) }
}

/**
 * Saldos de balanço a transportar (activo, passivo e capital, incluindo o resultado acabado de apurar), por conta,
 * terceiro e centro de custo. Arredondamentos que impeçam o equilíbrio são impossíveis com saldos já arredondados
 * por linha, mas a soma é verificada pelo próprio lançamento.
 */
async function balanceSheet(scope: TenantScope, y: YearRow, scale: number) {
  const r = await scope.trx.rawQuery(
    `select a.id as "accountId", l.third_party_ref as "thirdPartyRef", l.cost_center_id as "costCenterId",
            round(sum(l.debit_functional - l.credit_functional), ?::int)::text as balance
       from journal_lines l
       join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
       join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ? and e.fiscal_year_id = ? and e.status = 'POSTED' and a.nature in ('ASSET','LIABILITY','EQUITY')
      group by a.id, a.code, l.third_party_ref, l.cost_center_id order by a.code`,
    [scale, scope.context.tenantId, y.id]
  )
  return (
    r.rows as {
      accountId: string
      thirdPartyRef: string | null
      costCenterId: string | null
      balance: string
    }[]
  )
    .map((g) => ({ ...g, balance: signed(g.balance, scale) }))
    .filter((g) => g.balance !== 0n)
}
