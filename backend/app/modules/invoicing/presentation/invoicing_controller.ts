import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { invoicingServices } from '#modules/invoicing/presentation/composition'
import {
  createContractValidator,
  createCreditNoteValidator,
  createInvoiceValidator,
  creditLineValidator,
  invoiceLineValidator,
  listContractsValidator,
  listCreditNotesValidator,
  listInvoicesValidator,
  reasonValidator,
  updateContractValidator,
  updateCreditNoteValidator,
  updateInvoiceValidator,
} from '#modules/invoicing/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class InvoicingController {
  // --- contratos -----------------------------------------------------------------------------

  async listContracts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listContractsValidator, { data: ctx.request.qs() })
    const { items, total } = await invoicingServices().contracts.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showContract(ctx: HttpContext) {
    return envelope(
      ctx,
      await invoicingServices().contracts.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createContract(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createContractValidator)
    const created = await invoicingServices().contracts.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/contracts/${created.id}`)
    return envelope(ctx, created)
  }

  async updateContract(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateContractValidator)
    return envelope(
      ctx,
      await invoicingServices().contracts.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async activateContract(ctx: HttpContext) {
    const result = await invoicingServices().contracts.activate(
      ctx.tenantContext,
      uuidParam(ctx, 'id')
    )
    return envelope(ctx, result)
  }

  async terminateContract(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    const result = await invoicingServices().contracts.terminate(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b.reason
    )
    return envelope(ctx, result)
  }

  // --- facturas ------------------------------------------------------------------------------

  async listInvoices(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listInvoicesValidator, { data: ctx.request.qs() })
    const { items, total } = await invoicingServices().invoices.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showInvoice(ctx: HttpContext) {
    return envelope(
      ctx,
      await invoicingServices().invoices.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async billable(ctx: HttpContext) {
    return envelope(
      ctx,
      await invoicingServices().invoices.billable(ctx.tenantContext, uuidParam(ctx, 'orderId'))
    )
  }

  async createInvoice(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createInvoiceValidator)
    const created = await invoicingServices().invoices.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/invoices/${created.id}`)
    return envelope(ctx, created)
  }

  async updateInvoice(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateInvoiceValidator)
    return envelope(
      ctx,
      await invoicingServices().invoices.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removeInvoice(ctx: HttpContext) {
    await invoicingServices().invoices.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addInvoiceLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(invoiceLineValidator)
    const invoice = await invoicingServices().invoices.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, invoice)
  }

  async removeInvoiceLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await invoicingServices().invoices.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async issueInvoice(ctx: HttpContext) {
    const result = await invoicingServices().invoices.issue(ctx.tenantContext, uuidParam(ctx, 'id'))
    return envelope(ctx, result)
  }

  // --- notas de crédito ----------------------------------------------------------------------

  async listCreditNotes(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listCreditNotesValidator, { data: ctx.request.qs() })
    const { items, total } = await invoicingServices().creditNotes.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showCreditNote(ctx: HttpContext) {
    return envelope(
      ctx,
      await invoicingServices().creditNotes.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createCreditNote(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createCreditNoteValidator)
    const created = await invoicingServices().creditNotes.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/credit-notes/${created.id}`)
    return envelope(ctx, created)
  }

  async updateCreditNote(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateCreditNoteValidator)
    return envelope(
      ctx,
      await invoicingServices().creditNotes.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removeCreditNote(ctx: HttpContext) {
    await invoicingServices().creditNotes.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addCreditNoteLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(creditLineValidator)
    const note = await invoicingServices().creditNotes.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, note)
  }

  async removeCreditNoteLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await invoicingServices().creditNotes.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async issueCreditNote(ctx: HttpContext) {
    const result = await invoicingServices().creditNotes.issue(
      ctx.tenantContext,
      uuidParam(ctx, 'id')
    )
    return envelope(ctx, result)
  }
}
