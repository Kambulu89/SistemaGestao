import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import { MONEY_SCALE, fromScaled, toScaled } from '#core/decimal/index'
import {
  ACCOUNT_KINDS,
  ENTRY_STATUSES,
  JOURNAL_TYPES,
  NATURES,
  PGC_CLASSES,
  POSTING_EVENTS,
  classOf,
  isAccountCode,
  isIsoDate,
  isParentCode,
  isPostingEvent,
  natureBalance,
  periodsOf,
  reverseLines,
  runningBalance,
  validateLines,
  type AccountKind,
  type EntryStatus,
  type Issue,
  type JournalType,
  type LineInput,
  type Nature,
} from '#modules/accounting/domain/accounting'
import type {
  AccountRecord,
  AccountingStore,
  Clock,
  EntryRecord,
  FiscalYearRecord,
  JournalRecord,
  LineRecord,
  PeriodRecord,
  RuleRecord,
} from '#modules/accounting/application/ports'

type Scope = Parameters<Parameters<TenantUnitOfWork['run']>[0]>[0]

const invalid = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)
const failure = (path: string, code: string, message: string) => invalid([{ path, code, message }])

const text = (value: unknown, path: string, max: number): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max)
    throw failure(path, 'INVALID', `Obrigatório (até ${max} caracteres).`)
  return value.trim()
}

const membershipOf = (context: TenantContext): string | null => context.membershipId ?? null

const dbCode = (error: unknown) => (error as { code?: string } | null)?.code

// --- vistas ------------------------------------------------------------------------------------------

export type AccountView = AccountRecord

export interface FiscalYearView extends FiscalYearRecord {
  periods: PeriodRecord[]
}

export interface EntryView extends Omit<EntryRecord, 'postedAt' | 'createdAt'> {
  postedAt: string | null
  createdAt: string
  journalCode?: string
}

export interface EntryDetail extends EntryView {
  lines: LineRecord[]
  reversedById: string | null
}

const entryView = (e: EntryRecord): EntryView => ({
  ...e,
  postedAt: e.postedAt ? e.postedAt.toISOString() : null,
  createdAt: e.createdAt.toISOString(),
})

// --- plano de contas ---------------------------------------------------------------------------------

/** Plano de contas por empresa: árvore por prefixo de código, contas de cabeçalho e de movimento. */
export class ChartUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: AccountingStore
  ) {}

  async organization(scope: Scope, id: unknown): Promise<string> {
    if (typeof id !== 'string' || !(await this.store.organizationExists(scope, id)))
      throw failure('organizationId', 'NOT_FOUND', 'Empresa (organização) desconhecida.')
    return id
  }

  list(context: TenantContext, organizationId: string | null): Promise<AccountView[]> {
    return this.uow.run((scope) => this.store.accounts(scope, organizationId), context)
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<AccountView> {
    const code = input['code']
    if (!isAccountCode(code))
      throw failure('code', 'INVALID', 'Código inválido (algarismos e pontos, por exemplo 31.1.2).')
    const name = text(input['name'], 'name', 160)
    const nature = input['nature']
    if (!(NATURES as readonly unknown[]).includes(nature))
      throw failure('nature', 'INVALID', 'Natureza: DEBIT (devedora) ou CREDIT (credora).')
    const kind = input['kind'] ?? 'POSTING'
    if (!(ACCOUNT_KINDS as readonly unknown[]).includes(kind))
      throw failure('kind', 'INVALID', 'Tipo: HEADER (agregadora) ou POSTING (de movimento).')
    return this.uow.run(async (scope) => {
      const organizationId = await this.organization(scope, input['organizationId'])
      let parentId: string | null = null
      if (input['parentId'] !== undefined && input['parentId'] !== null) {
        const parent =
          typeof input['parentId'] === 'string'
            ? await this.store.account(scope, input['parentId'])
            : null
        if (!parent || parent.organizationId !== organizationId)
          throw failure('parentId', 'NOT_FOUND', 'Conta-mãe desconhecida nesta empresa.')
        if (parent.kind !== 'HEADER')
          throw failure('parentId', 'NOT_HEADER', 'A conta-mãe tem de ser agregadora (HEADER).')
        if (!isParentCode(parent.code, code))
          throw failure('code', 'NOT_UNDER_PARENT', `O código tem de começar por ${parent.code}.`)
        parentId = parent.id
      }
      const created = await this.store.insertAccount(scope, {
        organizationId,
        code,
        name,
        accountClass: classOf(code),
        nature: nature as Nature,
        kind: kind as AccountKind,
        parentId,
        requiresCostCenter: input['requiresCostCenter'] === true,
        requiresParty: input['requiresParty'] === true,
        active: input['active'] === undefined ? true : input['active'] === true,
      })
      if (!created)
        throw ApiError.conflict('ACCOUNT_CODE_TAKEN', 'Já existe uma conta com este código.')
      return created
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<AccountView> {
    return this.uow.run(async (scope) => {
      const current = await this.store.account(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const updated = await this.store.updateAccount(scope, id, version, {
        name: input['name'] === undefined ? current.name : text(input['name'], 'name', 160),
        requiresCostCenter:
          input['requiresCostCenter'] === undefined
            ? current.requiresCostCenter
            : input['requiresCostCenter'] === true,
        requiresParty:
          input['requiresParty'] === undefined
            ? current.requiresParty
            : input['requiresParty'] === true,
        active: input['active'] === undefined ? current.active : input['active'] === true,
      })
      if (!updated) throw ApiError.versionConflict(current.version)
      return updated
    }, context)
  }

  /** Apagar só se nunca foi usada (sem linhas, sem subcontas, sem regras): senão desactiva-se. */
  async remove(context: TenantContext, id: string): Promise<void> {
    try {
      await this.uow.run(async (scope) => {
        const current = await this.store.account(scope, id)
        if (!current) throw ApiError.notFound()
        if (await this.store.accountHasLines(scope, id))
          throw ApiError.conflict(
            'ACCOUNT_IN_USE',
            'A conta tem movimentos: desactive-a em vez de a apagar.'
          )
        await this.store.deleteAccount(scope, id)
      }, context)
    } catch (error) {
      if (dbCode(error) === '23503')
        throw ApiError.conflict(
          'ACCOUNT_IN_USE',
          'A conta tem subcontas ou regras de contabilização: desactive-a em vez de a apagar.'
        )
      throw error
    }
  }

  /**
   * Aplica o modelo de partida à empresa: as oito classes do PGC angolano (cabeçalhos) e os diários habituais. É
   * idempotente: o que já existe fica como está.
   */
  async applyTemplate(
    context: TenantContext,
    organizationIdInput: unknown
  ): Promise<{ accounts: number; journals: number }> {
    return this.uow.run(async (scope) => {
      const organizationId = await this.organization(scope, organizationIdInput)
      let accounts = 0
      for (const c of PGC_CLASSES) {
        const created = await this.store.insertAccount(scope, {
          organizationId,
          code: c.code,
          name: c.name,
          accountClass: classOf(c.code),
          nature: c.nature,
          kind: 'HEADER',
          parentId: null,
          requiresCostCenter: false,
          requiresParty: false,
          active: true,
        })
        if (created) accounts += 1
      }
      let journals = 0
      for (const j of DEFAULT_JOURNALS) {
        const created = await this.store.insertJournal(scope, {
          organizationId,
          ...j,
          active: true,
        })
        if (created) journals += 1
      }
      return { accounts, journals }
    }, context)
  }
}

const DEFAULT_JOURNALS: readonly { code: string; name: string; type: JournalType }[] = [
  { code: 'GER', name: 'Operações diversas', type: 'GENERAL' },
  { code: 'VEN', name: 'Vendas', type: 'SALES' },
  { code: 'COM', name: 'Compras', type: 'PURCHASES' },
  { code: 'TES', name: 'Tesouraria', type: 'TREASURY' },
  { code: 'SAL', name: 'Salários', type: 'PAYROLL' },
  { code: 'ABE', name: 'Abertura', type: 'OPENING' },
  { code: 'APU', name: 'Apuramento e encerramento', type: 'CLOSING' },
]

// --- exercícios e períodos ---------------------------------------------------------------------------

export class FiscalYearUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: AccountingStore,
    private readonly chart: ChartUseCases
  ) {}

  async list(context: TenantContext, organizationId: string | null): Promise<FiscalYearView[]> {
    return this.uow.run(async (scope) => {
      const years = await this.store.fiscalYears(scope, organizationId)
      const periods = await this.store.periods(
        scope,
        years.map((y) => y.id)
      )
      return years.map((y) => ({ ...y, periods: periods.filter((p) => p.fiscalYearId === y.id) }))
    }, context)
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<FiscalYearView> {
    const code = text(input['code'], 'code', 20)
    const startsOn = input['startsOn']
    const endsOn = input['endsOn']
    const planned = periodsOf(String(startsOn ?? ''), String(endsOn ?? ''))
    if ('issue' in planned) throw invalid([planned.issue])
    try {
      return await this.uow.run(async (scope) => {
        const organizationId = await this.chart.organization(scope, input['organizationId'])
        const year = await this.store.insertFiscalYear(scope, {
          organizationId,
          code,
          startsOn: String(startsOn),
          endsOn: String(endsOn),
        })
        for (const p of planned.periods) {
          await this.store.insertPeriod(scope, { fiscalYearId: year.id, ...p })
        }
        return { ...year, periods: await this.store.periods(scope, [year.id]) }
      }, context)
    } catch (error) {
      if (dbCode(error) === '23P01')
        throw ApiError.conflict(
          'FISCAL_YEAR_OVERLAP',
          'O exercício sobrepõe-se a outro da mesma empresa.'
        )
      if (dbCode(error) === '23505')
        throw ApiError.conflict('FISCAL_YEAR_CODE_TAKEN', 'Já existe um exercício com este código.')
      throw error
    }
  }

  /** Fechar um período impede novos lançamentos nele; os rascunhos ficam, mas não se lançam. */
  async setPeriod(
    context: TenantContext,
    periodId: string,
    status: 'OPEN' | 'CLOSED'
  ): Promise<PeriodRecord> {
    return this.uow.run(async (scope) => {
      const period = await this.store.period(scope, periodId, true)
      if (!period) throw ApiError.notFound()
      const year = await this.store.fiscalYear(scope, period.fiscalYearId)
      if (!year) throw ApiError.notFound()
      if (year.status === 'CLOSED')
        throw ApiError.conflict('FISCAL_YEAR_CLOSED', 'O exercício está encerrado.')
      if (period.status === status) return period
      return this.store.setPeriodStatus(scope, periodId, status)
    }, context)
  }

  /** Encerrar o exercício exige todos os períodos fechados e não se desfaz (a reabertura auditada é da fase E7). */
  async close(context: TenantContext, id: string): Promise<FiscalYearView> {
    return this.uow.run(async (scope) => {
      const year = await this.store.fiscalYear(scope, id, true)
      if (!year) throw ApiError.notFound()
      const periods = await this.store.periods(scope, [id])
      if (year.status === 'CLOSED') return { ...year, periods }
      if (periods.some((p) => p.status === 'OPEN'))
        throw ApiError.conflict(
          'PERIODS_OPEN',
          'Feche todos os períodos antes de encerrar o exercício.'
        )
      const closed = await this.store.closeFiscalYear(scope, id)
      return { ...closed, periods }
    }, context)
  }
}

// --- diários -----------------------------------------------------------------------------------------

export class JournalUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: AccountingStore,
    private readonly chart: ChartUseCases
  ) {}

  list(context: TenantContext, organizationId: string | null): Promise<JournalRecord[]> {
    return this.uow.run((scope) => this.store.journals(scope, organizationId), context)
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<JournalRecord> {
    const code = text(input['code'], 'code', 10).toUpperCase()
    if (!/^[A-Z0-9]{1,10}$/.test(code))
      throw failure('code', 'INVALID', 'Código: letras e algarismos.')
    const name = text(input['name'], 'name', 120)
    const type = input['type'] ?? 'GENERAL'
    if (!(JOURNAL_TYPES as readonly unknown[]).includes(type))
      throw failure('type', 'INVALID', 'Tipo de diário desconhecido.')
    return this.uow.run(async (scope) => {
      const organizationId = await this.chart.organization(scope, input['organizationId'])
      const created = await this.store.insertJournal(scope, {
        organizationId,
        code,
        name,
        type: type as JournalType,
        active: true,
      })
      if (!created)
        throw ApiError.conflict('JOURNAL_CODE_TAKEN', 'Já existe um diário com este código.')
      return created
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<JournalRecord> {
    return this.uow.run(async (scope) => {
      const current = await this.store.journal(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const updated = await this.store.updateJournal(scope, id, version, {
        name: input['name'] === undefined ? current.name : text(input['name'], 'name', 120),
        active: input['active'] === undefined ? current.active : input['active'] === true,
      })
      if (!updated) throw ApiError.versionConflict(current.version)
      return updated
    }, context)
  }
}

// --- lançamentos -------------------------------------------------------------------------------------

interface EntryHeader {
  organizationId: string
  journal: JournalRecord
  year: FiscalYearRecord
  period: PeriodRecord
  entryDate: string
  description: string
}

/**
 * Lançamentos: rascunho (editável), lançado (numerado, imutável) e revertido (por um lançamento inverso). Ao lançar
 * verificam-se as partidas dobradas, as contas, as dimensões obrigatórias e o período aberto; a numeração é sequencial
 * por diário e exercício, atribuída sob o bloqueio do diário.
 */
export class EntryUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: AccountingStore,
    private readonly chart: ChartUseCases,
    private readonly clock: Clock
  ) {}

  private async header(scope: Scope, input: Record<string, unknown>): Promise<EntryHeader> {
    const organizationId = await this.chart.organization(scope, input['organizationId'])
    if (!isIsoDate(input['entryDate']))
      throw failure('entryDate', 'INVALID', 'Data inválida (AAAA-MM-DD).')
    const entryDate = input['entryDate']
    const journal =
      typeof input['journalId'] === 'string'
        ? await this.store.journal(scope, input['journalId'])
        : null
    if (!journal || journal.organizationId !== organizationId)
      throw failure('journalId', 'NOT_FOUND', 'Diário desconhecido nesta empresa.')
    if (!journal.active) throw failure('journalId', 'INACTIVE', 'O diário está inactivo.')
    const found = await this.store.periodFor(scope, organizationId, entryDate)
    if (!found)
      throw failure(
        'entryDate',
        'NO_FISCAL_YEAR',
        'Não há exercício contabilístico que inclua esta data.'
      )
    return {
      organizationId,
      journal,
      year: found.year,
      period: found.period,
      entryDate,
      description: text(input['description'], 'description', 240),
    }
  }

  /** Contas existentes, desta empresa, de movimento, activas; dimensões obrigatórias preenchidas e válidas. */
  private async checkLines(
    scope: Scope,
    organizationId: string,
    lines: readonly LineInput[],
    strict: boolean
  ): Promise<void> {
    const found = await this.store.accountsByIds(scope, [...new Set(lines.map((l) => l.accountId))])
    const accounts = new Map(found.map((a) => [a.id, a]))
    const issues: Issue[] = []
    for (const [i, line] of lines.entries()) {
      const account = accounts.get(line.accountId)
      if (!account || account.organizationId !== organizationId) {
        issues.push({
          path: `lines.${i}.accountId`,
          code: 'NOT_FOUND',
          message: 'Conta desconhecida nesta empresa.',
        })
        continue
      }
      if (account.kind !== 'POSTING')
        issues.push({
          path: `lines.${i}.accountId`,
          code: 'NOT_POSTING',
          message: `A conta ${account.code} é agregadora: use uma subconta de movimento.`,
        })
      if (!account.active)
        issues.push({
          path: `lines.${i}.accountId`,
          code: 'INACTIVE',
          message: `A conta ${account.code} está inactiva.`,
        })
      if (line.costCenterId && !(await this.store.costCenterExists(scope, line.costCenterId)))
        issues.push({
          path: `lines.${i}.costCenterId`,
          code: 'NOT_FOUND',
          message: 'Centro de custo desconhecido.',
        })
      if (line.partyId && !(await this.store.partyExists(scope, line.partyId)))
        issues.push({
          path: `lines.${i}.partyId`,
          code: 'NOT_FOUND',
          message: 'Terceiro desconhecido.',
        })
      if (strict && account.requiresCostCenter && !line.costCenterId)
        issues.push({
          path: `lines.${i}.costCenterId`,
          code: 'REQUIRED',
          message: `A conta ${account.code} exige centro de custo.`,
        })
      if (strict && account.requiresParty && !line.partyId)
        issues.push({
          path: `lines.${i}.partyId`,
          code: 'REQUIRED',
          message: `A conta ${account.code} exige terceiro.`,
        })
    }
    if (issues.length > 0) throw invalid(issues)
  }

  async createDraft(context: TenantContext, input: Record<string, unknown>): Promise<EntryDetail> {
    const validated = validateLines(input['lines'] ?? [], false)
    if ('issues' in validated) throw invalid(validated.issues)
    return this.uow.run(async (scope) => {
      const h = await this.header(scope, input)
      await this.checkLines(scope, h.organizationId, validated.value.lines, false)
      const created = await this.store.insertEntry(scope, {
        organizationId: h.organizationId,
        journalId: h.journal.id,
        fiscalYearId: h.year.id,
        periodId: h.period.id,
        entryDate: h.entryDate,
        description: h.description,
        sourceType: null,
        sourceId: null,
        sourceKey: null,
        reversalOfId: null,
        totalDebit: validated.value.totalDebit,
        totalCredit: validated.value.totalCredit,
      })
      await this.store.replaceLines(scope, created.id, validated.value.lines)
      return this.detail(scope, created.id)
    }, context)
  }

  async updateDraft(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<EntryDetail> {
    const validated = validateLines(input['lines'] ?? [], false)
    if ('issues' in validated) throw invalid(validated.issues)
    return this.uow.run(async (scope) => {
      const current = await this.store.entry(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT')
        throw ApiError.conflict('ENTRY_POSTED', 'Um lançamento lançado não se altera: reverta-o.')
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const h = await this.header(scope, { ...input, organizationId: current.organizationId })
      await this.checkLines(scope, h.organizationId, validated.value.lines, false)
      const updated = await this.store.updateDraft(scope, id, version, {
        journalId: h.journal.id,
        fiscalYearId: h.year.id,
        periodId: h.period.id,
        entryDate: h.entryDate,
        description: h.description,
        totalDebit: validated.value.totalDebit,
        totalCredit: validated.value.totalCredit,
      })
      if (!updated) throw ApiError.versionConflict(current.version)
      await this.store.replaceLines(scope, id, validated.value.lines)
      return this.detail(scope, id)
    }, context)
  }

  async deleteDraft(context: TenantContext, id: string): Promise<void> {
    await this.uow.run(async (scope) => {
      const current = await this.store.entry(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT')
        throw ApiError.conflict('ENTRY_POSTED', 'Um lançamento lançado não se apaga: reverta-o.')
      await this.store.deleteDraft(scope, id)
    }, context)
  }

  /** Lança dentro da transacção em curso (usado também pelo motor de lançamentos automáticos). */
  async postIn(scope: Scope, id: string, membershipId: string | null): Promise<EntryRecord> {
    const entry = await this.store.entry(scope, id, true)
    if (!entry) throw ApiError.notFound()
    if (entry.status !== 'DRAFT') return entry
    const lines = await this.store.lines(scope, id)
    const validated = validateLines(lines, true)
    if ('issues' in validated) throw invalid(validated.issues)
    await this.checkLines(scope, entry.organizationId, lines, true)
    const period = await this.store.period(scope, entry.periodId, true)
    const year = await this.store.fiscalYear(scope, entry.fiscalYearId)
    if (!period || !year) throw ApiError.notFound()
    if (year.status === 'CLOSED' || period.status === 'CLOSED')
      throw ApiError.conflict(
        'PERIOD_CLOSED',
        `O período ${period.number} do exercício ${year.code} está fechado.`
      )
    // O diário é bloqueado para a numeração não ter buracos nem repetições sob concorrência.
    await this.store.journal(scope, entry.journalId, true)
    const number = await this.store.nextNumber(scope, entry.journalId, entry.fiscalYearId)
    return this.store.markPosted(scope, id, number, this.clock.now(), membershipId)
  }

  async post(context: TenantContext, id: string): Promise<EntryDetail> {
    return this.uow.run(async (scope) => {
      await this.postIn(scope, id, membershipOf(context))
      return this.detail(scope, id)
    }, context)
  }

  /**
   * Reverter: cria e lança o lançamento inverso (débitos ↔ créditos) numa data com período aberto (por omissão a do
   * original) e marca o original como revertido. Um lançamento só se reverte uma vez; um inverso não se reverte.
   */
  async reverse(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>
  ): Promise<EntryDetail> {
    try {
      return await this.uow.run(async (scope) => {
        const original = await this.store.entry(scope, id, true)
        if (!original) throw ApiError.notFound()
        if (original.status === 'REVERSED')
          throw ApiError.conflict('ALREADY_REVERSED', 'Este lançamento já foi revertido.')
        if (original.status !== 'POSTED')
          throw ApiError.conflict('ENTRY_NOT_POSTED', 'Só se reverte um lançamento lançado.')
        if (original.reversalOfId)
          throw ApiError.conflict(
            'IS_REVERSAL',
            'Um lançamento inverso não se reverte: lance outro.'
          )
        const date = input['entryDate'] === undefined ? original.entryDate : input['entryDate']
        const lines = reverseLines(await this.store.lines(scope, id))
        const h = await this.header(scope, {
          organizationId: original.organizationId,
          journalId: original.journalId,
          entryDate: date,
          description:
            typeof input['description'] === 'string' && input['description'].trim() !== ''
              ? input['description']
              : `Reversão: ${original.description}`.slice(0, 240),
        })
        const created = await this.store.insertEntry(scope, {
          organizationId: original.organizationId,
          journalId: h.journal.id,
          fiscalYearId: h.year.id,
          periodId: h.period.id,
          entryDate: h.entryDate,
          description: h.description,
          sourceType: original.sourceType,
          sourceId: original.sourceId,
          sourceKey: original.sourceKey ? `${original.sourceKey}:reversal` : null,
          reversalOfId: original.id,
          totalDebit: original.totalCredit,
          totalCredit: original.totalDebit,
        })
        await this.store.replaceLines(scope, created.id, lines)
        await this.postIn(scope, created.id, membershipOf(context))
        await this.store.markReversed(scope, original.id)
        return this.detail(scope, created.id)
      }, context)
    } catch (error) {
      if (dbCode(error) === '23505')
        throw ApiError.conflict('ALREADY_REVERSED', 'Este lançamento já foi revertido.')
      throw error
    }
  }

  async detail(scope: Scope, id: string): Promise<EntryDetail> {
    const entry = await this.store.entry(scope, id)
    if (!entry) throw ApiError.notFound()
    const [lines, reversal, journal] = await Promise.all([
      this.store.lines(scope, id),
      this.store.entryReversing(scope, id),
      this.store.journal(scope, entry.journalId),
    ])
    return {
      ...entryView(entry),
      journalCode: journal?.code,
      lines,
      reversedById: reversal?.id ?? null,
    }
  }

  get(context: TenantContext, id: string): Promise<EntryDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  async list(
    context: TenantContext,
    query: Record<string, unknown>
  ): Promise<{ items: EntryView[]; total: number }> {
    const status = query['status']
    if (status !== undefined && !(ENTRY_STATUSES as readonly unknown[]).includes(status))
      throw failure('status', 'INVALID', 'Estado desconhecido.')
    for (const key of ['from', 'to'])
      if (query[key] !== undefined && !isIsoDate(query[key]))
        throw failure(key, 'INVALID', 'Data inválida (AAAA-MM-DD).')
    const limit = Math.min(Math.max(Number(query['limit'] ?? 50) || 50, 1), 200)
    const offset = Math.max(Number(query['offset'] ?? 0) || 0, 0)
    return this.uow.run(async (scope) => {
      const allJournals = await this.store.journals(scope, null)
      const journals = new Map(allJournals.map((j) => [j.id, j.code]))
      const found = await this.store.entries(scope, {
        organizationId:
          typeof query['organizationId'] === 'string' ? query['organizationId'] : null,
        journalId: typeof query['journalId'] === 'string' ? query['journalId'] : null,
        status: (status as EntryStatus | undefined) ?? null,
        from: (query['from'] as string | undefined) ?? null,
        to: (query['to'] as string | undefined) ?? null,
        limit,
        offset,
      })
      return {
        items: found.items.map((e) => ({
          ...entryView(e),
          journalCode: journals.get(e.journalId),
        })),
        total: found.total,
      }
    }, context)
  }

  // --- consultas -------------------------------------------------------------------------------------

  /** Razão de uma conta (de cabeçalho: soma as subcontas) com saldo acumulado. */
  async ledger(
    context: TenantContext,
    accountId: string,
    from: unknown,
    to: unknown
  ): Promise<{
    account: AccountRecord
    from: string
    to: string
    opening: string
    rows: (Awaited<ReturnType<AccountingStore['ledger']>>['rows'][number] & { balance: string })[]
    totalDebit: string
    totalCredit: string
    closing: string
  }> {
    if (!isIsoDate(from) || !isIsoDate(to) || to < from)
      throw failure('from', 'INVALID_RANGE', 'Indique from e to (AAAA-MM-DD), com from ≤ to.')
    return this.uow.run(async (scope) => {
      const account = await this.store.account(scope, accountId)
      if (!account) throw ApiError.notFound()
      const all = await this.store.accounts(scope, account.organizationId)
      const covered = all
        .filter((a) => a.id === account.id || isParentCode(account.code, a.code))
        .map((a) => a.id)
      const data = await this.store.ledger(scope, covered, from, to)
      const opening = subtract(data.opening.debit, data.opening.credit)
      const balances = runningBalance(opening, data.rows)
      const totalDebit = sum(data.rows.map((r) => r.debit))
      const totalCredit = sum(data.rows.map((r) => r.credit))
      return {
        account,
        from,
        to,
        opening,
        rows: data.rows.map((r, i) => ({ ...r, balance: balances[i] as string })),
        totalDebit,
        totalCredit,
        closing: balances.at(-1) ?? opening,
      }
    }, context)
  }

  /**
   * Balancete: por conta de movimento, saldo inicial, movimentos do período e saldo final (no lado devedor ou credor);
   * os totais de débitos e de créditos são sempre iguais.
   */
  async trialBalance(context: TenantContext, organizationId: unknown, from: unknown, to: unknown) {
    if (!isIsoDate(from) || !isIsoDate(to) || to < from)
      throw failure('from', 'INVALID_RANGE', 'Indique from e to (AAAA-MM-DD), com from ≤ to.')
    return this.uow.run(async (scope) => {
      const org = await this.chart.organization(scope, organizationId)
      const raw = await this.store.trialBalance(scope, org, from, to)
      const rows = raw.map((r) => {
        const closing = subtract(
          sum([r.openingDebit, r.periodDebit]),
          sum([r.openingCredit, r.periodCredit])
        )
        const negative = closing.startsWith('-')
        return {
          ...r,
          closingDebit: negative ? '0.0000' : closing,
          closingCredit: negative ? closing.slice(1) : '0.0000',
          natureBalance: natureBalance(
            r.nature,
            sum([r.openingDebit, r.periodDebit]),
            sum([r.openingCredit, r.periodCredit])
          ),
        }
      })
      const totals = {
        openingDebit: sum(rows.map((r) => r.openingDebit)),
        openingCredit: sum(rows.map((r) => r.openingCredit)),
        periodDebit: sum(rows.map((r) => r.periodDebit)),
        periodCredit: sum(rows.map((r) => r.periodCredit)),
        closingDebit: sum(rows.map((r) => r.closingDebit)),
        closingCredit: sum(rows.map((r) => r.closingCredit)),
      }
      const byClass = [...new Set(rows.map((r) => r.accountClass))].sort().map((accountClass) => {
        const of = rows.filter((r) => r.accountClass === accountClass)
        return {
          accountClass,
          periodDebit: sum(of.map((r) => r.periodDebit)),
          periodCredit: sum(of.map((r) => r.periodCredit)),
          closingDebit: sum(of.map((r) => r.closingDebit)),
          closingCredit: sum(of.map((r) => r.closingCredit)),
        }
      })
      return {
        organizationId: org,
        from,
        to,
        rows,
        byClass,
        totals,
        asOf: this.clock.now().toISOString(),
      }
    }, context)
  }
}

const sum = (values: readonly string[]): string =>
  fromScaled(
    values.reduce((acc, v) => {
      const negative = v.startsWith('-')
      const scaled = toScaled(negative ? v.slice(1) : v, MONEY_SCALE) ?? 0n
      return acc + (negative ? -scaled : scaled)
    }, 0n),
    MONEY_SCALE
  )

const subtract = (a: string, b: string): string =>
  sum([a, b.startsWith('-') ? b.slice(1) : `-${b}`])

// --- regras e motor de lançamentos automáticos -------------------------------------------------------

export class PostingRuleUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: AccountingStore,
    private readonly chart: ChartUseCases
  ) {}

  events() {
    return Object.entries(POSTING_EVENTS).map(([code, e]) => ({
      code,
      label: e.label,
      roles: e.roles,
    }))
  }

  list(context: TenantContext, organizationId: string | null): Promise<RuleRecord[]> {
    return this.uow.run((scope) => this.store.rules(scope, organizationId), context)
  }

  async upsert(context: TenantContext, input: Record<string, unknown>): Promise<RuleRecord> {
    const eventType = input['eventType']
    if (!isPostingEvent(eventType)) throw failure('eventType', 'INVALID', 'Evento desconhecido.')
    const role = input['role']
    if (typeof role !== 'string' || !(POSTING_EVENTS[eventType]?.roles ?? []).includes(role))
      throw failure('role', 'INVALID', 'Papel desconhecido para este evento.')
    return this.uow.run(async (scope) => {
      const organizationId = await this.chart.organization(scope, input['organizationId'])
      const account =
        typeof input['accountId'] === 'string'
          ? await this.store.account(scope, input['accountId'])
          : null
      if (!account || account.organizationId !== organizationId)
        throw failure('accountId', 'NOT_FOUND', 'Conta desconhecida nesta empresa.')
      if (account.kind !== 'POSTING' || !account.active)
        throw failure('accountId', 'NOT_POSTING', 'Use uma conta de movimento activa.')
      const journal =
        typeof input['journalId'] === 'string'
          ? await this.store.journal(scope, input['journalId'])
          : null
      if (!journal || journal.organizationId !== organizationId)
        throw failure('journalId', 'NOT_FOUND', 'Diário desconhecido nesta empresa.')
      return this.store.upsertRule(scope, {
        organizationId,
        eventType,
        role,
        accountId: account.id,
        journalId: journal.id,
      })
    }, context)
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    await this.uow.run(async (scope) => {
      if (!(await this.store.deleteRule(scope, id))) throw ApiError.notFound()
    }, context)
  }
}

export interface PostingRequest {
  organizationId: string
  eventType: string
  sourceType: string
  sourceId: string
  /** Identifica a operação de origem: a mesma chave nunca gera dois lançamentos. */
  sourceKey: string
  entryDate: string
  description: string
  lines: {
    role: string
    debit?: string
    credit?: string
    description?: string | null
    costCenterId?: string | null
    partyId?: string | null
  }[]
}

export class PostingRuleMissing extends ApiError {
  constructor(readonly missingRoles: string[]) {
    super(
      409,
      'POSTING_RULE_MISSING',
      'Falta configurar a regra de contabilização para este evento.',
      missingRoles.map((role) => ({ path: role, code: 'POSTING_RULE_MISSING', message: role }))
    )
  }
}

/**
 * O motor que os outros módulos usam (fase E2): traduz papéis em contas pelas regras da empresa, cria e lança o
 * lançamento na transacção de quem chama, e é idempotente por `sourceKey` (sob bloqueio consultivo dessa chave).
 */
export class PostingService {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: AccountingStore,
    private readonly entries: EntryUseCases
  ) {}

  async post(
    context: TenantContext,
    request: PostingRequest
  ): Promise<{ entry: EntryDetail; created: boolean }> {
    if (!isPostingEvent(request.eventType))
      throw failure('eventType', 'INVALID', 'Evento desconhecido.')
    if (!request.sourceKey || request.sourceKey.length > 160)
      throw failure('sourceKey', 'INVALID', 'Chave de origem obrigatória (até 160 caracteres).')
    return this.uow.run(async (scope) => {
      await this.store.lockSource(scope, request.sourceKey)
      const existing = await this.store.entryBySource(scope, request.sourceKey)
      if (existing) return { entry: await this.entries.detail(scope, existing.id), created: false }
      const configured = await this.store.rulesFor(scope, request.organizationId, request.eventType)
      const rules = new Map(configured.map((r) => [r.role, r]))
      const missing = [...new Set(request.lines.map((l) => l.role))].filter(
        (role) => !rules.has(role)
      )
      if (missing.length > 0) throw new PostingRuleMissing(missing)
      const lines = request.lines.map((l) => ({
        accountId: (rules.get(l.role) as RuleRecord).accountId,
        debit: l.debit ?? '0',
        credit: l.credit ?? '0',
        description: l.description ?? null,
        costCenterId: l.costCenterId ?? null,
        partyId: l.partyId ?? null,
      }))
      const validated = validateLines(lines, true)
      if ('issues' in validated) throw invalid(validated.issues)
      const journalId = (rules.get(request.lines[0]?.role ?? '') as RuleRecord).journalId
      const found = await this.store.periodFor(scope, request.organizationId, request.entryDate)
      if (!found)
        throw failure('entryDate', 'NO_FISCAL_YEAR', 'Não há exercício que inclua esta data.')
      const created = await this.store.insertEntry(scope, {
        organizationId: request.organizationId,
        journalId,
        fiscalYearId: found.year.id,
        periodId: found.period.id,
        entryDate: request.entryDate,
        description: request.description.slice(0, 240),
        sourceType: request.sourceType,
        sourceId: request.sourceId,
        sourceKey: request.sourceKey,
        reversalOfId: null,
        totalDebit: validated.value.totalDebit,
        totalCredit: validated.value.totalCredit,
      })
      await this.store.replaceLines(scope, created.id, validated.value.lines)
      await this.entries.postIn(scope, created.id, membershipOf(context))
      return { entry: await this.entries.detail(scope, created.id), created: true }
    }, context)
  }
}
