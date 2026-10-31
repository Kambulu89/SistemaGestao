import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { accountingServices } from '#modules/accounting/presentation/composition'
import {
  entriesQueryValidator,
  looseObjectValidator,
  organizationQueryValidator,
  rangeQueryValidator,
  versionValidator,
} from '#modules/accounting/presentation/validators'

function uuidParam(ctx: HttpContext, name = 'id'): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const bodyOf = async (ctx: HttpContext) =>
  (await ctx.request.validateUsing(looseObjectValidator)) as Record<string, unknown>

const created = <T>(ctx: HttpContext, data: T) => {
  ctx.response.status(201)
  return envelope(ctx, data)
}

async function org(ctx: HttpContext) {
  const query = await ctx.request.validateUsing(organizationQueryValidator)
  return query.organizationId ?? null
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class AccountingController {
  // --- plano de contas -----------------------------------------------------------------------------

  async listAccounts(ctx: HttpContext) {
    return envelope(ctx, await accountingServices().chart.list(ctx.tenantContext, await org(ctx)))
  }

  async createAccount(ctx: HttpContext) {
    return created(
      ctx,
      await accountingServices().chart.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async updateAccount(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await accountingServices().chart.update(ctx.tenantContext, uuidParam(ctx), version, body)
    )
  }

  async removeAccount(ctx: HttpContext) {
    await accountingServices().chart.remove(ctx.tenantContext, uuidParam(ctx))
    ctx.response.status(204)
  }

  async applyTemplate(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    return envelope(
      ctx,
      await accountingServices().chart.applyTemplate(ctx.tenantContext, body['organizationId'])
    )
  }

  // --- exercícios ----------------------------------------------------------------------------------

  async listFiscalYears(ctx: HttpContext) {
    return envelope(
      ctx,
      await accountingServices().fiscalYears.list(ctx.tenantContext, await org(ctx))
    )
  }

  async createFiscalYear(ctx: HttpContext) {
    return created(
      ctx,
      await accountingServices().fiscalYears.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async closeFiscalYear(ctx: HttpContext) {
    return envelope(
      ctx,
      await accountingServices().fiscalYears.close(ctx.tenantContext, uuidParam(ctx))
    )
  }

  async closePeriod(ctx: HttpContext) {
    return envelope(
      ctx,
      await accountingServices().fiscalYears.setPeriod(ctx.tenantContext, uuidParam(ctx), 'CLOSED')
    )
  }

  async reopenPeriod(ctx: HttpContext) {
    return envelope(
      ctx,
      await accountingServices().fiscalYears.setPeriod(ctx.tenantContext, uuidParam(ctx), 'OPEN')
    )
  }

  // --- diários -------------------------------------------------------------------------------------

  async listJournals(ctx: HttpContext) {
    return envelope(
      ctx,
      await accountingServices().journals.list(ctx.tenantContext, await org(ctx))
    )
  }

  async createJournal(ctx: HttpContext) {
    return created(
      ctx,
      await accountingServices().journals.create(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async updateJournal(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await accountingServices().journals.update(ctx.tenantContext, uuidParam(ctx), version, body)
    )
  }

  // --- lançamentos ---------------------------------------------------------------------------------

  async listEntries(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(entriesQueryValidator)
    return envelope(ctx, await accountingServices().entries.list(ctx.tenantContext, query))
  }

  async showEntry(ctx: HttpContext) {
    return envelope(ctx, await accountingServices().entries.get(ctx.tenantContext, uuidParam(ctx)))
  }

  async createEntry(ctx: HttpContext) {
    return created(
      ctx,
      await accountingServices().entries.createDraft(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async updateEntry(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await accountingServices().entries.updateDraft(
        ctx.tenantContext,
        uuidParam(ctx),
        version,
        body
      )
    )
  }

  async removeEntry(ctx: HttpContext) {
    await accountingServices().entries.deleteDraft(ctx.tenantContext, uuidParam(ctx))
    ctx.response.status(204)
  }

  async postEntry(ctx: HttpContext) {
    return envelope(ctx, await accountingServices().entries.post(ctx.tenantContext, uuidParam(ctx)))
  }

  async reverseEntry(ctx: HttpContext) {
    return created(
      ctx,
      await accountingServices().entries.reverse(
        ctx.tenantContext,
        uuidParam(ctx),
        await bodyOf(ctx)
      )
    )
  }

  // --- consultas -----------------------------------------------------------------------------------

  async ledger(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(rangeQueryValidator)
    if (!query.accountId) throw ApiError.notFound()
    return envelope(
      ctx,
      await accountingServices().entries.ledger(
        ctx.tenantContext,
        query.accountId,
        query.from,
        query.to
      )
    )
  }

  async trialBalance(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(rangeQueryValidator)
    return envelope(
      ctx,
      await accountingServices().entries.trialBalance(
        ctx.tenantContext,
        query.organizationId,
        query.from,
        query.to
      )
    )
  }

  // --- regras --------------------------------------------------------------------------------------

  async postingEvents(ctx: HttpContext) {
    return envelope(ctx, accountingServices().rules.events())
  }

  async listRules(ctx: HttpContext) {
    return envelope(ctx, await accountingServices().rules.list(ctx.tenantContext, await org(ctx)))
  }

  async upsertRule(ctx: HttpContext) {
    return envelope(
      ctx,
      await accountingServices().rules.upsert(ctx.tenantContext, await bodyOf(ctx))
    )
  }

  async removeRule(ctx: HttpContext) {
    await accountingServices().rules.remove(ctx.tenantContext, uuidParam(ctx))
    ctx.response.status(204)
  }
}
