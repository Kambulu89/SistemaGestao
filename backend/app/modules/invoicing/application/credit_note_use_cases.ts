import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { fromScaled, sumTotals, toScaled } from '#modules/orders/index'
import {
  creditLineValues,
  fullyCredited,
  type CreditableLine,
  type CreditNoteStatus,
  type Issue,
} from '#modules/invoicing/domain/invoicing'
import { invoicingValidation } from '#modules/invoicing/application/contract_use_cases'
import type {
  CreditedAmounts,
  CreditNote,
  CreditNoteLine,
  CreditNoteStore,
  InvoiceLine,
  InvoiceStore,
  References,
} from '#modules/invoicing/application/ports'

const MAX_PAGE = 200
const MAX_LINES = 100

interface Clock {
  now(): Date
}

export type CreditNoteDetail = CreditNote & { lines: CreditNoteLine[] }

export interface CreditLineInput {
  invoiceLineId?: unknown
  quantity?: unknown
  /** Valor líquido a creditar; sem ele o crédito é proporcional à quantidade. */
  amount?: unknown
}

const asLine = (line: InvoiceLine): CreditableLine => ({
  quantity: toScaled(line.quantity, 6) ?? 0n,
  net: toScaled(line.netAmount, 4) ?? 0n,
  tax: toScaled(line.taxAmount, 4) ?? 0n,
})

const asCredited = (credited: CreditedAmounts | undefined): CreditableLine => ({
  quantity: toScaled(credited?.quantity ?? '0', 6) ?? 0n,
  net: toScaled(credited?.net ?? '0', 4) ?? 0n,
  tax: toScaled(credited?.tax ?? '0', 4) ?? 0n,
})

/**
 * Notas de crédito (M05): corrigem uma factura emitida sem a alterar. Nunca creditam mais do que foi facturado (somando as
 * notas já emitidas), conferido sob bloqueio da factura; não devolvem stock nem tocam na encomenda. Quando tudo está
 * creditado a factura passa a `CREDITED`.
 */
export class CreditNoteUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly notes: CreditNoteStore,
    private readonly invoices: InvoiceStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: { invoiceId?: string; status?: CreditNoteStatus; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) =>
        this.notes.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<CreditNoteDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  async create(
    context: TenantContext,
    input: { invoiceId: string; reason: unknown; lines?: CreditLineInput[] }
  ): Promise<CreditNoteDetail> {
    const reason = this.reasonOf(input.reason)
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      throw invoicingValidation([
        { path: 'lines', code: 'TOO_MANY', message: `No máximo ${MAX_LINES} linhas.` },
      ])
    }
    return this.uow.run(async (scope) => {
      await this.invoices.lock(scope, `invoice:${input.invoiceId}`)
      const invoice = await this.invoices.find(scope, input.invoiceId)
      if (!invoice) throw ApiError.notFound()
      this.assertCreditable(invoice.status)
      const created = await this.notes.insert(scope, {
        organizationId: invoice.organizationId,
        invoiceId: invoice.id,
        reason,
      })
      for (const [index, raw] of (input.lines ?? []).entries()) {
        await this.addLineInScope(scope, context, created, raw, `lines[${index}].`)
      }
      return this.retotal(scope, created.id)
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: { reason: unknown }
  ): Promise<CreditNoteDetail> {
    const reason = this.reasonOf(input.reason)
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      await this.notes.setReason(scope, id, reason)
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      await this.notes.remove(scope, id)
    }, context)
  }

  addLine(context: TenantContext, id: string, input: CreditLineInput): Promise<CreditNoteDetail> {
    return this.uow.run(async (scope) => {
      const note = await this.requireDraft(scope, id)
      await this.invoices.lock(scope, `invoice:${note.invoiceId}`)
      const invoice = await this.invoices.find(scope, note.invoiceId)
      this.assertCreditable(invoice?.status)
      const existing = await this.notes.listLines(scope, id)
      if (existing.length >= MAX_LINES) {
        throw invoicingValidation([
          { path: 'lines', code: 'TOO_MANY', message: `No máximo ${MAX_LINES} linhas.` },
        ])
      }
      await this.addLineInScope(scope, context, note, input, '')
      return this.retotal(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<CreditNoteDetail> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      if (!(await this.notes.findLine(scope, id, lineId))) throw ApiError.notFound()
      await this.notes.removeLine(scope, lineId)
      return this.retotal(scope, id)
    }, context)
  }

  /**
   * Emite a nota: reconfere cada linha contra o que já foi creditado (sob bloqueio da factura), atribui o número e, se a
   * factura ficar toda creditada, marca-a. Idempotente: emitir outra vez devolve a nota, sem novo número nem evento.
   */
  issue(
    context: TenantContext,
    id: string
  ): Promise<{ creditNote: CreditNoteDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const probe = await this.notes.find(scope, id)
      if (!probe) throw ApiError.notFound()
      await this.invoices.lock(scope, `invoice:${probe.invoiceId}`)
      const note = (await this.notes.find(scope, id, true)) as CreditNote
      if (note.status === 'ISSUED') {
        return { creditNote: await this.detail(scope, id), idempotent: true }
      }
      const invoice = await this.invoices.find(scope, note.invoiceId, true)
      if (!invoice) throw ApiError.notFound()
      this.assertCreditable(invoice.status)
      const lines = await this.notes.listLines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('CREDIT_NOTE_EMPTY', 'Uma nota de crédito sem linhas não se emite.')
      }
      const invoiceLines = await this.invoices.listLines(scope, invoice.id)
      const credited = await this.notes.creditedByInvoiceLine(scope, invoice.id)
      const problems: Issue[] = []
      for (const [index, line] of lines.entries()) {
        const target = invoiceLines.find((l) => l.id === line.invoiceLineId)
        const base = target ? asLine(target) : null
        const done = asCredited(credited.get(line.invoiceLineId))
        const exceeds =
          !base ||
          (toScaled(line.quantity, 6) ?? 0n) > base.quantity - done.quantity ||
          (toScaled(line.amount, 4) ?? 0n) > base.net - done.net ||
          (toScaled(line.taxAmount, 4) ?? 0n) > base.tax - done.tax
        if (exceeds) {
          problems.push({
            path: `lines[${index}].amount`,
            code: 'EXCEEDS_CREDITABLE',
            message: 'A linha excede o que ainda se pode creditar.',
          })
        }
      }
      if (problems.length > 0) {
        throw new ApiError(
          409,
          'CREDIT_NOTE_NOT_ISSUABLE',
          'A nota não pode ser emitida.',
          problems
        )
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: note.organizationId,
        documentType: 'CREDIT_NOTE',
        date: this.clock.now(),
      })
      const issued = await this.notes.issue(
        scope,
        id,
        number,
        this.clock.now().toISOString().slice(0, 10)
      )
      const after = await this.notes.creditedByInvoiceLine(scope, invoice.id)
      const closed = fullyCredited(
        invoiceLines.map((l) => ({ line: asLine(l), credited: asCredited(after.get(l.id)) }))
      )
      if (closed) await this.invoices.markCredited(scope, invoice.id)
      await this.outbox.append(scope, {
        aggregateType: 'credit_note',
        aggregateId: id,
        aggregateVersion: issued.version,
        eventType: 'invoicing.credit_note.issued',
        payload: {
          creditNoteId: id,
          number,
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          organizationId: note.organizationId,
          customerId: invoice.customerId,
          currency: invoice.currency,
          totals: issued.totals,
          invoiceFullyCredited: closed,
        },
        correlationId: context.correlationId,
      })
      return { creditNote: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  // --- auxiliares ----------------------------------------------------------------------------

  private reasonOf(value: unknown): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text || text.length > 300) {
      throw invoicingValidation([
        {
          path: 'reason',
          code: 'REASON_REQUIRED',
          message: 'Indique o motivo (até 300 caracteres).',
        },
      ])
    }
    return text
  }

  private assertCreditable(status: string | undefined): void {
    if (status === 'CREDITED') {
      throw ApiError.conflict('INVOICE_FULLY_CREDITED', 'A factura já está toda creditada.')
    }
    if (status !== 'ISSUED') {
      throw ApiError.conflict('INVOICE_NOT_ISSUED', 'Só se credita uma factura emitida.')
    }
  }

  private async detail(scope: TenantScope, id: string): Promise<CreditNoteDetail> {
    const note = await this.notes.find(scope, id)
    if (!note) throw ApiError.notFound()
    return { ...note, lines: await this.notes.listLines(scope, id) }
  }

  private async requireDraft(scope: TenantScope, id: string): Promise<CreditNote> {
    const note = await this.notes.find(scope, id, true)
    if (!note) throw ApiError.notFound()
    if (note.status !== 'DRAFT') {
      throw ApiError.conflict('CREDIT_NOTE_NOT_DRAFT', 'Só uma nota em rascunho se altera.')
    }
    return note
  }

  private async addLineInScope(
    scope: TenantScope,
    context: TenantContext,
    note: CreditNote,
    raw: CreditLineInput,
    path: string
  ): Promise<void> {
    const invoice = await this.invoices.find(scope, note.invoiceId)
    const target =
      typeof raw.invoiceLineId === 'string'
        ? await this.invoices.findLine(scope, note.invoiceId, raw.invoiceLineId)
        : null
    if (!invoice || !target) {
      throw invoicingValidation([
        {
          path: `${path}invoiceLineId`,
          code: 'UNKNOWN_INVOICE_LINE',
          message: 'A linha não pertence à factura.',
        },
      ])
    }
    const mode = await this.references.roundingMode(context, invoice.organizationId)
    const credited = await this.notes.creditedByInvoiceLine(scope, invoice.id)
    const issues: Issue[] = []
    const values = creditLineValues(
      asLine(target),
      asCredited(credited.get(target.id)),
      {
        quantity: raw.quantity as string,
        ...(raw.amount === undefined ? {} : { amount: raw.amount as string }),
      },
      mode,
      path,
      issues
    )
    if (!values) throw invoicingValidation(issues)
    const created = await this.notes.insertLine(scope, note.id, {
      invoiceLineId: target.id,
      ...values,
    })
    if (!created) {
      throw ApiError.conflict(
        'CREDIT_LINE_DUPLICATE',
        'Esta linha da factura já está na nota: remova-a para a refazer.'
      )
    }
  }

  private async retotal(scope: TenantScope, id: string): Promise<CreditNoteDetail> {
    const lines = await this.notes.listLines(scope, id)
    await this.notes.setTotals(
      scope,
      id,
      sumTotals(
        lines.map((l) => ({
          net: l.amount,
          tax: l.taxAmount,
          total: fromScaled((toScaled(l.amount, 4) ?? 0n) + (toScaled(l.taxAmount, 4) ?? 0n), 4),
        }))
      )
    )
    return this.detail(scope, id)
  }
}
