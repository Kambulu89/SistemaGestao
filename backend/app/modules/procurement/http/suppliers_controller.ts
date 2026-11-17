import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { SupplierService } from '#modules/procurement/application/supplier_service'
import {
  ProcurementSettingsService,
  type SettingKind,
} from '#modules/procurement/application/procurement_settings_service'
import { SUPPLIER_STATUSES, SUPPLIER_TYPES } from '#modules/procurement/domain/suppliers'

/**
 * Fornecedores (9.1). As rotas exigem `procurement.suppliers.read`; o serviço verifica `.manage`, `.approve` e `.bank`
 * (âmbito da empresa). Configuração: leitura com `.read`, alteração com `procurement.settings` (rota).
 */
const suppliers = new SupplierService()
const settings = new ProcurementSettingsService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(SUPPLIER_STATUSES).optional(),
    supplierType: vine.enum(SUPPLIER_TYPES).optional(),
    sort: vine.string().trim().maxLength(30).optional(),
    direction: vine.enum(['asc', 'desc']).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const lookupQuery = vine.create(
  vine.object({
    countryCode: vine.string().trim().fixedLength(2),
    taxId: vine.string().trim().minLength(5).maxLength(30),
  })
)
const settingsQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const KINDS: Record<string, SettingKind> = {
  'document-types': 'documentTypes',
  'criteria': 'criteria',
}
const kindOf = (ctx: HttpContext) => {
  const k = KINDS[ctx.params.kind as string]
  if (!k) throw ApiError.notFound()
  return k
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class SuppliersController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await suppliers.list(ctx.tenantContext!, {
      q: q.q,
      status: q.status,
      supplierType: q.supplierType,
      sort: q.sort ? { field: q.sort, direction: q.direction ?? 'asc' } : undefined,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await suppliers.get(ctx.tenantContext!, param(ctx)))
  }

  async lookup(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(lookupQuery, { data: ctx.request.qs() })
    return ok(ctx, await suppliers.lookup(ctx.tenantContext!, q.countryCode, q.taxId))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await suppliers.create(ctx.tenantContext!, await body(ctx)))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await suppliers.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async addContact(ctx: HttpContext) {
    return created(ctx, await suppliers.addContact(ctx.tenantContext!, param(ctx), await body(ctx)))
  }

  async updateContact(ctx: HttpContext) {
    return ok(
      ctx,
      await suppliers.updateContact(
        ctx.tenantContext!,
        param(ctx),
        param(ctx, 'contactId'),
        await vbody(ctx)
      )
    )
  }

  async addBankAccount(ctx: HttpContext) {
    return created(
      ctx,
      await suppliers.addBankAccount(ctx.tenantContext!, param(ctx), await body(ctx))
    )
  }

  async bankAccountAction(ctx: HttpContext) {
    const action = ctx.params.action as string
    if (!['approve', 'reject', 'deactivate'].includes(action)) throw ApiError.notFound()
    return ok(
      ctx,
      await suppliers.bankAccountAction(
        ctx.tenantContext!,
        param(ctx),
        action as 'approve' | 'reject' | 'deactivate',
        await vbody(ctx)
      )
    )
  }

  async addDocument(ctx: HttpContext) {
    return created(
      ctx,
      await suppliers.addDocument(ctx.tenantContext!, param(ctx), await body(ctx))
    )
  }

  async deactivateDocument(ctx: HttpContext) {
    return ok(
      ctx,
      await suppliers.deactivateDocument(ctx.tenantContext!, param(ctx), await vbody(ctx))
    )
  }

  async submit(ctx: HttpContext) {
    return ok(ctx, await suppliers.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async approve(ctx: HttpContext) {
    return ok(
      ctx,
      await suppliers.decide(ctx.tenantContext!, param(ctx), 'approve', await vbody(ctx))
    )
  }

  async reject(ctx: HttpContext) {
    return ok(
      ctx,
      await suppliers.decide(ctx.tenantContext!, param(ctx), 'reject', await vbody(ctx))
    )
  }

  async suspend(ctx: HttpContext) {
    return ok(ctx, await suppliers.suspend(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async settingsIndex(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(settingsQuery, { data: ctx.request.qs() })
    const p = await settings.list(ctx.tenantContext!, kindOf(ctx), q)
    return ok(ctx, p.items, { total: p.total })
  }

  async settingsStore(ctx: HttpContext) {
    return created(ctx, await settings.create(ctx.tenantContext!, kindOf(ctx), await body(ctx)))
  }

  async settingsUpdate(ctx: HttpContext) {
    return ok(
      ctx,
      await settings.update(ctx.tenantContext!, kindOf(ctx), param(ctx), await vbody(ctx))
    )
  }
}
