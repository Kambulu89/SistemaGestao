import type { TenantScope } from '#core/tenancy/index'
import type { MatchState, StatementLineValues } from '#modules/finance/domain/reconciliation'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface StatementBatch extends Audited {
  accountId: string
  fileName: string | null
  lineCount: number
  skippedCount: number
}

export interface StatementLine {
  id: string
  accountId: string
  batchId: string
  externalId: string | null
  occurredOn: string
  amountSigned: string
  description: string | null
  reference: string | null
  /** Soma absoluta das correspondências activas e o que falta; o estado deriva delas. */
  matched: string
  remaining: string
  state: MatchState
}

/** Movimento de tesouraria visto pela conciliação. */
export interface ReconEntry {
  id: string
  accountId: string
  paymentId: string | null
  paymentReference: string | null
  partyName: string | null
  amountSigned: string
  occurredOn: string
  reversalOfId: string | null
  matched: string
  remaining: string
  state: MatchState
}

export interface ReconMatch {
  id: string
  accountId: string
  statementLineId: string
  treasuryEntryId: string
  matchedAmount: string
  confirmedAt: Date
  confirmedByMembershipId: string | null
  undoneAt: Date | null
  undoneByMembershipId: string | null
  undoReason: string | null
}

export interface LineFilter {
  accountId: string
  state?: MatchState
  from?: string
  to?: string
  batchId?: string
  limit: number
  offset: number
}

export interface EntryFilter {
  accountId: string
  state?: MatchState
  from?: string
  to?: string
  limit: number
  offset: number
}

export interface ReconSummary {
  accountId: string
  currency: string
  /** Saldo do livro (soma dos movimentos) e total do extracto importado (soma assinada das linhas). */
  bookBalance: string
  statementTotal: string
  lines: { total: number; unmatched: number; partial: number; matched: number }
  entries: { total: number; unmatched: number; partial: number; matched: number }
  /** Valor assinado ainda por conciliar de cada lado. */
  unmatchedStatementAmount: string
  unmatchedBookAmount: string
}

export interface ReconciliationStore {
  /**
   * Insere o lote e as linhas novas; as já importadas (mesma identidade) contam como ignoradas.
   * Sem nenhuma linha nova não fica lote.
   */
  importBatch(
    scope: TenantScope,
    values: {
      accountId: string
      fileName: string | null
      lines: readonly StatementLineValues[]
    }
  ): Promise<{ batch: StatementBatch | null; imported: number; skipped: number }>
  listBatches(
    scope: TenantScope,
    accountId: string,
    limit: number,
    offset: number
  ): Promise<{ items: StatementBatch[]; total: number }>
  findBatch(scope: TenantScope, id: string): Promise<StatementBatch | null>
  /** Apaga um lote sem correspondências (nunca existiu nenhuma); devolve `false` se alguma linha já foi conciliada. */
  discardBatch(scope: TenantScope, id: string): Promise<boolean>
  listLines(
    scope: TenantScope,
    filter: LineFilter
  ): Promise<{ items: StatementLine[]; total: number }>
  findLine(scope: TenantScope, id: string, lock?: boolean): Promise<StatementLine | null>
  listEntries(
    scope: TenantScope,
    filter: EntryFilter
  ): Promise<{ items: ReconEntry[]; total: number }>
  findEntry(scope: TenantScope, id: string, lock?: boolean): Promise<ReconEntry | null>
  /** Movimentos da conta com algo por conciliar, entre duas datas. */
  candidates(scope: TenantScope, accountId: string, from: string, to: string): Promise<ReconEntry[]>
  insertMatch(
    scope: TenantScope,
    values: {
      accountId: string
      statementLineId: string
      treasuryEntryId: string
      matchedAmount: string
    }
  ): Promise<ReconMatch | 'PAIR'>
  findMatch(scope: TenantScope, id: string, lock?: boolean): Promise<ReconMatch | null>
  lineMatches(scope: TenantScope, lineId: string): Promise<ReconMatch[]>
  entryMatches(scope: TenantScope, entryId: string): Promise<ReconMatch[]>
  markUndone(scope: TenantScope, id: string, reason: string): Promise<ReconMatch>
  summary(scope: TenantScope, accountId: string, currency: string): Promise<ReconSummary>
}
