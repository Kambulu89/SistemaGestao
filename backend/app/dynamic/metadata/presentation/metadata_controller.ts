import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { metadataServices } from '#dynamic/metadata/presentation/composition'
import {
  createEntityValidator,
  createRecordValidator,
  listRecordsValidator,
  saveDraftValidator,
  updateEntityValidator,
  updateRecordValidator,
  versionOnlyValidator,
} from '#dynamic/metadata/presentation/validators'

const ENTITY_CODE = /^[a-z][a-z0-9_]{1,49}$/

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext, name = 'id'): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

function codeParam(ctx: HttpContext): string {
  const code = ctx.params.entityCode as string
  if (!ENTITY_CODE.test(code)) throw ApiError.notFound()
  return code
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class MetadataController {
  // --- definição de entidades (entity.read | entity.design | entity.publish) -------------------

  async listEntities(ctx: HttpContext) {
    return envelope(ctx, await metadataServices().entities.list(ctx.tenantContext))
  }

  async showEntity(ctx: HttpContext) {
    return envelope(ctx, await metadataServices().entities.get(ctx.tenantContext, idParam(ctx)))
  }

  async createEntity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createEntityValidator)
    const detail = await metadataServices().entities.create(ctx.tenantContext, {
      code: b.code,
      name: b.name,
      description: b.description ?? null,
      ownershipMode: b.ownershipMode ?? 'TENANT',
      fields: b.fields,
    })
    ctx.response.status(201).header('location', `/api/v1/entity-definitions/${detail.entity.id}`)
    return envelope(ctx, detail)
  }

  async updateEntity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateEntityValidator)
    return envelope(
      ctx,
      await metadataServices().entities.update(ctx.tenantContext, idParam(ctx), b)
    )
  }

  async saveDraft(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(saveDraftValidator)
    return envelope(
      ctx,
      await metadataServices().entities.saveDraft(ctx.tenantContext, idParam(ctx), {
        ...b,
        fields: b.fields,
      })
    )
  }

  async createDraft(ctx: HttpContext) {
    const detail = await metadataServices().entities.createDraft(ctx.tenantContext, idParam(ctx))
    ctx.response.status(201)
    return envelope(ctx, detail)
  }

  async discardDraft(ctx: HttpContext) {
    return envelope(
      ctx,
      await metadataServices().entities.discardDraft(ctx.tenantContext, idParam(ctx))
    )
  }

  async previewPublish(ctx: HttpContext) {
    return envelope(
      ctx,
      await metadataServices().entities.previewPublish(ctx.tenantContext, idParam(ctx))
    )
  }

  async publish(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await metadataServices().entities.publish(ctx.tenantContext, idParam(ctx), b.expectedVersion)
    )
  }

  async archiveEntity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await metadataServices().entities.archive(ctx.tenantContext, idParam(ctx), b.expectedVersion)
    )
  }

  // --- registos (dynamic.*: verificadas no caso de uso, com o código da entidade como atributo) ---

  async listRecords(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listRecordsValidator, { data: ctx.request.qs() })
    return envelope(
      ctx,
      await metadataServices().records.list(ctx.tenantContext, codeParam(ctx), {
        q: q.q,
        archived: q.archived ?? false,
        limit: q.limit ?? 50,
        offset: q.offset ?? 0,
      })
    )
  }

  async showRecord(ctx: HttpContext) {
    return envelope(
      ctx,
      await metadataServices().records.get(ctx.tenantContext, codeParam(ctx), idParam(ctx))
    )
  }

  async createRecord(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createRecordValidator)
    const code = codeParam(ctx)
    const record = await metadataServices().records.create(ctx.tenantContext, code, {
      data: b.data,
      organizationUnitId: b.organizationUnitId ?? null,
    })
    ctx.response.status(201).header('location', `/api/v1/dynamic/${code}/records/${record.id}`)
    return envelope(ctx, record)
  }

  async updateRecord(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateRecordValidator)
    return envelope(
      ctx,
      await metadataServices().records.update(ctx.tenantContext, codeParam(ctx), idParam(ctx), {
        data: b.data,
        expectedVersion: b.expectedVersion,
      })
    )
  }

  async archiveRecord(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await metadataServices().records.archive(
        ctx.tenantContext,
        codeParam(ctx),
        idParam(ctx),
        b.expectedVersion
      )
    )
  }
}
