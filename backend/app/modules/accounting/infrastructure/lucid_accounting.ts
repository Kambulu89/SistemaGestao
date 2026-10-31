import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { LineInput } from '#modules/accounting/domain/accounting'
import type {
  AccountRecord,
  AccountingStore,
  EntryFilter,
  EntryRecord,
  FiscalYearRecord,
  JournalRecord,
  LedgerRow,
  LineRecord,
  NewAccount,
  NewEntry,
  PeriodRecord,
  RuleRecord,
  TrialRow,
} from '#modules/accounting/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

type Bind = never[]
async function query<T>(scope: TenantScope, sql: string, bindings: unknown[] = []): Promise<T[]> {
  const result = await trxOf(scope).rawQuery(sql, bindings as Bind)
  return result.rows as T[]
}

async function exists(scope: TenantScope, table: string, id: string): Promise<boolean> {
  const rows = await query(scope, `select 1 from ${table} where id = ?`, [id])
  return rows.length > 0
}

const ids = (list: readonly string[]) => list.join(',')
const inIds = (column: string) => `${column}::text = ANY(string_to_array(?, ','))`

// --- plano de contas ---------------------------------------------------------------------------------

const ACC = `id, organization_id, code, name, account_class, nature, kind, parent_id, requires_cost_center,
  requires_party, active, version`
interface AccountRow {
  id: string
  organization_id: string
  code: string
  name: string
  account_class: number
  nature: AccountRecord['nature']
  kind: AccountRecord['kind']
  parent_id: string | null
  requires_cost_center: boolean
  requires_party: boolean
  active: boolean
  version: number
}
const toAccount = (r: AccountRow): AccountRecord => ({
  id: r.id,
  organizationId: r.organization_id,
  code: r.code,
  name: r.name,
  accountClass: r.account_class,
  nature: r.nature,
  kind: r.kind,
  parentId: r.parent_id,
  requiresCostCenter: r.requires_cost_center,
  requiresParty: r.requires_party,
  active: r.active,
  version: r.version,
})

// --- exercícios e períodos ---------------------------------------------------------------------------

const FY = `id, organization_id, code, starts_on::text as starts_on, ends_on::text as ends_on, status, version`
interface FyRow {
  id: string
  organization_id: string
  code: string
  starts_on: string
  ends_on: string
  status: 'OPEN' | 'CLOSED'
  version: number
}
const toYear = (r: FyRow): FiscalYearRecord => ({
  id: r.id,
  organizationId: r.organization_id,
  code: r.code,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  status: r.status,
  version: r.version,
})

const PER = `id, fiscal_year_id, number, starts_on::text as starts_on, ends_on::text as ends_on, status, version`
interface PerRow {
  id: string
  fiscal_year_id: string
  number: number
  starts_on: string
  ends_on: string
  status: 'OPEN' | 'CLOSED'
  version: number
}
const toPeriod = (r: PerRow): PeriodRecord => ({
  id: r.id,
  fiscalYearId: r.fiscal_year_id,
  number: r.number,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  status: r.status,
  version: r.version,
})

// --- diários -----------------------------------------------------------------------------------------

const JR = 'id, organization_id, code, name, type, active, version'
interface JrRow {
  id: string
  organization_id: string
  code: string
  name: string
  type: JournalRecord['type']
  active: boolean
  version: number
}
const toJournal = (r: JrRow): JournalRecord => ({
  id: r.id,
  organizationId: r.organization_id,
  code: r.code,
  name: r.name,
  type: r.type,
  active: r.active,
  version: r.version,
})

// --- lançamentos -------------------------------------------------------------------------------------

const EN = `id, organization_id, journal_id, fiscal_year_id, period_id, number, entry_date::text as entry_date, description,
  status, source_type, source_id, source_key, reversal_of_id, total_debit::text as total_debit,
  total_credit::text as total_credit, posted_at, version, created_at`
interface EnRow {
  id: string
  organization_id: string
  journal_id: string
  fiscal_year_id: string
  period_id: string
  number: number | null
  entry_date: string
  description: string
  status: EntryRecord['status']
  source_type: string | null
  source_id: string | null
  source_key: string | null
  reversal_of_id: string | null
  total_debit: string
  total_credit: string
  posted_at: Date | null
  version: number
  created_at: Date
}
const toEntry = (r: EnRow): EntryRecord => ({
  id: r.id,
  organizationId: r.organization_id,
  journalId: r.journal_id,
  fiscalYearId: r.fiscal_year_id,
  periodId: r.period_id,
  number: r.number,
  entryDate: r.entry_date,
  description: r.description,
  status: r.status,
  sourceType: r.source_type,
  sourceId: r.source_id,
  sourceKey: r.source_key,
  reversalOfId: r.reversal_of_id,
  totalDebit: r.total_debit,
  totalCredit: r.total_credit,
  postedAt: r.posted_at,
  version: r.version,
  createdAt: r.created_at,
})

const RU = 'id, organization_id, event_type, role, account_id, journal_id, version'
interface RuRow {
  id: string
  organization_id: string
  event_type: string
  role: string
  account_id: string
  journal_id: string
  version: number
}
const toRule = (r: RuRow): RuleRecord => ({
  id: r.id,
  organizationId: r.organization_id,
  eventType: r.event_type,
  role: r.role,
  accountId: r.account_id,
  journalId: r.journal_id,
  version: r.version,
})

const orgFilter = (column: string, organizationId: string | null): [string, unknown[]] =>
  organizationId ? [`where ${column} = ?`, [organizationId]] : ['', []]

export class LucidAccountingStore implements AccountingStore {
  organizationExists(scope: TenantScope, id: string) {
    return exists(scope, 'organizations', id)
  }

  costCenterExists(scope: TenantScope, id: string) {
    return exists(scope, 'cost_centers', id)
  }

  partyExists(scope: TenantScope, id: string) {
    return exists(scope, 'parties', id)
  }

  // --- plano de contas -------------------------------------------------------------------------------

  async accounts(scope: TenantScope, organizationId: string | null) {
    const [where, bind] = orgFilter('organization_id', organizationId)
    const rows = await query<AccountRow>(
      scope,
      `select ${ACC} from ledger_accounts ${where} order by organization_id, code`,
      bind
    )
    return rows.map(toAccount)
  }

  async account(scope: TenantScope, id: string) {
    const rows = await query<AccountRow>(scope, `select ${ACC} from ledger_accounts where id = ?`, [
      id,
    ])
    return rows[0] ? toAccount(rows[0]) : null
  }

  async accountByCode(scope: TenantScope, organizationId: string, code: string) {
    const rows = await query<AccountRow>(
      scope,
      `select ${ACC} from ledger_accounts where organization_id = ? and code = ?`,
      [organizationId, code]
    )
    return rows[0] ? toAccount(rows[0]) : null
  }

  async accountsByIds(scope: TenantScope, list: string[]) {
    if (list.length === 0) return []
    const rows = await query<AccountRow>(
      scope,
      `select ${ACC} from ledger_accounts where ${inIds('id')}`,
      [ids(list)]
    )
    return rows.map(toAccount)
  }

  async insertAccount(scope: TenantScope, v: NewAccount) {
    const rows = await query<AccountRow>(
      scope,
      `insert into ledger_accounts (tenant_id, organization_id, code, name, account_class, nature, kind, parent_id,
         requires_cost_center, requires_party, active, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, organization_id, code) do nothing returning ${ACC}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.code,
        v.name,
        v.accountClass,
        v.nature,
        v.kind,
        v.parentId,
        v.requiresCostCenter,
        v.requiresParty,
        v.active,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return rows[0] ? toAccount(rows[0]) : null
  }

  async updateAccount(
    scope: TenantScope,
    id: string,
    version: number,
    v: Pick<AccountRecord, 'name' | 'requiresCostCenter' | 'requiresParty' | 'active'>
  ) {
    const rows = await query<AccountRow>(
      scope,
      `update ledger_accounts set name = ?, requires_cost_center = ?, requires_party = ?, active = ?,
         version = version + 1, updated_at = now(), updated_by_membership_id = ?
       where id = ? and version = ? returning ${ACC}`,
      [v.name, v.requiresCostCenter, v.requiresParty, v.active, actorOf(scope), id, version]
    )
    return rows[0] ? toAccount(rows[0]) : null
  }

  async deleteAccount(scope: TenantScope, id: string) {
    const rows = await query(scope, `delete from ledger_accounts where id = ? returning id`, [id])
    return rows.length > 0
  }

  async accountHasLines(scope: TenantScope, id: string) {
    const rows = await query(scope, `select 1 from journal_lines where account_id = ? limit 1`, [
      id,
    ])
    return rows.length > 0
  }

  // --- exercícios ------------------------------------------------------------------------------------

  async fiscalYears(scope: TenantScope, organizationId: string | null) {
    const [where, bind] = orgFilter('organization_id', organizationId)
    const rows = await query<FyRow>(
      scope,
      `select ${FY} from fiscal_years ${where} order by organization_id, starts_on desc`,
      bind
    )
    return rows.map(toYear)
  }

  async fiscalYear(scope: TenantScope, id: string, lock = false) {
    const rows = await query<FyRow>(
      scope,
      `select ${FY} from fiscal_years where id = ?${lock ? ' for update' : ''}`,
      [id]
    )
    return rows[0] ? toYear(rows[0]) : null
  }

  async insertFiscalYear(
    scope: TenantScope,
    v: Omit<FiscalYearRecord, 'id' | 'version' | 'status'>
  ) {
    const rows = await query<FyRow>(
      scope,
      `insert into fiscal_years (tenant_id, organization_id, code, starts_on, ends_on, created_by_membership_id,
         updated_by_membership_id) values (?, ?, ?, ?, ?, ?, ?) returning ${FY}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.code,
        v.startsOn,
        v.endsOn,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toYear(rows[0] as FyRow)
  }

  async closeFiscalYear(scope: TenantScope, id: string) {
    const rows = await query<FyRow>(
      scope,
      `update fiscal_years set status = 'CLOSED', version = version + 1, updated_at = now(),
         updated_by_membership_id = ? where id = ? returning ${FY}`,
      [actorOf(scope), id]
    )
    return toYear(rows[0] as FyRow)
  }

  async periods(scope: TenantScope, fiscalYearIds: string[]) {
    if (fiscalYearIds.length === 0) return []
    const rows = await query<PerRow>(
      scope,
      `select ${PER} from fiscal_periods where ${inIds('fiscal_year_id')} order by fiscal_year_id, number`,
      [ids(fiscalYearIds)]
    )
    return rows.map(toPeriod)
  }

  async period(scope: TenantScope, id: string, lock = false) {
    const rows = await query<PerRow>(
      scope,
      `select ${PER} from fiscal_periods where id = ?${lock ? ' for update' : ''}`,
      [id]
    )
    return rows[0] ? toPeriod(rows[0]) : null
  }

  async insertPeriod(scope: TenantScope, v: Omit<PeriodRecord, 'id' | 'version' | 'status'>) {
    await query(
      scope,
      `insert into fiscal_periods (tenant_id, fiscal_year_id, number, starts_on, ends_on, created_by_membership_id,
         updated_by_membership_id) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        v.fiscalYearId,
        v.number,
        v.startsOn,
        v.endsOn,
        actorOf(scope),
        actorOf(scope),
      ]
    )
  }

  async setPeriodStatus(scope: TenantScope, id: string, status: 'OPEN' | 'CLOSED') {
    const rows = await query<PerRow>(
      scope,
      `update fiscal_periods set status = ?, version = version + 1, updated_at = now(),
         updated_by_membership_id = ? where id = ? returning ${PER}`,
      [status, actorOf(scope), id]
    )
    return toPeriod(rows[0] as PerRow)
  }

  async periodFor(scope: TenantScope, organizationId: string, date: string) {
    const rows = await query<
      PerRow & {
        y_code: string
        y_starts: string
        y_ends: string
        y_status: string
        y_version: number
      }
    >(
      scope,
      `select p.id, p.fiscal_year_id, p.number, p.starts_on::text as starts_on, p.ends_on::text as ends_on, p.status,
              p.version, y.code as y_code, y.starts_on::text as y_starts, y.ends_on::text as y_ends,
              y.status as y_status, y.version as y_version
         from fiscal_periods p join fiscal_years y on y.id = p.fiscal_year_id
        where y.organization_id = ? and p.starts_on <= ? and p.ends_on >= ?
        limit 1`,
      [organizationId, date, date]
    )
    const r = rows[0]
    if (!r) return null
    return {
      period: toPeriod(r),
      year: {
        id: r.fiscal_year_id,
        organizationId,
        code: r.y_code,
        startsOn: r.y_starts,
        endsOn: r.y_ends,
        status: r.y_status as 'OPEN' | 'CLOSED',
        version: r.y_version,
      },
    }
  }

  async draftsIn(scope: TenantScope, periodId: string) {
    const rows = await query<{ n: number }>(
      scope,
      `select count(*)::int as n from journal_entries where period_id = ? and status = 'DRAFT'`,
      [periodId]
    )
    return rows[0]?.n ?? 0
  }

  // --- diários ---------------------------------------------------------------------------------------

  async journals(scope: TenantScope, organizationId: string | null) {
    const [where, bind] = orgFilter('organization_id', organizationId)
    const rows = await query<JrRow>(
      scope,
      `select ${JR} from journals ${where} order by organization_id, code`,
      bind
    )
    return rows.map(toJournal)
  }

  async journal(scope: TenantScope, id: string, lock = false) {
    const rows = await query<JrRow>(
      scope,
      `select ${JR} from journals where id = ?${lock ? ' for update' : ''}`,
      [id]
    )
    return rows[0] ? toJournal(rows[0]) : null
  }

  async insertJournal(scope: TenantScope, v: Omit<JournalRecord, 'id' | 'version'>) {
    const rows = await query<JrRow>(
      scope,
      `insert into journals (tenant_id, organization_id, code, name, type, active, created_by_membership_id,
         updated_by_membership_id) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, organization_id, code) do nothing returning ${JR}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.code,
        v.name,
        v.type,
        v.active,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return rows[0] ? toJournal(rows[0]) : null
  }

  async updateJournal(
    scope: TenantScope,
    id: string,
    version: number,
    v: Pick<JournalRecord, 'name' | 'active'>
  ) {
    const rows = await query<JrRow>(
      scope,
      `update journals set name = ?, active = ?, version = version + 1, updated_at = now(),
         updated_by_membership_id = ? where id = ? and version = ? returning ${JR}`,
      [v.name, v.active, actorOf(scope), id, version]
    )
    return rows[0] ? toJournal(rows[0]) : null
  }

  // --- lançamentos -----------------------------------------------------------------------------------

  async insertEntry(scope: TenantScope, v: NewEntry) {
    const rows = await query<EnRow>(
      scope,
      `insert into journal_entries (tenant_id, organization_id, journal_id, fiscal_year_id, period_id, entry_date,
         description, source_type, source_id, source_key, reversal_of_id, total_debit, total_credit,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${EN}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.journalId,
        v.fiscalYearId,
        v.periodId,
        v.entryDate,
        v.description,
        v.sourceType,
        v.sourceId,
        v.sourceKey,
        v.reversalOfId,
        v.totalDebit,
        v.totalCredit,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toEntry(rows[0] as EnRow)
  }

  async replaceLines(scope: TenantScope, entryId: string, lines: readonly LineInput[]) {
    await query(scope, `delete from journal_lines where entry_id = ?`, [entryId])
    let n = 0
    for (const l of lines) {
      n += 1
      await query(
        scope,
        `insert into journal_lines (tenant_id, entry_id, line_no, account_id, debit, credit, description,
           cost_center_id, party_id, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantOf(scope),
          entryId,
          n,
          l.accountId,
          l.debit,
          l.credit,
          l.description,
          l.costCenterId,
          l.partyId,
          actorOf(scope),
          actorOf(scope),
        ]
      )
    }
  }

  async updateDraft(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewEntry, 'organizationId' | 'sourceType' | 'sourceId' | 'sourceKey' | 'reversalOfId'>
  ) {
    const rows = await query<EnRow>(
      scope,
      `update journal_entries set journal_id = ?, fiscal_year_id = ?, period_id = ?, entry_date = ?, description = ?,
         total_debit = ?, total_credit = ?, version = version + 1, updated_at = now(), updated_by_membership_id = ?
       where id = ? and version = ? and status = 'DRAFT' returning ${EN}`,
      [
        v.journalId,
        v.fiscalYearId,
        v.periodId,
        v.entryDate,
        v.description,
        v.totalDebit,
        v.totalCredit,
        actorOf(scope),
        id,
        version,
      ]
    )
    return rows[0] ? toEntry(rows[0]) : null
  }

  async deleteDraft(scope: TenantScope, id: string) {
    const rows = await query(
      scope,
      `delete from journal_entries where id = ? and status = 'DRAFT' returning id`,
      [id]
    )
    return rows.length > 0
  }

  async entry(scope: TenantScope, id: string, lock = false) {
    const rows = await query<EnRow>(
      scope,
      `select ${EN} from journal_entries where id = ?${lock ? ' for update' : ''}`,
      [id]
    )
    return rows[0] ? toEntry(rows[0]) : null
  }

  async entryBySource(scope: TenantScope, sourceKey: string) {
    const rows = await query<EnRow>(
      scope,
      `select ${EN} from journal_entries where source_key = ?`,
      [sourceKey]
    )
    return rows[0] ? toEntry(rows[0]) : null
  }

  async entryReversing(scope: TenantScope, id: string) {
    const rows = await query<EnRow>(
      scope,
      `select ${EN} from journal_entries where reversal_of_id = ?`,
      [id]
    )
    return rows[0] ? toEntry(rows[0]) : null
  }

  async lines(scope: TenantScope, entryId: string) {
    const rows = await query<{
      id: string
      line_no: number
      account_id: string
      account_code: string
      account_name: string
      debit: string
      credit: string
      description: string | null
      cost_center_id: string | null
      party_id: string | null
    }>(
      scope,
      `select l.id, l.line_no, l.account_id, a.code as account_code, a.name as account_name, l.debit::text as debit,
              l.credit::text as credit, l.description, l.cost_center_id, l.party_id
         from journal_lines l join ledger_accounts a on a.id = l.account_id
        where l.entry_id = ? order by l.line_no`,
      [entryId]
    )
    return rows.map<LineRecord>((r) => ({
      id: r.id,
      lineNo: r.line_no,
      accountId: r.account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      debit: r.debit,
      credit: r.credit,
      description: r.description,
      costCenterId: r.cost_center_id,
      partyId: r.party_id,
    }))
  }

  async nextNumber(scope: TenantScope, journalId: string, fiscalYearId: string) {
    const rows = await query<{ n: number }>(
      scope,
      `select coalesce(max(number), 0)::int + 1 as n from journal_entries
        where journal_id = ? and fiscal_year_id = ? and number is not null`,
      [journalId, fiscalYearId]
    )
    return rows[0]?.n ?? 1
  }

  async markPosted(
    scope: TenantScope,
    id: string,
    number: number,
    at: Date,
    membershipId: string | null
  ) {
    const rows = await query<EnRow>(
      scope,
      `update journal_entries set status = 'POSTED', number = ?, posted_at = ?, posted_by_membership_id = ?,
         version = version + 1, updated_at = now(), updated_by_membership_id = ?
       where id = ? and status = 'DRAFT' returning ${EN}`,
      [number, at, membershipId, actorOf(scope), id]
    )
    // A restrição de equilíbrio é diferida (para quem insere o cabeçalho antes das linhas); aqui verifica-se já, para o
    // erro sair dentro da transacção e não só no COMMIT.
    await query(scope, 'set constraints journal_entries_balanced immediate')
    return toEntry(rows[0] as EnRow)
  }

  async markReversed(scope: TenantScope, id: string) {
    await query(
      scope,
      `update journal_entries set status = 'REVERSED', version = version + 1, updated_at = now(),
         updated_by_membership_id = ? where id = ? and status = 'POSTED'`,
      [actorOf(scope), id]
    )
  }

  async entries(scope: TenantScope, f: EntryFilter) {
    const where: string[] = []
    const bind: unknown[] = []
    if (f.organizationId) {
      where.push('organization_id = ?')
      bind.push(f.organizationId)
    }
    if (f.journalId) {
      where.push('journal_id = ?')
      bind.push(f.journalId)
    }
    if (f.status) {
      where.push('status = ?')
      bind.push(f.status)
    }
    if (f.from) {
      where.push('entry_date >= ?')
      bind.push(f.from)
    }
    if (f.to) {
      where.push('entry_date <= ?')
      bind.push(f.to)
    }
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : ''
    const rows = await query<EnRow>(
      scope,
      `select ${EN} from journal_entries ${clause}
        order by entry_date desc, number desc nulls first, created_at desc limit ? offset ?`,
      [...bind, f.limit, f.offset]
    )
    const counted = await query<{ n: number }>(
      scope,
      `select count(*)::int as n from journal_entries ${clause}`,
      bind
    )
    return { items: rows.map(toEntry), total: counted[0]?.n ?? 0 }
  }

  async lockSource(scope: TenantScope, sourceKey: string) {
    await query(scope, `select pg_advisory_xact_lock(hashtext(?))`, [
      `journal-source:${tenantOf(scope)}:${sourceKey}`,
    ])
  }

  // --- consultas -------------------------------------------------------------------------------------

  /** Os lançamentos que contam para saldos: lançados e os que entretanto foram revertidos (e o seu inverso). */
  async ledger(scope: TenantScope, accountIds: string[], from: string, to: string) {
    if (accountIds.length === 0) return { opening: { debit: '0.0000', credit: '0.0000' }, rows: [] }
    const opening = await query<{ debit: string; credit: string }>(
      scope,
      `select coalesce(sum(l.debit), 0)::numeric(19,4)::text as debit,
              coalesce(sum(l.credit), 0)::numeric(19,4)::text as credit
         from journal_lines l join journal_entries e on e.id = l.entry_id
        where ${inIds('l.account_id')} and e.status in ('POSTED', 'REVERSED') and e.entry_date < ?`,
      [ids(accountIds), from]
    )
    const rows = await query<{
      entry_id: string
      entry_date: string
      journal_code: string
      number: number | null
      description: string
      line_description: string | null
      debit: string
      credit: string
    }>(
      scope,
      `select e.id as entry_id, e.entry_date::text as entry_date, j.code as journal_code, e.number, e.description,
              l.description as line_description, l.debit::text as debit, l.credit::text as credit
         from journal_lines l
         join journal_entries e on e.id = l.entry_id
         join journals j on j.id = e.journal_id
        where ${inIds('l.account_id')} and e.status in ('POSTED', 'REVERSED')
          and e.entry_date >= ? and e.entry_date <= ?
        order by e.entry_date, j.code, e.number, l.line_no
        limit 5000`,
      [ids(accountIds), from, to]
    )
    return {
      opening: opening[0] ?? { debit: '0.0000', credit: '0.0000' },
      rows: rows.map<LedgerRow>((r) => ({
        entryId: r.entry_id,
        entryDate: r.entry_date,
        journalCode: r.journal_code,
        number: r.number,
        description: r.description,
        lineDescription: r.line_description,
        debit: r.debit,
        credit: r.credit,
      })),
    }
  }

  async trialBalance(scope: TenantScope, organizationId: string, from: string, to: string) {
    const rows = await query<{
      account_id: string
      code: string
      name: string
      account_class: number
      nature: TrialRow['nature']
      opening_debit: string
      opening_credit: string
      period_debit: string
      period_credit: string
    }>(
      scope,
      `select a.id as account_id, a.code, a.name, a.account_class, a.nature,
              coalesce(sum(l.debit) filter (where e.entry_date < ?), 0)::numeric(19,4)::text as opening_debit,
              coalesce(sum(l.credit) filter (where e.entry_date < ?), 0)::numeric(19,4)::text as opening_credit,
              coalesce(sum(l.debit) filter (where e.entry_date >= ?), 0)::numeric(19,4)::text as period_debit,
              coalesce(sum(l.credit) filter (where e.entry_date >= ?), 0)::numeric(19,4)::text as period_credit
         from journal_lines l
         join journal_entries e on e.id = l.entry_id
         join ledger_accounts a on a.id = l.account_id
        where e.organization_id = ? and e.status in ('POSTED', 'REVERSED') and e.entry_date <= ?
        group by a.id, a.code, a.name, a.account_class, a.nature
        order by a.code`,
      [from, from, from, from, organizationId, to]
    )
    return rows.map<TrialRow>((r) => ({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      accountClass: r.account_class,
      nature: r.nature,
      openingDebit: r.opening_debit,
      openingCredit: r.opening_credit,
      periodDebit: r.period_debit,
      periodCredit: r.period_credit,
    }))
  }

  // --- regras ----------------------------------------------------------------------------------------

  async rules(scope: TenantScope, organizationId: string | null) {
    const [where, bind] = orgFilter('organization_id', organizationId)
    const rows = await query<RuRow>(
      scope,
      `select ${RU} from posting_rules ${where} order by organization_id, event_type, role`,
      bind
    )
    return rows.map(toRule)
  }

  async rulesFor(scope: TenantScope, organizationId: string, eventType: string) {
    const rows = await query<RuRow>(
      scope,
      `select ${RU} from posting_rules where organization_id = ? and event_type = ?`,
      [organizationId, eventType]
    )
    return rows.map(toRule)
  }

  async upsertRule(scope: TenantScope, v: Omit<RuleRecord, 'id' | 'version'>) {
    const rows = await query<RuRow>(
      scope,
      `insert into posting_rules (tenant_id, organization_id, event_type, role, account_id, journal_id,
         created_by_membership_id, updated_by_membership_id) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, organization_id, event_type, role) do update
         set account_id = excluded.account_id, journal_id = excluded.journal_id,
             version = posting_rules.version + 1, updated_at = now(),
             updated_by_membership_id = excluded.updated_by_membership_id
       returning ${RU}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.eventType,
        v.role,
        v.accountId,
        v.journalId,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toRule(rows[0] as RuRow)
  }

  async deleteRule(scope: TenantScope, id: string) {
    const rows = await query(scope, `delete from posting_rules where id = ? returning id`, [id])
    return rows.length > 0
  }
}
