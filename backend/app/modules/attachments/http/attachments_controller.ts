import { readFile, rm } from 'node:fs/promises'
import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { AttachmentService } from '#modules/attachments/application/attachment_service'
import { MAX_FILE_BYTES } from '#modules/attachments/domain/files'

const service = new AttachmentService()
const subjectValidator = vine.create(
  vine.object({
    subjectType: vine
      .string()
      .trim()
      .regex(/^[a-z_]{2,60}$/),
    subjectId: vine.string().uuid(),
  })
)

const idOf = (ctx: HttpContext) => {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** `filename*` em RFC 5987 e um `filename` ASCII de recurso. */
const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

export default class AttachmentsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(subjectValidator, { data: ctx.request.qs() })
    return ok(ctx, await service.list(ctx.tenantContext!, q.subjectType, q.subjectId))
  }

  async store(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(subjectValidator, {
      data: {
        subjectType: ctx.request.input('subjectType'),
        subjectId: ctx.request.input('subjectId'),
      },
    })
    const file = ctx.request.file('file')
    if (!file || !file.tmpPath)
      throw ApiError.validation([
        { path: 'file', code: 'REQUIRED', message: 'Envie o ficheiro no campo "file".' },
      ])
    try {
      if (file.size > MAX_FILE_BYTES)
        throw ApiError.validation([
          { path: 'file', code: 'TOO_LARGE', message: 'Máximo de 10 MB por ficheiro.' },
        ])
      const content = await readFile(file.tmpPath)
      const attachment = await service.upload(ctx.tenantContext!, {
        subjectType: q.subjectType,
        subjectId: q.subjectId,
        clientName: file.clientName,
        content,
      })
      return created(ctx, attachment)
    } finally {
      await rm(file.tmpPath, { force: true })
    }
  }

  async download(ctx: HttpContext) {
    const { view, content } = await service.download(ctx.tenantContext!, idOf(ctx))
    ctx.response.header('content-type', view.contentType)
    ctx.response.header('content-length', String(content.length))
    ctx.response.header('content-disposition', disposition(view.fileName))
    ctx.response.header('x-content-type-options', 'nosniff')
    ctx.response.header('cache-control', 'private, no-store')
    ctx.response.header('content-security-policy', "default-src 'none'; sandbox")
    return ctx.response.send(content)
  }

  async destroy(ctx: HttpContext) {
    await service.remove(ctx.tenantContext!, idOf(ctx))
    return ctx.response.noContent()
  }
}
