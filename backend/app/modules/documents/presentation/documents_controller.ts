import type { Readable } from 'node:stream'
import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { tenantServices } from '#platform/tenants/index'
import { documentServices } from '#modules/documents/presentation/composition'
import {
  listDocumentsValidator,
  listResourceAttachmentsValidator,
  looseObjectValidator,
  versionValidator,
} from '#modules/documents/presentation/validators'

function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const bodyOf = async (ctx: HttpContext) =>
  (await ctx.request.validateUsing(looseObjectValidator)) as Record<string, unknown>

/** `Content-Disposition` seguro: sempre descarga (nunca `inline`), nome ASCII de recurso e UTF-8 codificado. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\;]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class DocumentsController {
  // --- documentos --------------------------------------------------------------------------------

  async list(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listDocumentsValidator, { data: ctx.request.qs() })
    const { items, total } = await documentServices().documents.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async create(ctx: HttpContext) {
    const created = await documentServices().documents.create(ctx.tenantContext, await bodyOf(ctx))
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async show(ctx: HttpContext) {
    return envelope(
      ctx,
      await documentServices().documents.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async update(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await documentServices().documents.update(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        version,
        body
      )
    )
  }

  async remove(ctx: HttpContext) {
    await documentServices().documents.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  async addVersion(ctx: HttpContext) {
    const created = await documentServices().documents.addVersion(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      await bodyOf(ctx)
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  // --- anexos ------------------------------------------------------------------------------------

  async prepare(ctx: HttpContext) {
    const view = await documentServices().attachments.prepare(ctx.tenantContext, await bodyOf(ctx))
    ctx.response.status(201)
    return envelope(ctx, { ...view, uploadPath: `/api/v1/attachments/${view.id}/content` })
  }

  /** O corpo é o ficheiro em bruto (`application/octet-stream`), lido em fluxo: nunca fica todo em memória. */
  async content(ctx: HttpContext) {
    const type = ctx.request.header('content-type') ?? ''
    if (!type.toLowerCase().startsWith('application/octet-stream')) {
      throw new ApiError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Envie o ficheiro como application/octet-stream.'
      )
    }
    return envelope(
      ctx,
      await documentServices().attachments.receive(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        ctx.request.request
      )
    )
  }

  async complete(ctx: HttpContext) {
    return envelope(
      ctx,
      await documentServices().attachments.complete(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async showAttachment(ctx: HttpContext) {
    return envelope(
      ctx,
      await documentServices().attachments.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async downloadUrl(ctx: HttpContext) {
    return envelope(
      ctx,
      await documentServices().attachments.downloadUrl(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async download(ctx: HttpContext) {
    const { attachment, stream } = await documentServices().attachments.open(
      ctx.tenantContext,
      uuidParam(ctx, 'id')
    )
    return this.send(
      ctx,
      attachment.originalName,
      attachment.mimeType,
      attachment.sizeBytes,
      stream
    )
  }

  /**
   * Descarga por URL assinada: o token fixa tenant, anexo e membro, mas o acesso é decidido de novo agora (a pessoa
   * continua membro activo, tem `document.read` e acesso ao documento ou recurso). Exige a mesma sessão.
   */
  async file(ctx: HttpContext) {
    const services = documentServices()
    const payload = services.attachments.parseToken(ctx.params['token'] as string)
    if (!payload || payload.userId !== ctx.principal.user.id) throw ApiError.notFound()
    let context
    try {
      const resolved = await tenantServices().resolveTenantContext.execute({
        user: ctx.principal.user,
        selector: { tenantId: payload.tenantId },
        correlationId: ctx.correlationId,
      })
      context = resolved.context
    } catch {
      throw ApiError.notFound()
    }
    if (context.membershipId !== payload.membershipId) throw ApiError.notFound()
    const { attachment, stream } = await services.attachments.open(context, payload.attachmentId)
    return this.send(
      ctx,
      attachment.originalName,
      attachment.mimeType,
      attachment.sizeBytes,
      stream
    )
  }

  private send(ctx: HttpContext, name: string, mimeType: string, size: number, stream: Readable) {
    ctx.response.header('Content-Type', mimeType)
    ctx.response.header('Content-Length', String(size))
    ctx.response.header('Content-Disposition', disposition(name))
    ctx.response.header('X-Content-Type-Options', 'nosniff')
    ctx.response.header('Cache-Control', 'private, no-store')
    ctx.response.header('Content-Security-Policy', "default-src 'none'; sandbox")
    return ctx.response.stream(stream)
  }

  // --- anexos de recursos ------------------------------------------------------------------------

  async linkResource(ctx: HttpContext) {
    const { link, created } = await documentServices().links.link(
      ctx.tenantContext,
      await bodyOf(ctx)
    )
    ctx.response.status(created ? 201 : 200)
    return envelope(ctx, link)
  }

  async listResourceAttachments(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listResourceAttachmentsValidator, {
      data: ctx.request.qs(),
    })
    return envelope(
      ctx,
      await documentServices().links.list(ctx.tenantContext, q.resourceType, q.resourceId)
    )
  }

  async unlinkResource(ctx: HttpContext) {
    await documentServices().links.unlink(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  // --- modelos -----------------------------------------------------------------------------------

  async listTemplates(ctx: HttpContext) {
    return envelope(ctx, await documentServices().templates.list(ctx.tenantContext))
  }

  async createTemplate(ctx: HttpContext) {
    const created = await documentServices().templates.create(ctx.tenantContext, await bodyOf(ctx))
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async showTemplate(ctx: HttpContext) {
    return envelope(
      ctx,
      await documentServices().templates.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async addTemplateVersion(ctx: HttpContext) {
    const created = await documentServices().templates.addVersion(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      await bodyOf(ctx)
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async updateTemplateVersion(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await documentServices().templates.updateDraft(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'versionId'),
        version,
        body
      )
    )
  }

  async deleteTemplateVersion(ctx: HttpContext) {
    await documentServices().templates.deleteDraft(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      uuidParam(ctx, 'versionId')
    )
    ctx.response.status(204)
  }

  async publishTemplateVersion(ctx: HttpContext) {
    return envelope(
      ctx,
      await documentServices().templates.publish(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'versionId')
      )
    )
  }

  async previewTemplateVersion(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    return envelope(
      ctx,
      await documentServices().templates.preview(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'versionId'),
        (body['variables'] ?? {}) as Record<string, unknown>
      )
    )
  }

  async generate(ctx: HttpContext) {
    const created = await documentServices().templates.generate(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      await bodyOf(ctx)
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }
}
