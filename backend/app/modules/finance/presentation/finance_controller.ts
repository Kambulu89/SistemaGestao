import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { iamServices } from '#core/permissions/index'
import { isUuid } from '#core/tenancy/index'
import { financeServices } from '#modules/finance/presentation/composition'
import type { ObligationKind } from '#modules/finance/domain/finance'
import {
  createAccountValidator,
  createPaymentValidator,
  createSupplierInvoiceValidator,
  listAccountsValidator,
  listObligationsValidator,
  listPaymentsValidator,
  listSupplierInvoicesValidator,
  pageValidator,
  reasonValidator,
  supplierInvoiceLineValidator,
  updateAccountValidator,
  updateSupplierInvoiceValidator,
  validateSupplierInvoiceValidator,
} from '#modules/finance/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

async function allowed(ctx: HttpContext, permission: string): Promise<boolean> {
  const decision = await iamServices().authorize.decision(ctx.tenantContext, permission)
  return decision.allowed
}

/** O identificador da conta (IBAN, número) é sensível: só quem gere tesouraria o vê. */
const presentAccount = <T extends { accountIdentifier: string | null }>(
  account: T,
  manage: boolean
) => ({
  ...account,
  accountIdentifier: manage ? account.accountIdentifier : null,
})

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class FinanceController {
  // --- contas de tesouraria ------------------------------------------------------------------

  async listAccounts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listAccountsValidator, { data: ctx.request.qs() })
    const { items, total } = await financeServices().accounts.list(ctx.tenantContext, q)
    const manage = await allowed(ctx, 'treasury.manage')
    return envelope(
      ctx,
      items.map((a) => presentAccount(a, manage)),
      { total }
    )
  }

  async showAccount(ctx: HttpContext) {
    const account = await financeServices().accounts.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    return envelope(ctx, presentAccount(account, await allowed(ctx, 'treasury.manage')))
  }

  async statement(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(pageValidator, { data: ctx.request.qs() })
    const { items, total } = await financeServices().accounts.statement(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      q
    )
    return envelope(ctx, items, { total })
  }

  async createAccount(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createAccountValidator)
    const created = await financeServices().accounts.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/treasury-accounts/${created.id}`)
    return envelope(ctx, created)
  }

  async updateAccount(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateAccountValidator)
    return envelope(
      ctx,
      await financeServices().accounts.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  // --- recebíveis e pagáveis -----------------------------------------------------------------

  private async listObligations(ctx: HttpContext, kind: ObligationKind) {
    const q = await ctx.request.validateUsing(listObligationsValidator, { data: ctx.request.qs() })
    const { items, total } = await financeServices().obligations.list(ctx.tenantContext, kind, q)
    return envelope(ctx, items, { total })
  }

  listReceivables(ctx: HttpContext) {
    return this.listObligations(ctx, 'receivable')
  }

  listPayables(ctx: HttpContext) {
    return this.listObligations(ctx, 'payable')
  }

  async showReceivable(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().obligations.get(ctx.tenantContext, 'receivable', uuidParam(ctx, 'id'))
    )
  }

  async showPayable(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().obligations.get(ctx.tenantContext, 'payable', uuidParam(ctx, 'id'))
    )
  }

  /** Exposição de crédito de um cliente; o limite (e a folga) só aparecem a quem gere crédito. */
  async customerCredit(ctx: HttpContext) {
    const view = await financeServices().credit.view(ctx.tenantContext, uuidParam(ctx, 'id'))
    const credit = await allowed(ctx, 'customer.credit_manage')
    return envelope(ctx, {
      ...view,
      creditLimit: credit ? view.creditLimit : null,
      headroom: credit ? view.headroom : null,
    })
  }

  // --- pagamentos ----------------------------------------------------------------------------

  async listPayments(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listPaymentsValidator, { data: ctx.request.qs() })
    const { items, total } = await financeServices().payments.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showPayment(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().payments.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createPayment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createPaymentValidator)
    const key = ctx.request.header('idempotency-key')?.trim() || null
    if (key !== null && (key.length > 100 || !/^[\x21-\x7e]+$/.test(key))) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
        {
          path: 'Idempotency-Key',
          code: 'INVALID_KEY',
          message: 'Chave de idempotência inválida.',
        },
      ])
    }
    const result = await financeServices().payments.create(ctx.tenantContext, b, key)
    if (!result.idempotent) {
      ctx.response.status(201).header('location', `/api/v1/payments/${result.payment.id}`)
    }
    return envelope(ctx, result.payment)
  }

  async submitPayment(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().payments.submit(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async removePayment(ctx: HttpContext) {
    await financeServices().payments.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async confirmPayment(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().payments.confirm(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async failPayment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await financeServices().payments.fail(ctx.tenantContext, uuidParam(ctx, 'id'), b.reason)
    )
  }

  async reversePayment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await financeServices().payments.reverse(ctx.tenantContext, uuidParam(ctx, 'id'), b.reason)
    )
  }

  // --- facturas de fornecedor ----------------------------------------------------------------

  async listSupplierInvoices(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listSupplierInvoicesValidator, {
      data: ctx.request.qs(),
    })
    const { items, total } = await financeServices().supplierInvoices.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showSupplierInvoice(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().supplierInvoices.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createSupplierInvoice(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createSupplierInvoiceValidator)
    const created = await financeServices().supplierInvoices.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/supplier-invoices/${created.id}`)
    return envelope(ctx, created)
  }

  async updateSupplierInvoice(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateSupplierInvoiceValidator)
    return envelope(
      ctx,
      await financeServices().supplierInvoices.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removeSupplierInvoice(ctx: HttpContext) {
    await financeServices().supplierInvoices.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addSupplierInvoiceLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(supplierInvoiceLineValidator)
    const invoice = await financeServices().supplierInvoices.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, invoice)
  }

  async removeSupplierInvoiceLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().supplierInvoices.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async validateSupplierInvoice(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(validateSupplierInvoiceValidator)
    // A excepção a uma divergência é uma permissão à parte (separação de funções).
    if (b.overrideReason && !(await allowed(ctx, 'supplier_invoice.override'))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
    }
    return envelope(
      ctx,
      await financeServices().supplierInvoices.validate(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.overrideReason ? { reason: b.overrideReason } : null
      )
    )
  }

  async voidSupplierInvoice(ctx: HttpContext) {
    return envelope(
      ctx,
      await financeServices().supplierInvoices.voidInvoice(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }
}
