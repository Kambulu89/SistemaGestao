import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { ApiError } from '#core/http/api_error'
import {
  serviceTenantContext,
  type TenantContext,
  type TenantUnitOfWork,
} from '#core/tenancy/index'
import { csvLine, validateQuery, type Filter } from '#modules/reporting/domain/reporting'
import { failure, reportValidation } from '#modules/reporting/application/errors'
import type {
  Authorizer,
  Clock,
  ContextResolver,
  ExportRecord,
  ExportStore,
  GeneratedFiles,
  ReportRecord,
  ReportStore,
} from '#modules/reporting/application/ports'
import { datasetOf } from '#modules/reporting/application/registry'
import { asFilters, type QueryService } from '#modules/reporting/application/query_service'
import { reportVisibleTo } from '#modules/reporting/application/report_use_cases'

/** Marca de ordem de bytes UTF-8: o Excel abre o CSV com os acentos certos. */
const BOM = String.fromCharCode(0xfeff)

export const EXPORT_TTL_MS = 24 * 3600 * 1000
export const MAX_EXPORT_ROWS = 100_000
const PAGE = 500
const STALE_AFTER_MS = 15 * 60 * 1000

const membershipOf = (context: TenantContext): string => {
  if (!context.membershipId) throw ApiError.notFound()
  return context.membershipId
}

export interface ExportView {
  id: string
  reportId: string
  format: ExportRecord['format']
  status: ExportRecord['status']
  rowCount: number | null
  columns: string[] | null
  expiresAt: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  finishedAt: string | null
}

const exportView = (e: ExportRecord): ExportView => ({
  id: e.id,
  reportId: e.reportId,
  format: e.format,
  status: e.status,
  rowCount: e.rowCount,
  columns: e.columns,
  expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
  errorCode: e.errorCode,
  errorMessage: e.errorMessage,
  createdAt: e.createdAt.toISOString(),
  finishedAt: e.finishedAt ? e.finishedAt.toISOString() : null,
})

/**
 * Exportações assíncronas. O pedido só regista o trabalho; o trabalhador **revalida os direitos de quem pediu ao executar**
 * e o descarregar volta a revalidá-los: revogar o acesso invalida o ficheiro pendente. O CSV neutraliza células que uma
 * folha de cálculo executaria e só leva as colunas que a pessoa vê.
 */
export class ExportUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly exports: ExportStore,
    private readonly reports: ReportStore,
    private readonly query: QueryService,
    private readonly authorizer: Authorizer,
    private readonly files: GeneratedFiles,
    private readonly clock: Clock
  ) {}

  private async mayExport(context: TenantContext): Promise<boolean> {
    const decision = await this.authorizer.decide(context, 'report.export')
    return decision.allowed
  }

  async request(context: TenantContext, input: Record<string, unknown>): Promise<ExportView> {
    const membershipId = membershipOf(context)
    const format = input['format'] ?? 'CSV'
    if (format !== 'CSV') {
      throw failure('format', 'FORMAT_NOT_SUPPORTED', 'Por agora só se exporta em CSV.')
    }
    const reportId = typeof input['reportId'] === 'string' ? input['reportId'] : ''
    const filters = asFilters(input['filters'])
    const report = await this.uow.run(async (scope) => {
      const found = reportId ? await this.reports.find(scope, reportId) : null
      if (!found || !reportVisibleTo(found, membershipId)) throw ApiError.notFound()
      return found
    }, context)
    if (report.status !== 'PUBLISHED') {
      throw failure('reportId', 'REPORT_NOT_PUBLISHED', 'Só se exporta um relatório publicado.')
    }
    // Falha já aqui, e não no trabalhador, se os filtros não servem ou se o dataset não é legível.
    const dataset = datasetOf(report.datasetCode)
    if (!dataset) throw failure('reportId', 'UNKNOWN_DATASET', 'Dataset desconhecido.')
    const hidden = await this.query.hiddenFields(context, dataset)
    const { issues } = validateQuery(
      dataset,
      {
        select: report.selectedFields,
        filters: [...report.filters, ...filters],
        groupBy: report.grouping,
        measures: report.measures,
        sort: report.sort,
      },
      hidden
    )
    if (issues.length) throw reportValidation(issues)
    return this.uow.run(
      async (scope) =>
        exportView(await this.exports.insert(scope, { reportId, filters, format: 'CSV' })),
      context
    )
  }

  async list(context: TenantContext): Promise<ExportView[]> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const own = await this.exports.listOwn(scope, membershipId, 50)
      return own.map(exportView)
    }, context)
  }

  private async own(context: TenantContext, id: string): Promise<ExportRecord> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const found = await this.exports.find(scope, id)
      if (!found || found.requestedByMembershipId !== membershipId) throw ApiError.notFound()
      return found
    }, context)
  }

  async get(context: TenantContext, id: string): Promise<ExportView> {
    return exportView(await this.own(context, id))
  }

  /** Descarrega: revalida tudo agora (permissão, dataset, relatório e campos que o ficheiro leva). */
  async download(
    context: TenantContext,
    id: string
  ): Promise<{ fileName: string; mimeType: string; sizeBytes: number; stream: Readable }> {
    let job = await this.own(context, id)
    const now = this.clock.now()
    if (job.status === 'READY' && job.expiresAt && job.expiresAt < now) {
      job = await this.expire(context, job)
    }
    if (job.status === 'EXPIRED') {
      throw ApiError.conflict('EXPORT_EXPIRED', 'A exportação expirou: peça outra.')
    }
    if (job.status !== 'READY' || !job.attachmentId) {
      throw ApiError.conflict('EXPORT_NOT_READY', 'A exportação ainda não está pronta.')
    }
    if (!(await this.mayExport(context))) throw this.revoked()
    const report = await this.uow.run((scope) => this.reports.find(scope, job.reportId), context)
    const dataset = report ? datasetOf(report.datasetCode) : undefined
    if (!report || !dataset || !reportVisibleTo(report, membershipOf(context))) throw this.revoked()
    let hidden: Set<string>
    try {
      hidden = await this.query.hiddenFields(context, dataset)
    } catch {
      throw this.revoked()
    }
    // O ficheiro foi gerado com campos que a pessoa já não vê: o ficheiro deixa de se poder entregar.
    if ((job.columns ?? []).some((c) => hidden.has(c))) throw this.revoked()
    return this.files.open(context, job.attachmentId)
  }

  private revoked() {
    return new ApiError(
      403,
      'EXPORT_ACCESS_REVOKED',
      'Já não tem acesso aos dados desta exportação.'
    )
  }

  private async expire(context: TenantContext, job: ExportRecord): Promise<ExportRecord> {
    const expired = await this.uow.run((scope) => this.exports.markExpired(scope, job.id), context)
    if (job.attachmentId) await this.files.remove(context, job.attachmentId)
    return expired
  }

  // --- trabalhador ------------------------------------------------------------------------------

  /** Trata o trabalho seguinte do tenant. Devolve `false` quando a fila está vazia. */
  async processNext(tenantId: string, resolver: ContextResolver): Promise<boolean> {
    const service = serviceTenantContext(tenantId, `exports-${randomUUID()}`)
    const now = this.clock.now()
    const job = await this.uow.run((scope) => this.exports.claim(scope, now), service)
    if (!job) return false
    const fail = (code: string, message: string) =>
      this.uow.run(
        (scope) => this.exports.markFailed(scope, job.id, { code, message, at: this.clock.now() }),
        service
      )
    const context = await resolver.forMembership(tenantId, job.requestedByMembershipId)
    if (!context) {
      await fail('ACCESS_REVOKED', 'Quem pediu a exportação já não tem acesso.')
      return true
    }
    try {
      if (!(await this.mayExport(context))) throw this.revoked()
      const report = await this.uow.run((scope) => this.reports.find(scope, job.reportId), context)
      if (!report || !reportVisibleTo(report, context.membershipId as string)) throw this.revoked()
      const csv = await this.render(context, report, job.filters)
      const stored = await this.files.store(context, {
        fileName: `${report.code}-${now.toISOString().slice(0, 10)}.csv`,
        mimeType: 'text/csv',
        data: Buffer.from(`${BOM}${csv.text}`, 'utf8'),
      })
      await this.uow.run(
        (scope) =>
          this.exports.markReady(scope, job.id, {
            attachmentId: stored.id,
            columns: csv.columns,
            rowCount: csv.rows,
            expiresAt: new Date(this.clock.now().getTime() + EXPORT_TTL_MS),
            at: this.clock.now(),
          }),
        service
      )
    } catch (error) {
      if (error instanceof ApiError) {
        await fail(error.status === 403 ? 'ACCESS_REVOKED' : error.code, error.message)
      } else {
        await fail('EXPORT_FAILED', 'Não foi possível gerar a exportação.')
        throw error
      }
    }
    return true
  }

  /** Percorre o relatório em páginas, sempre pelo serviço de consultas (autorização em cada página). */
  private async render(context: TenantContext, report: ReportRecord, filters: Filter[]) {
    const dataset = datasetOf(report.datasetCode)
    if (!dataset) throw failure('reportId', 'UNKNOWN_DATASET', 'Dataset desconhecido.')
    let text = ''
    let columns: string[] = []
    let rows = 0
    for (let offset = 0; ; offset += PAGE) {
      const result = await this.query.run(
        context,
        dataset,
        {
          select: report.selectedFields,
          filters: [...report.filters, ...filters],
          groupBy: report.grouping,
          measures: report.measures,
          sort: report.sort,
        },
        { limit: PAGE, offset }
      )
      if (offset === 0) {
        columns = result.columns.map((c) => c.code)
        text += csvLine(result.columns.map((c) => c.label))
        if (result.total > MAX_EXPORT_ROWS) {
          throw failure(
            'rows',
            'ROW_LIMIT',
            `A exportação excede ${MAX_EXPORT_ROWS} linhas: reduza com filtros.`
          )
        }
      }
      for (const row of result.rows) {
        text += csvLine(columns.map((c) => row[c]))
        rows += 1
      }
      if (result.rows.length < PAGE) break
    }
    return { text, columns, rows }
  }

  /** Limpeza: ficheiros prontos que passaram do prazo, e trabalhos que ficaram a correr de um processo caído. */
  async sweep(
    tenantId: string,
    resolver: ContextResolver
  ): Promise<{ expired: number; requeued: number }> {
    const service = serviceTenantContext(tenantId, `exports-sweep-${randomUUID()}`)
    const now = this.clock.now()
    const due = await this.uow.run((scope) => this.exports.expiredReady(scope, now, 50), service)
    let expired = 0
    for (const job of due) {
      const owner = await resolver.forMembership(tenantId, job.requestedByMembershipId)
      // Com o dono activo apaga-se também o ficheiro; sem ele o trabalho expira na mesma e o ficheiro já não se entrega.
      if (owner) await this.expire(owner, job)
      else await this.uow.run((scope) => this.exports.markExpired(scope, job.id), service)
      expired += 1
    }
    const requeued = await this.uow.run(
      (scope) => this.exports.requeueStale(scope, new Date(now.getTime() - STALE_AFTER_MS)),
      service
    )
    return { expired, requeued }
  }
}
