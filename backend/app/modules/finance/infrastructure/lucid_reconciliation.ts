import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import {
  remainingOf,
  stateOf,
  type StatementLineValues,
} from '#modules/finance/domain/reconciliation'
import type {
  EntryFilter,
  LineFilter,
  ReconEntry,
  ReconMatch,
  ReconSummary,
  ReconciliationStore,
  StatementBatch,
  StatementLine,
} from '#modules/finance/application/reconciliation_ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const constraintOf = (error: unknown): string | undefined =>
  (error as { constraint?: string } | null)?.constraint

const dateText = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value)

// --- lotes ------------------------------------------------------------------------------------------

interface BatchRow {
  id: string
  account_id: string
  file_name: string | null
  line_count: number
  skipped_count: number
  version: number
  created_at: Date
  updated_at: Date
}

const BATCH_COLUMNS = `id, account_id, file_name, line_count, skipped_count, version, created_at, updated_at`

const toBatch = (r: BatchRow): StatementBatch => ({
  id: r.id,
  accountId: r.account_id,
  fileName: r.file_name,
  lineCount: r.line_count,
  skippedCount: r.skipped_count,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// --- linhas e movimentos ----------------------------------------------------------------------------

interface LineRow {
  id: string
  account_id: string
  batch_id: string
  external_id: string | null
  occurred_on: string | Date
  amount_signed: string
  description: string | null
  reference: string | null
  matched: string
}

/** O que está conciliado vem sempre da soma das correspondências activas: nunca é um campo. */
const LINE_SELECT = `
  select l.id, l.account_id, l.batch_id, l.external_id, l.occurred_on, l.amount_signed, l.description, l.reference,
         coalesce((select sum(m.matched_amount) from reconciliation_matches m
                    where m.tenant_id = l.tenant_id and m.statement_line_id = l.id and m.undone_at is null),
                  0)::numeric(19,4) as matched,
         l.tenant_id
    from bank_statement_lines l`

const toLine = (r: LineRow): StatementLine => ({
  id: r.id,
  accountId: r.account_id,
  batchId: r.batch_id,
  externalId: r.external_id,
  occurredOn: dateText(r.occurred_on),
  amountSigned: r.amount_signed,
  description: r.description,
  reference: r.reference,
  matched: r.matched,
  remaining: remainingOf(r.amount_signed, r.matched),
  state: stateOf(r.amount_signed, r.matched),
})

interface EntryRow {
  id: string
  account_id: string
  payment_id: string | null
  payment_reference: string | null
  party_name: string | null
  amount_signed: string
  occurred_on: string | Date
  reversal_of_id: string | null
  matched: string
}

const ENTRY_SELECT = `
  select e.id, e.account_id, e.payment_id, pay.reference as payment_reference, pt.display_name as party_name,
         e.amount_signed, e.occurred_on, e.reversal_of_id,
         coalesce((select sum(m.matched_amount) from reconciliation_matches m
                    where m.tenant_id = e.tenant_id and m.treasury_entry_id = e.id and m.undone_at is null),
                  0)::numeric(19,4) as matched,
         e.tenant_id
    from treasury_entries e
    left join payments pay on pay.tenant_id = e.tenant_id and pay.id = e.payment_id
    left join parties pt on pt.tenant_id = pay.tenant_id and pt.id = pay.party_id`

const toEntry = (r: EntryRow): ReconEntry => ({
  id: r.id,
  accountId: r.account_id,
  paymentId: r.payment_id,
  paymentReference: r.payment_reference,
  partyName: r.party_name,
  amountSigned: r.amount_signed,
  occurredOn: dateText(r.occurred_on),
  reversalOfId: r.reversal_of_id,
  matched: r.matched,
  remaining: remainingOf(r.amount_signed, r.matched),
  state: stateOf(r.amount_signed, r.matched),
})

/** Condição SQL do estado derivado, sobre as colunas `matched` e `amount_signed` do alias `x`. */
const STATE_SQL: Record<string, string> = {
  UNMATCHED: 'x.matched = 0',
  PARTIAL: 'x.matched > 0 and x.matched < abs(x.amount_signed)',
  MATCHED: 'x.matched >= abs(x.amount_signed)',
}

interface MatchRow {
  id: string
  account_id: string
  statement_line_id: string
  treasury_entry_id: string
  matched_amount: string
  confirmed_at: Date
  created_by_membership_id: string | null
  undone_at: Date | null
  undone_by_membership_id: string | null
  undo_reason: string | null
}

const MATCH_COLUMNS = `id, account_id, statement_line_id, treasury_entry_id, matched_amount, confirmed_at,
  created_by_membership_id, undone_at, undone_by_membership_id, undo_reason`

const toMatch = (r: MatchRow): ReconMatch => ({
  id: r.id,
  accountId: r.account_id,
  statementLineId: r.statement_line_id,
  treasuryEntryId: r.treasury_entry_id,
  matchedAmount: r.matched_amount,
  confirmedAt: r.confirmed_at,
  confirmedByMembershipId: r.created_by_membership_id,
  undoneAt: r.undone_at,
  undoneByMembershipId: r.undone_by_membership_id,
  undoReason: r.undo_reason,
})

export class LucidReconciliationStore implements ReconciliationStore {
  async importBatch(
    scope: TenantScope,
    values: { accountId: string; fileName: string | null; lines: readonly StatementLineValues[] }
  ) {
    const trx = trxOf(scope)
    // Serializa as importações da mesma conta: o que já existe vê-se sempre por inteiro.
    await trx.rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
      `bank-import:${tenantOf(scope)}:${values.accountId}`,
    ] as never[])
    const known = await trx.rawQuery(
      `select fingerprint from bank_statement_lines
        where tenant_id = ? and account_id = ? and fingerprint = any(?::text[])`,
      [tenantOf(scope), values.accountId, values.lines.map((l) => l.fingerprint)] as never[]
    )
    const existing = new Set((known.rows as { fingerprint: string }[]).map((r) => r.fingerprint))
    const fresh = values.lines.filter((l) => !existing.has(l.fingerprint))
    const skipped = values.lines.length - fresh.length
    if (fresh.length === 0) return { batch: null, imported: 0, skipped }

    const created = await trx.rawQuery(
      `insert into bank_statement_batches (tenant_id, account_id, file_name, line_count, skipped_count,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?) returning ${BATCH_COLUMNS}`,
      [
        tenantOf(scope),
        values.accountId,
        values.fileName,
        fresh.length,
        skipped,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    const batch = created.rows[0] as BatchRow
    const placeholders = fresh.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    await trx.rawQuery(
      `insert into bank_statement_lines (tenant_id, account_id, batch_id, fingerprint, external_id, occurred_on,
         amount_signed, description, reference, created_by_membership_id, updated_by_membership_id)
       values ${placeholders}`,
      fresh.flatMap((l) => [
        tenantOf(scope),
        values.accountId,
        batch.id,
        l.fingerprint,
        l.externalId,
        l.occurredOn,
        l.amountSigned,
        l.description,
        l.reference,
        actorOf(scope),
        actorOf(scope),
      ]) as never[]
    )
    return { batch: toBatch(batch), imported: fresh.length, skipped }
  }

  async listBatches(scope: TenantScope, accountId: string, limit: number, offset: number) {
    const rows = await trxOf(scope).rawQuery(
      `select ${BATCH_COLUMNS} from bank_statement_batches
        where tenant_id = ? and account_id = ? order by created_at desc, id limit ? offset ?`,
      [tenantOf(scope), accountId, limit, offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from bank_statement_batches where tenant_id = ? and account_id = ?`,
      [tenantOf(scope), accountId] as never[]
    )
    return {
      items: (rows.rows as BatchRow[]).map(toBatch),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async findBatch(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${BATCH_COLUMNS} from bank_statement_batches where tenant_id = ? and id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as BatchRow[]
    return row ? toBatch(row) : null
  }

  async discardBatch(scope: TenantScope, id: string) {
    const used = await trxOf(scope).rawQuery(
      `select 1 from reconciliation_matches m
         join bank_statement_lines l on l.tenant_id = m.tenant_id and l.id = m.statement_line_id
        where m.tenant_id = ? and l.batch_id = ? limit 1`,
      [tenantOf(scope), id] as never[]
    )
    if (used.rows.length > 0) return false
    await trxOf(scope).rawQuery(
      `delete from bank_statement_lines where tenant_id = ? and batch_id = ?`,
      [tenantOf(scope), id] as never[]
    )
    await trxOf(scope).rawQuery(
      `delete from bank_statement_batches where tenant_id = ? and id = ?`,
      [tenantOf(scope), id] as never[]
    )
    return true
  }

  async listLines(scope: TenantScope, filter: LineFilter) {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.state) where.push(STATE_SQL[filter.state])
    if (filter.from) {
      where.push('x.occurred_on >= ?')
      params.push(filter.from)
    }
    if (filter.to) {
      where.push('x.occurred_on <= ?')
      params.push(filter.to)
    }
    if (filter.batchId) {
      where.push('x.batch_id = ?')
      params.push(filter.batchId)
    }
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : ''
    const base = `(${LINE_SELECT} where l.tenant_id = ? and l.account_id = ?) x`
    const rows = await trxOf(scope).rawQuery(
      `select * from ${base} ${clause} order by x.occurred_on desc, x.id limit ? offset ?`,
      [tenantOf(scope), filter.accountId, ...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from ${base} ${clause}`,
      [tenantOf(scope), filter.accountId, ...params] as never[]
    )
    return {
      items: (rows.rows as LineRow[]).map(toLine),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async findLine(scope: TenantScope, id: string, lock = false) {
    if (lock) {
      await trxOf(scope).rawQuery(
        `select 1 from bank_statement_lines where tenant_id = ? and id = ? for update`,
        [tenantOf(scope), id] as never[]
      )
    }
    const result = await trxOf(scope).rawQuery(
      `${LINE_SELECT} where l.tenant_id = ? and l.id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as LineRow[]
    return row ? toLine(row) : null
  }

  async listEntries(scope: TenantScope, filter: EntryFilter) {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.state) where.push(STATE_SQL[filter.state])
    if (filter.from) {
      where.push('x.occurred_on >= ?')
      params.push(filter.from)
    }
    if (filter.to) {
      where.push('x.occurred_on <= ?')
      params.push(filter.to)
    }
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : ''
    const base = `(${ENTRY_SELECT} where e.tenant_id = ? and e.account_id = ?) x`
    const rows = await trxOf(scope).rawQuery(
      `select * from ${base} ${clause} order by x.occurred_on desc, x.id limit ? offset ?`,
      [tenantOf(scope), filter.accountId, ...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from ${base} ${clause}`,
      [tenantOf(scope), filter.accountId, ...params] as never[]
    )
    return {
      items: (rows.rows as EntryRow[]).map(toEntry),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async findEntry(scope: TenantScope, id: string, lock = false) {
    if (lock) {
      await trxOf(scope).rawQuery(
        `select 1 from treasury_entries where tenant_id = ? and id = ? for update`,
        [tenantOf(scope), id] as never[]
      )
    }
    const result = await trxOf(scope).rawQuery(
      `${ENTRY_SELECT} where e.tenant_id = ? and e.id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as EntryRow[]
    return row ? toEntry(row) : null
  }

  async candidates(scope: TenantScope, accountId: string, from: string, to: string) {
    const rows = await trxOf(scope).rawQuery(
      `select * from (${ENTRY_SELECT} where e.tenant_id = ? and e.account_id = ?
                        and e.occurred_on between ? and ?) x
        where x.matched < abs(x.amount_signed)
        order by x.occurred_on, x.id limit 300`,
      [tenantOf(scope), accountId, from, to] as never[]
    )
    return (rows.rows as EntryRow[]).map(toEntry)
  }

  async insertMatch(
    scope: TenantScope,
    values: {
      accountId: string
      statementLineId: string
      treasuryEntryId: string
      matchedAmount: string
    }
  ) {
    const trx = trxOf(scope)
    const pair = await trx.rawQuery(
      `select 1 from reconciliation_matches
        where tenant_id = ? and statement_line_id = ? and treasury_entry_id = ? and undone_at is null`,
      [tenantOf(scope), values.statementLineId, values.treasuryEntryId] as never[]
    )
    if (pair.rows.length > 0) return 'PAIR' as const
    try {
      const result = await trx.rawQuery(
        `insert into reconciliation_matches (tenant_id, account_id, statement_line_id, treasury_entry_id,
           matched_amount, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?) returning ${MATCH_COLUMNS}`,
        [
          tenantOf(scope),
          values.accountId,
          values.statementLineId,
          values.treasuryEntryId,
          values.matchedAmount,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return toMatch(result.rows[0] as MatchRow)
    } catch (error) {
      if (constraintOf(error) === 'reconciliation_matches_active_pair_unique')
        return 'PAIR' as const
      throw error
    }
  }

  async findMatch(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${MATCH_COLUMNS} from reconciliation_matches where tenant_id = ? and id = ?${
        lock ? ' for update' : ''
      }`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as MatchRow[]
    return row ? toMatch(row) : null
  }

  async lineMatches(scope: TenantScope, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${MATCH_COLUMNS} from reconciliation_matches
        where tenant_id = ? and statement_line_id = ? order by confirmed_at, id`,
      [tenantOf(scope), lineId] as never[]
    )
    return (result.rows as MatchRow[]).map(toMatch)
  }

  async entryMatches(scope: TenantScope, entryId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${MATCH_COLUMNS} from reconciliation_matches
        where tenant_id = ? and treasury_entry_id = ? order by confirmed_at, id`,
      [tenantOf(scope), entryId] as never[]
    )
    return (result.rows as MatchRow[]).map(toMatch)
  }

  async markUndone(scope: TenantScope, id: string, reason: string) {
    const result = await trxOf(scope).rawQuery(
      `update reconciliation_matches
          set undone_at = now(), undone_by_membership_id = ?, undo_reason = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and undone_at is null returning ${MATCH_COLUMNS}`,
      [actorOf(scope), reason, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return toMatch(result.rows[0] as MatchRow)
  }

  async summary(scope: TenantScope, accountId: string, currency: string): Promise<ReconSummary> {
    const trx = trxOf(scope)
    const tenant = tenantOf(scope)
    const book = await trx.rawQuery(
      `select coalesce(sum(amount_signed), 0)::numeric(19,4) as total
         from treasury_entries where tenant_id = ? and account_id = ?`,
      [tenant, accountId] as never[]
    )
    const side = async (select: string, filter: string) => {
      const result = await trx.rawQuery(
        `select count(*)::int as total,
                count(*) filter (where x.matched = 0)::int as unmatched,
                count(*) filter (where x.matched > 0 and x.matched < abs(x.amount_signed))::int as partial,
                count(*) filter (where x.matched >= abs(x.amount_signed))::int as matched,
                coalesce(sum(sign(x.amount_signed) * greatest(abs(x.amount_signed) - x.matched, 0)), 0)::numeric(19,4)
                  as open_amount,
                coalesce(sum(x.amount_signed), 0)::numeric(19,4) as total_amount
           from (${select} where ${filter}.tenant_id = ? and ${filter}.account_id = ?) x`,
        [tenant, accountId] as never[]
      )
      return result.rows[0] as {
        total: number
        unmatched: number
        partial: number
        matched: number
        open_amount: string
        total_amount: string
      }
    }
    const lines = await side(LINE_SELECT, 'l')
    const entries = await side(ENTRY_SELECT, 'e')
    return {
      accountId,
      currency,
      bookBalance: (book.rows[0] as { total: string }).total,
      statementTotal: lines.total_amount,
      lines: {
        total: lines.total,
        unmatched: lines.unmatched,
        partial: lines.partial,
        matched: lines.matched,
      },
      entries: {
        total: entries.total,
        unmatched: entries.unmatched,
        partial: entries.partial,
        matched: entries.matched,
      },
      unmatchedStatementAmount: lines.open_amount,
      unmatchedBookAmount: entries.open_amount,
    }
  }
}
