import type { Readable } from 'node:stream'
import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { reportingServices } from '#modules/reporting/presentation/composition'
import {
  dataValidator,
  looseObjectValidator,
  runValidator,
  searchValidator,
  versionValidator,
} from '#modules/reporting/presentation/validators'

function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const bodyOf = async (ctx: HttpContext) =>
  (await ctx.request.validateUsing(looseObjectValidator)) as Record<string, unknown>

function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\;]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class ReportingController {
  // --- datasets e relatórios ---------------------------------------------------------------------

  async datasets(ctx: HttpContext) {
    return envelope(ctx, await reportingServices().reports.datasets(ctx.tenantContext))
  }

  async listReports(ctx: HttpContext) {
    return envelope(ctx, await reportingServices().reports.list(ctx.tenantContext))
  }

  async showReport(ctx: HttpContext) {
    return envelope(
      ctx,
      await reportingServices().reports.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createReport(ctx: HttpContext) {
    const created = await reportingServices().reports.create(ctx.tenantContext, await bodyOf(ctx))
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async updateReport(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await reportingServices().reports.update(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        version,
        body
      )
    )
  }

  async publishReport(ctx: HttpContext) {
    return envelope(
      ctx,
      await reportingServices().reports.publish(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async duplicateReport(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const created = await reportingServices().reports.duplicate(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      body['code']
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async removeReport(ctx: HttpContext) {
    await reportingServices().reports.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  async runReport(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(runValidator)
    const result = await reportingServices().reports.run(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      body.filters,
      { limit: body.limit, offset: body.offset }
    )
    return envelope(ctx, result, { total: result.total })
  }

  async previewReport(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const result = await reportingServices().reports.preview(ctx.tenantContext, body, {
      limit: typeof body['limit'] === 'number' ? body['limit'] : undefined,
      offset: typeof body['offset'] === 'number' ? body['offset'] : undefined,
    })
    return envelope(ctx, result, { total: result.total })
  }

  // --- painéis -----------------------------------------------------------------------------------

  async listDashboards(ctx: HttpContext) {
    return envelope(ctx, await reportingServices().dashboards.list(ctx.tenantContext))
  }

  async showDashboard(ctx: HttpContext) {
    return envelope(
      ctx,
      await reportingServices().dashboards.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async dashboardData(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(dataValidator, { data: ctx.request.qs() })
    let filters: unknown = []
    if (q.filters) {
      try {
        filters = JSON.parse(q.filters)
      } catch {
        throw new ApiError(400, 'BAD_REQUEST', 'Os filtros têm de ser JSON válido.')
      }
    }
    return envelope(
      ctx,
      await reportingServices().dashboards.data(ctx.tenantContext, uuidParam(ctx, 'id'), filters)
    )
  }

  async createDashboard(ctx: HttpContext) {
    const created = await reportingServices().dashboards.create(
      ctx.tenantContext,
      await bodyOf(ctx)
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async updateDashboard(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await reportingServices().dashboards.update(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        version,
        body
      )
    )
  }

  async removeDashboard(ctx: HttpContext) {
    await reportingServices().dashboards.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  async addWidget(ctx: HttpContext) {
    const created = await reportingServices().dashboards.addWidget(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      await bodyOf(ctx)
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async updateWidget(ctx: HttpContext) {
    const body = await bodyOf(ctx)
    const { version } = await ctx.request.validateUsing(versionValidator)
    return envelope(
      ctx,
      await reportingServices().dashboards.updateWidget(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'widgetId'),
        version,
        body
      )
    )
  }

  async removeWidget(ctx: HttpContext) {
    await reportingServices().dashboards.removeWidget(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      uuidParam(ctx, 'widgetId')
    )
    ctx.response.status(204)
  }

  // --- exportações -------------------------------------------------------------------------------

  async requestExport(ctx: HttpContext) {
    const created = await reportingServices().exports.request(ctx.tenantContext, await bodyOf(ctx))
    ctx.response.status(202)
    return envelope(ctx, created)
  }

  async listExports(ctx: HttpContext) {
    return envelope(ctx, await reportingServices().exports.list(ctx.tenantContext))
  }

  async showExport(ctx: HttpContext) {
    return envelope(
      ctx,
      await reportingServices().exports.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async downloadExport(ctx: HttpContext) {
    const file = await reportingServices().exports.download(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.header('Content-Type', file.mimeType)
    ctx.response.header('Content-Length', String(file.sizeBytes))
    ctx.response.header('Content-Disposition', disposition(file.fileName))
    ctx.response.header('X-Content-Type-Options', 'nosniff')
    ctx.response.header('Cache-Control', 'private, no-store')
    return ctx.response.stream(file.stream as Readable)
  }

  // --- pesquisa ----------------------------------------------------------------------------------

  async search(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(searchValidator, { data: ctx.request.qs() })
    return envelope(
      ctx,
      await reportingServices().search.search(
        ctx.tenantContext,
        q.q,
        q.types ? q.types.split(',').map((t) => t.trim()) : undefined,
        q.limit ?? 5
      )
    )
  }

  async searchStatus(ctx: HttpContext) {
    return envelope(ctx, await reportingServices().search.status(ctx.tenantContext))
  }

  async reindex(ctx: HttpContext) {
    const result = await reportingServices().search.reindex(ctx.tenantContext.tenantId)
    return envelope(ctx, result)
  }
}
