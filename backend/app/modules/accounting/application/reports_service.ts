import { ApiError } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { tenantSettings } from '#modules/settings/index'
import { legalEntityFacts } from '#modules/organization/index'
import { formatDecimal, parseDecimal } from '#modules/accounting/domain/decimal'
import {
  buildTrialBalance,
  type TbAccount,
  type TbAmounts,
} from '#modules/accounting/domain/trial_balance'

/**
 * Razão e balancete. Contam só lançamentos **contabilizados**, sempre na moeda funcional da entidade legal. Os
 * montantes chegam do SQL como texto decimal e são somados em BigInt (nunca `float`).
 */
const MAX_LEDGER_ROWS = 5000

const signedText = (v: bigint, scale: number) => formatDecimal(v, scale)
const toBig = (v: unknown, scale: number) => {
  const text = String(v ?? '0')
  const negative = text.startsWith('-')
  const n = parseDecimal(negative ? text.slice(1) : text, scale) ?? 0n
  return negative ? -n : n
}

async function scaleOf(scope: TenantScope) {
  return (await tenantSettings(scope)).amountScale
}

async function fiscalYear(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select id, legal_entity_id, code, start_date::text as start_date, end_date::text as end_date, status
       from fiscal_years where tenant_id = ? and id = ?`,
    [scope.context.tenantId, id]
  )
  const y = r.rows[0] as
    | {
        id: string
        legal_entity_id: string
        code: string
        start_date: string
        end_date: string
        status: string
      }
    | undefined
  if (!y) throw ApiError.notFound()
  return y
}

/** Contas de todos os planos da entidade (um lançamento antigo pode ser de um plano entretanto inactivado). */
async function accountsOf(scope: TenantScope, legalEntityId: string): Promise<TbAccount[]> {
  const r = await scope.trx.rawQuery(
    `select a.id, a.parent_id as "parentId", a.code, a.name, a.level, a.postable
       from accounts a join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
      where a.tenant_id = ? and c.legal_entity_id = ?`,
    [scope.context.tenantId, legalEntityId]
  )
  return r.rows as TbAccount[]
}

export interface TrialBalanceQuery {
  fiscalYearId: string
  fromPeriod: number
  toPeriod: number
  mode: 'analytic' | 'synthetic'
  maxDepth?: number
  includeZero?: boolean
}

export interface LedgerQuery {
  legalEntityId: string
  accountId: string
  from: string
  to: string
  thirdPartyRef?: string
  costCenterId?: string
}

export class AccountingReportsService {
  /**
   * Balancete de um exercício entre dois períodos (números; 0 = abertura). Saldo anterior = movimentos dos períodos
   * anteriores do mesmo exercício (incluindo a abertura); movimentos = débitos e créditos do intervalo.
   */
  trialBalance(context: TenantContext, q: TrialBalanceQuery) {
    return runInTenant(context, async (scope) => {
      const year = await fiscalYear(scope, q.fiscalYearId)
      if (q.fromPeriod > q.toPeriod)
        throw ApiError.validation([
          { path: 'toPeriod', code: 'RANGE', message: 'O período final é anterior ao inicial.' },
        ])
      const scale = await scaleOf(scope)
      const r = await scope.trx.rawQuery(
        `select l.account_id,
                round(coalesce(sum(case when p.number < ? then l.debit_functional - l.credit_functional end), 0), ?::int)::text as opening,
                round(coalesce(sum(case when p.number >= ? then l.debit_functional end), 0), ?::int)::text as debit,
                round(coalesce(sum(case when p.number >= ? then l.credit_functional end), 0), ?::int)::text as credit
           from journal_lines l
           join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
           join fiscal_periods p on p.tenant_id = e.tenant_id and p.id = e.period_id
          where l.tenant_id = ? and e.fiscal_year_id = ? and e.status = 'POSTED' and p.number <= ?
          group by l.account_id`,
        [
          q.fromPeriod,
          scale,
          q.fromPeriod,
          scale,
          q.fromPeriod,
          scale,
          context.tenantId,
          year.id,
          q.toPeriod,
        ] as never[]
      )
      const amounts = new Map<string, TbAmounts>(
        (r.rows as { account_id: string; opening: string; debit: string; credit: string }[]).map(
          (x) => [
            x.account_id,
            {
              opening: toBig(x.opening, scale),
              debit: toBig(x.debit, scale),
              credit: toBig(x.credit, scale),
            },
          ]
        )
      )
      const tb = buildTrialBalance(await accountsOf(scope, year.legal_entity_id), amounts, {
        mode: q.mode,
        maxDepth: q.maxDepth,
        includeZero: q.includeZero,
      })
      const out = (v: bigint) => signedText(v, scale)
      return {
        fiscalYear: { id: year.id, code: year.code, legalEntityId: year.legal_entity_id },
        fromPeriod: q.fromPeriod,
        toPeriod: q.toPeriod,
        mode: q.mode,
        balanced: tb.balanced,
        rows: tb.rows.map((row) => ({
          ...row,
          opening: out(row.opening),
          debit: out(row.debit),
          credit: out(row.credit),
          closing: out(row.closing),
        })),
        totals: {
          opening: out(tb.totals.opening),
          debit: out(tb.totals.debit),
          credit: out(tb.totals.credit),
          closingDebit: out(tb.totals.closingDebit),
          closingCredit: out(tb.totals.closingCredit),
        },
      }
    })
  }

  /**
   * Razão de uma conta (e das suas subcontas, se for uma conta-mãe) entre duas datas do mesmo exercício, com saldo
   * anterior (movimentos do exercício antes de `from`) e saldo acumulado linha a linha.
   */
  ledger(context: TenantContext, q: LedgerQuery) {
    return runInTenant(context, async (scope) => {
      if (q.to < q.from)
        throw ApiError.validation([
          { path: 'to', code: 'RANGE', message: 'A data final é anterior à inicial.' },
        ])
      // Entidade de outra empresa (ou inexistente): 404, como qualquer registo fora do tenant.
      if (!(await legalEntityFacts(scope, q.legalEntityId))) throw ApiError.notFound()
      const y = await scope.trx.rawQuery(
        `select id, code, start_date::text as start_date, end_date::text as end_date from fiscal_years
          where tenant_id = ? and legal_entity_id = ? and ?::date between start_date and end_date`,
        [context.tenantId, q.legalEntityId, q.from]
      )
      const year = y.rows[0] as
        { id: string; code: string; start_date: string; end_date: string } | undefined
      if (!year)
        throw ApiError.validation([
          { path: 'from', code: 'NO_FISCAL_YEAR', message: 'Não há exercício nesta data.' },
        ])
      if (q.to > year.end_date)
        throw ApiError.validation([
          {
            path: 'to',
            code: 'OTHER_FISCAL_YEAR',
            message: `O razão é por exercício: até ${year.end_date}.`,
          },
        ])
      const acc = await scope.trx.rawQuery(
        `select a.id, a.code, a.name, a.postable from accounts a
           join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
          where a.tenant_id = ? and a.id = ? and c.legal_entity_id = ?`,
        [context.tenantId, q.accountId, q.legalEntityId]
      )
      const account = acc.rows[0] as
        { id: string; code: string; name: string; postable: boolean } | undefined
      if (!account) throw ApiError.notFound()
      const scale = await scaleOf(scope)
      const filters: string[] = []
      const params: unknown[] = []
      if (q.thirdPartyRef) {
        filters.push('l.third_party_ref = ?')
        params.push(q.thirdPartyRef)
      }
      if (q.costCenterId) {
        filters.push('l.cost_center_id = ?')
        params.push(q.costCenterId)
      }
      const extra = filters.length ? ` and ${filters.join(' and ')}` : ''
      // Conta e descendentes (CTE recursiva sobre a árvore do plano).
      const tree = `with recursive tree as (
          select id from accounts where tenant_id = ? and id = ?
          union all select a.id from accounts a join tree t on a.parent_id = t.id where a.tenant_id = ?)`
      const base = `from journal_lines l
          join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
          join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
         where l.tenant_id = ? and e.status = 'POSTED' and e.fiscal_year_id = ? and l.account_id in (select id from tree)${extra}`
      const treeParams = [context.tenantId, account.id, context.tenantId]
      const before = await scope.trx.rawQuery(
        `${tree} select round(coalesce(sum(l.debit_functional - l.credit_functional), 0), ?::int)::text as balance
           ${base} and e.entry_date < ?::date`,
        [...treeParams, scale, context.tenantId, year.id, ...params, q.from] as never[]
      )
      const rows = await scope.trx.rawQuery(
        `${tree} select e.id as "entryId", e.number, e.entry_date::text as "date", e.description as "entryDescription",
                l.description, a.code as "accountCode", l.third_party_ref as "thirdPartyRef", l.cost_center_id as "costCenterId",
                round(l.debit_functional, ?::int)::text as debit, round(l.credit_functional, ?::int)::text as credit
           ${base} and e.entry_date between ?::date and ?::date
          order by e.entry_date, e.number, l.line_no
          limit ?`,
        [
          ...treeParams,
          scale,
          scale,
          context.tenantId,
          year.id,
          ...params,
          q.from,
          q.to,
          MAX_LEDGER_ROWS + 1,
        ] as never[]
      )
      // Totais do intervalo calculados à parte: não dependem do limite de linhas devolvidas.
      const sums = await scope.trx.rawQuery(
        `${tree} select round(coalesce(sum(l.debit_functional), 0), ?::int)::text as debit,
                round(coalesce(sum(l.credit_functional), 0), ?::int)::text as credit
           ${base} and e.entry_date between ?::date and ?::date`,
        [...treeParams, scale, scale, context.tenantId, year.id, ...params, q.from, q.to] as never[]
      )
      const opening = toBig((before.rows[0] as { balance: string }).balance, scale)
      const debit = toBig((sums.rows[0] as { debit: string }).debit, scale)
      const credit = toBig((sums.rows[0] as { credit: string }).credit, scale)
      let running = opening
      const lines = (rows.rows as Record<string, string>[]).slice(0, MAX_LEDGER_ROWS).map((r) => {
        running += toBig(r.debit, scale) - toBig(r.credit, scale)
        return { ...r, balance: signedText(running, scale) }
      })
      const balance = opening + debit - credit
      return {
        account: {
          id: account.id,
          code: account.code,
          name: account.name,
          includesSubaccounts: !account.postable,
        },
        fiscalYear: { id: year.id, code: year.code },
        from: q.from,
        to: q.to,
        opening: signedText(opening, scale),
        debit: signedText(debit, scale),
        credit: signedText(credit, scale),
        closing: signedText(balance, scale),
        lines,
        truncated: rows.rows.length > MAX_LEDGER_ROWS,
      }
    })
  }
}
