import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { addDays } from '#modules/finance/domain/finance'
import {
  normalizeStatement,
  planMatch,
  suggest,
  SUGGESTION_WINDOW_DAYS,
  type MatchState,
  type Suggestion,
} from '#modules/finance/domain/reconciliation'
import { failure, financeValidation, MAX_PAGE } from '#modules/finance/application/errors'
import type { AccountStore } from '#modules/finance/application/ports'
import type {
  ReconEntry,
  ReconMatch,
  ReconciliationStore,
  StatementBatch,
  StatementLine,
} from '#modules/finance/application/reconciliation_ports'

/** Erros de correspondência que são conflito de estado (409) e não erro de entrada (422). */
const CONFLICT_CODES = new Set(['LINE_FULLY_MATCHED', 'ENTRY_FULLY_MATCHED', 'EXCEEDS_REMAINING'])

const page = (filter: { limit?: number; offset?: number }) => ({
  limit: Math.min(filter.limit ?? 50, MAX_PAGE),
  offset: filter.offset ?? 0,
})

export interface LineDetail extends StatementLine {
  matches: ReconMatch[]
}

export interface SuggestionView extends Suggestion {
  entry: ReconEntry
}

/**
 * Conciliação bancária: importa extractos (idempotente), sugere movimentos para cada linha e regista as correspondências
 * que uma pessoa confirma. Nunca cria nem altera movimentos de tesouraria: o extracto é informação externa.
 */
export class ReconciliationUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: ReconciliationStore,
    private readonly accounts: AccountStore
  ) {}

  private async bankAccount(scope: TenantScope, accountId: string) {
    const account = await this.accounts.find(scope, accountId)
    if (!account) throw ApiError.notFound()
    return account
  }

  // --- extractos ---------------------------------------------------------------------------------

  importStatement(
    context: TenantContext,
    input: { accountId: string; fileName?: string | null; lines: unknown }
  ): Promise<{ batch: StatementBatch | null; imported: number; skipped: number }> {
    const { values, issues } = normalizeStatement(input.lines)
    const fileName = input.fileName?.trim() ? input.fileName.trim().slice(0, 200) : null
    if (issues.length > 0) throw financeValidation(issues)
    return this.uow.run(async (scope) => {
      const account = await this.bankAccount(scope, input.accountId)
      if (account.type !== 'BANK') {
        throw failure('accountId', 'NOT_A_BANK_ACCOUNT', 'Só as contas bancárias têm extracto.')
      }
      return this.store.importBatch(scope, { accountId: account.id, fileName, lines: values })
    }, context)
  }

  listBatches(
    context: TenantContext,
    accountId: string,
    filter: { limit?: number; offset?: number }
  ) {
    const { limit, offset } = page(filter)
    return this.uow.run(async (scope) => {
      await this.bankAccount(scope, accountId)
      return this.store.listBatches(scope, accountId, limit, offset)
    }, context)
  }

  discardBatch(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.findBatch(scope, id))) throw ApiError.notFound()
      if (!(await this.store.discardBatch(scope, id))) {
        throw ApiError.conflict(
          'BATCH_HAS_MATCHES',
          'Há linhas deste extracto já conciliadas: desfaça as correspondências primeiro.'
        )
      }
    }, context)
  }

  // --- linhas e movimentos -----------------------------------------------------------------------

  listLines(
    context: TenantContext,
    filter: {
      accountId: string
      state?: MatchState
      from?: string
      to?: string
      batchId?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(async (scope) => {
      await this.bankAccount(scope, filter.accountId)
      return this.store.listLines(scope, { ...filter, ...page(filter) })
    }, context)
  }

  getLine(context: TenantContext, id: string): Promise<LineDetail> {
    return this.uow.run(async (scope) => {
      const line = await this.store.findLine(scope, id)
      if (!line) throw ApiError.notFound()
      return { ...line, matches: await this.store.lineMatches(scope, id) }
    }, context)
  }

  listEntries(
    context: TenantContext,
    filter: {
      accountId: string
      state?: MatchState
      from?: string
      to?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(async (scope) => {
      await this.bankAccount(scope, filter.accountId)
      return this.store.listEntries(scope, { ...filter, ...page(filter) })
    }, context)
  }

  summary(context: TenantContext, accountId: string) {
    return this.uow.run(async (scope) => {
      const account = await this.bankAccount(scope, accountId)
      return this.store.summary(scope, account.id, account.currency)
    }, context)
  }

  /** Candidatos para uma linha, do mais provável para o menos provável. */
  suggestions(context: TenantContext, lineId: string): Promise<SuggestionView[]> {
    return this.uow.run(async (scope) => {
      const line = await this.store.findLine(scope, lineId)
      if (!line) throw ApiError.notFound()
      if (line.state === 'MATCHED') return []
      const entries = await this.store.candidates(
        scope,
        line.accountId,
        addDays(line.occurredOn, -SUGGESTION_WINDOW_DAYS),
        addDays(line.occurredOn, SUGGESTION_WINDOW_DAYS)
      )
      const byId = new Map(entries.map((e) => [e.id, e]))
      return suggest(
        line,
        entries.map((e) => ({
          id: e.id,
          amountSigned: e.amountSigned,
          remaining: e.remaining,
          occurredOn: e.occurredOn,
          reference: e.paymentReference,
          description: e.partyName,
        }))
      ).map((s) => ({ ...s, entry: byId.get(s.entryId) as ReconEntry }))
    }, context)
  }

  // --- correspondências --------------------------------------------------------------------------

  /**
   * Confirma que uma linha do extracto corresponde (total ou parcialmente) a um movimento. Bloqueia a linha e depois o
   * movimento, por esta ordem, e recalcula o que falta com os bloqueios tomados: duas confirmações concorrentes nunca
   * conciliam mais do que a linha ou o movimento valem.
   */
  confirm(
    context: TenantContext,
    input: { statementLineId: string; treasuryEntryId: string; amount?: string }
  ): Promise<ReconMatch> {
    return this.uow.run(async (scope) => {
      const line = await this.store.findLine(scope, input.statementLineId, true)
      if (!line) throw ApiError.notFound()
      const entry = await this.store.findEntry(scope, input.treasuryEntryId, true)
      if (!entry) throw ApiError.notFound()
      const plan = planMatch(line, entry, input.amount)
      if ('issues' in plan) {
        const first = plan.issues[0]
        if (plan.issues.every((i) => CONFLICT_CODES.has(i.code))) {
          throw ApiError.conflict(first.code, first.message, plan.issues)
        }
        throw financeValidation(plan.issues)
      }
      const created = await this.store.insertMatch(scope, {
        accountId: line.accountId,
        statementLineId: line.id,
        treasuryEntryId: entry.id,
        matchedAmount: plan.amount,
      })
      if (created === 'PAIR') {
        throw ApiError.conflict(
          'PAIR_ALREADY_MATCHED',
          'Esta linha já está ligada a este movimento: desfaça a correspondência para a alterar.'
        )
      }
      return created
    }, context)
  }

  /** Desfaz uma correspondência (motivo obrigatório). Repetir não faz nada: idempotente pelo estado. */
  undo(context: TenantContext, id: string, reason: unknown): Promise<ReconMatch> {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (text.length === 0 || text.length > 300) {
      throw failure('reason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')
    }
    return this.uow.run(async (scope) => {
      const match = await this.store.findMatch(scope, id, true)
      if (!match) throw ApiError.notFound()
      if (match.undoneAt) return match
      return this.store.markUndone(scope, id, text)
    }, context)
  }
}
