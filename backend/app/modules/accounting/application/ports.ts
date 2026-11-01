import type { TenantScope } from '#core/tenancy/index'
import type {
  AccountKind,
  EntryStatus,
  JournalType,
  LineInput,
  Nature,
} from '#modules/accounting/domain/accounting'

export interface Clock {
  now(): Date
}

export interface AccountRecord {
  id: string
  organizationId: string
  code: string
  name: string
  accountClass: number
  nature: Nature
  kind: AccountKind
  parentId: string | null
  requiresCostCenter: boolean
  requiresParty: boolean
  active: boolean
  version: number
}

export type NewAccount = Omit<AccountRecord, 'id' | 'version'>

export interface FiscalYearRecord {
  id: string
  organizationId: string
  code: string
  startsOn: string
  endsOn: string
  status: 'OPEN' | 'CLOSED'
  version: number
}

export interface PeriodRecord {
  id: string
  fiscalYearId: string
  number: number
  startsOn: string
  endsOn: string
  status: 'OPEN' | 'CLOSED'
  version: number
}

export interface JournalRecord {
  id: string
  organizationId: string
  code: string
  name: string
  type: JournalType
  active: boolean
  version: number
}

export interface EntryRecord {
  id: string
  organizationId: string
  journalId: string
  fiscalYearId: string
  periodId: string
  number: number | null
  entryDate: string
  description: string
  status: EntryStatus
  sourceType: string | null
  sourceId: string | null
  sourceKey: string | null
  reversalOfId: string | null
  totalDebit: string
  totalCredit: string
  postedAt: Date | null
  version: number
  createdAt: Date
}

export interface LineRecord extends LineInput {
  id: string
  lineNo: number
  accountCode: string
  accountName: string
}

export interface NewEntry {
  organizationId: string
  journalId: string
  fiscalYearId: string
  periodId: string
  entryDate: string
  description: string
  sourceType: string | null
  sourceId: string | null
  sourceKey: string | null
  reversalOfId: string | null
  totalDebit: string
  totalCredit: string
}

export interface EntryFilter {
  organizationId: string | null
  journalId: string | null
  status: EntryStatus | null
  from: string | null
  to: string | null
  limit: number
  offset: number
}

export interface LedgerRow {
  entryId: string
  entryDate: string
  journalCode: string
  number: number | null
  description: string
  lineDescription: string | null
  debit: string
  credit: string
}

export interface TrialRow {
  accountId: string
  code: string
  name: string
  accountClass: number
  nature: Nature
  openingDebit: string
  openingCredit: string
  periodDebit: string
  periodCredit: string
}

export interface RuleRecord {
  id: string
  organizationId: string
  eventType: string
  role: string
  accountId: string
  journalId: string
  version: number
}

/** O erro da base de dados quando uma escrita é recusada por uma restrição, com o seu código. */
export interface DbFailure {
  code?: string
  constraint?: string
  message?: string
}

export interface AccountingStore {
  organizationExists(scope: TenantScope, id: string): Promise<boolean>
  costCenterExists(scope: TenantScope, id: string): Promise<boolean>
  partyExists(scope: TenantScope, id: string): Promise<boolean>

  // plano de contas
  accounts(scope: TenantScope, organizationId: string | null): Promise<AccountRecord[]>
  account(scope: TenantScope, id: string): Promise<AccountRecord | null>
  accountByCode(
    scope: TenantScope,
    organizationId: string,
    code: string
  ): Promise<AccountRecord | null>
  accountsByIds(scope: TenantScope, ids: string[]): Promise<AccountRecord[]>
  insertAccount(scope: TenantScope, v: NewAccount): Promise<AccountRecord | null>
  updateAccount(
    scope: TenantScope,
    id: string,
    version: number,
    v: Pick<AccountRecord, 'name' | 'requiresCostCenter' | 'requiresParty' | 'active'>
  ): Promise<AccountRecord | null>
  deleteAccount(scope: TenantScope, id: string): Promise<boolean>
  accountHasLines(scope: TenantScope, id: string): Promise<boolean>

  // exercícios
  fiscalYears(scope: TenantScope, organizationId: string | null): Promise<FiscalYearRecord[]>
  fiscalYear(scope: TenantScope, id: string, lock?: boolean): Promise<FiscalYearRecord | null>
  insertFiscalYear(
    scope: TenantScope,
    v: Omit<FiscalYearRecord, 'id' | 'version' | 'status'>
  ): Promise<FiscalYearRecord>
  closeFiscalYear(scope: TenantScope, id: string): Promise<FiscalYearRecord>
  periods(scope: TenantScope, fiscalYearIds: string[]): Promise<PeriodRecord[]>
  period(scope: TenantScope, id: string, lock?: boolean): Promise<PeriodRecord | null>
  insertPeriod(
    scope: TenantScope,
    v: Omit<PeriodRecord, 'id' | 'version' | 'status'>
  ): Promise<void>
  setPeriodStatus(scope: TenantScope, id: string, status: 'OPEN' | 'CLOSED'): Promise<PeriodRecord>
  /** O período (e o exercício) da empresa que contém a data. */
  periodFor(
    scope: TenantScope,
    organizationId: string,
    date: string
  ): Promise<{ year: FiscalYearRecord; period: PeriodRecord } | null>
  draftsIn(scope: TenantScope, periodId: string): Promise<number>

  // diários
  journals(scope: TenantScope, organizationId: string | null): Promise<JournalRecord[]>
  journal(scope: TenantScope, id: string, lock?: boolean): Promise<JournalRecord | null>
  insertJournal(
    scope: TenantScope,
    v: Omit<JournalRecord, 'id' | 'version'>
  ): Promise<JournalRecord | null>
  updateJournal(
    scope: TenantScope,
    id: string,
    version: number,
    v: Pick<JournalRecord, 'name' | 'active'>
  ): Promise<JournalRecord | null>

  // lançamentos
  insertEntry(scope: TenantScope, v: NewEntry): Promise<EntryRecord>
  replaceLines(scope: TenantScope, entryId: string, lines: readonly LineInput[]): Promise<void>
  updateDraft(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewEntry, 'organizationId' | 'sourceType' | 'sourceId' | 'sourceKey' | 'reversalOfId'>
  ): Promise<EntryRecord | null>
  deleteDraft(scope: TenantScope, id: string): Promise<boolean>
  entry(scope: TenantScope, id: string, lock?: boolean): Promise<EntryRecord | null>
  entryBySource(scope: TenantScope, sourceKey: string): Promise<EntryRecord | null>
  entryReversing(scope: TenantScope, id: string): Promise<EntryRecord | null>
  lines(scope: TenantScope, entryId: string): Promise<LineRecord[]>
  nextNumber(scope: TenantScope, journalId: string, fiscalYearId: string): Promise<number>
  markPosted(
    scope: TenantScope,
    id: string,
    number: number,
    at: Date,
    membershipId: string | null
  ): Promise<EntryRecord>
  markReversed(scope: TenantScope, id: string): Promise<void>
  entries(scope: TenantScope, f: EntryFilter): Promise<{ items: EntryRecord[]; total: number }>
  /** Serializa quem lança a mesma origem (bloqueio consultivo dentro da transacção). */
  lockSource(scope: TenantScope, sourceKey: string): Promise<void>

  // consultas
  ledger(
    scope: TenantScope,
    accountIds: string[],
    from: string,
    to: string
  ): Promise<{ opening: { debit: string; credit: string }; rows: LedgerRow[] }>
  trialBalance(
    scope: TenantScope,
    organizationId: string,
    from: string,
    to: string
  ): Promise<TrialRow[]>

  // regras
  rules(scope: TenantScope, organizationId: string | null): Promise<RuleRecord[]>
  rulesFor(scope: TenantScope, organizationId: string, eventType: string): Promise<RuleRecord[]>
  upsertRule(scope: TenantScope, v: Omit<RuleRecord, 'id' | 'version'>): Promise<RuleRecord>
  deleteRule(scope: TenantScope, id: string): Promise<boolean>
}
