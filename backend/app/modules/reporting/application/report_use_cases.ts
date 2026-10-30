import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  applyGlobalFilters,
  normalizeWidget,
  validateQuery,
  type DatasetDefinition,
  type Filter,
  type ReportQuery,
} from '#modules/reporting/domain/reporting'
import { failure, reportValidation } from '#modules/reporting/application/errors'
import type {
  Clock,
  DashboardRecord,
  DashboardStore,
  ReportRecord,
  ReportStore,
  Visibility,
  WidgetRecord,
} from '#modules/reporting/application/ports'
import { allDatasets, datasetOf } from '#modules/reporting/application/registry'
import {
  asFilters,
  type Paging,
  type QueryService,
  type RunResult,
} from '#modules/reporting/application/query_service'

const CODE = /^[a-z][a-z0-9_]{1,49}$/

const membershipOf = (context: TenantContext): string => {
  if (!context.membershipId) throw ApiError.notFound()
  return context.membershipId
}

export interface DatasetView {
  code: string
  name: string
  description: string
  documentation: readonly string[]
  fields: { code: string; label: string; type: string; enumValues?: readonly string[] }[]
}

export interface ReportView {
  id: string
  code: string
  name: string
  datasetCode: string
  query: Pick<ReportQuery, 'select' | 'filters' | 'groupBy' | 'measures' | 'sort'>
  visibility: Visibility
  status: 'DRAFT' | 'PUBLISHED'
  ownerMembershipId: string
  publishedAt: string | null
  version: number
  createdAt: string
}

const reportView = (r: ReportRecord): ReportView => ({
  id: r.id,
  code: r.code,
  name: r.name,
  datasetCode: r.datasetCode,
  query: {
    select: r.selectedFields,
    filters: r.filters,
    groupBy: r.grouping,
    measures: r.measures,
    sort: r.sort,
  },
  visibility: r.visibility,
  status: r.status,
  ownerMembershipId: r.ownerMembershipId,
  publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
  version: r.version,
  createdAt: r.createdAt.toISOString(),
})

/** Um relatório vê-se se é seu, ou se está publicado e é da organização. */
export const reportVisibleTo = (r: ReportRecord, membershipId: string): boolean =>
  r.ownerMembershipId === membershipId || (r.status === 'PUBLISHED' && r.visibility === 'TENANT')

/** Datasets e relatórios: o que se pode correr é decidido no servidor, campo a campo. */
export class ReportUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly reports: ReportStore,
    private readonly query: QueryService,
    private readonly clock: Clock
  ) {}

  async datasets(context: TenantContext): Promise<DatasetView[]> {
    const out: DatasetView[] = []
    for (const dataset of allDatasets()) {
      let fields
      try {
        fields = await this.query.visible(context, dataset)
      } catch {
        continue // sem a permissão do dataset: nem sequer se lista
      }
      out.push({
        code: dataset.code,
        name: dataset.name,
        description: dataset.description,
        documentation: dataset.documentation,
        fields: fields.map((f) => ({
          code: f.code,
          label: f.label,
          type: f.type,
          ...(f.enumValues ? { enumValues: f.enumValues } : {}),
        })),
      })
    }
    return out
  }

  private dataset(code: unknown): DatasetDefinition {
    const found = typeof code === 'string' ? datasetOf(code) : undefined
    if (!found) throw failure('datasetCode', 'UNKNOWN_DATASET', 'Dataset desconhecido.')
    return found
  }

  /** Valida o corpo contra o dataset e os campos que quem desenha vê. */
  private async normalize(context: TenantContext, input: Record<string, unknown>) {
    const dataset = this.dataset(input['datasetCode'])
    const hidden = await this.query.hiddenFields(context, dataset)
    const q = (input['query'] ?? {}) as Record<string, unknown>
    const { value, issues } = validateQuery(dataset, q, hidden)
    if (!value) throw reportValidation(issues)
    const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
    if (!name || name.length > 160)
      throw failure('name', 'REQUIRED', 'Indique o nome (até 160 caracteres).')
    const visibility: Visibility = input['visibility'] === 'TENANT' ? 'TENANT' : 'PRIVATE'
    return {
      datasetCode: dataset.code,
      name,
      visibility,
      selectedFields: value.select,
      filters: value.filters,
      grouping: value.groupBy,
      measures: value.measures,
      sort: value.sort,
    }
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<ReportView> {
    membershipOf(context)
    const code = typeof input['code'] === 'string' ? input['code'].trim() : ''
    if (!CODE.test(code)) throw failure('code', 'INVALID', 'Código inválido (a-z, 0-9 e _).')
    const body = await this.normalize(context, input)
    return this.uow.run(async (scope) => {
      const created = await this.reports.insert(scope, { code, ...body })
      if (!created)
        throw ApiError.conflict('REPORT_CODE_TAKEN', 'Já existe um relatório com este código.')
      return reportView(created)
    }, context)
  }

  async list(context: TenantContext): Promise<ReportView[]> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const all = await this.reports.list(scope, membershipId)
      return all.filter((r) => reportVisibleTo(r, membershipId)).map(reportView)
    }, context)
  }

  async loadVisible(context: TenantContext, id: string): Promise<ReportRecord> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const found = await this.reports.find(scope, id)
      if (!found || !reportVisibleTo(found, membershipId)) throw ApiError.notFound()
      return found
    }, context)
  }

  async get(context: TenantContext, id: string): Promise<ReportView> {
    return reportView(await this.loadVisible(context, id))
  }

  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<ReportView> {
    const membershipId = membershipOf(context)
    const body = await this.normalize(context, input)
    return this.uow.run(async (scope) => {
      const current = await this.reports.lock(scope, id)
      if (!current || current.ownerMembershipId !== membershipId) throw ApiError.notFound()
      if (current.status !== 'DRAFT') {
        throw ApiError.conflict(
          'REPORT_PUBLISHED_IMMUTABLE',
          'Um relatório publicado não se altera: duplique-o.'
        )
      }
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const updated = await this.reports.update(scope, id, version, body)
      if (!updated) throw ApiError.versionConflict(current.version)
      return reportView(updated)
    }, context)
  }

  async publish(context: TenantContext, id: string): Promise<ReportView> {
    const membershipId = membershipOf(context)
    const now = this.clock.now()
    const current = await this.uow.run(async (scope) => {
      const found = await this.reports.find(scope, id)
      if (!found || found.ownerMembershipId !== membershipId) throw ApiError.notFound()
      return found
    }, context)
    if (current.status === 'PUBLISHED') return reportView(current)
    // Valida outra vez: o dataset e os campos podem ter mudado desde que foi desenhado.
    const dataset = this.dataset(current.datasetCode)
    const hidden = await this.query.hiddenFields(context, dataset)
    const { issues } = validateQuery(
      dataset,
      {
        select: current.selectedFields,
        filters: current.filters,
        groupBy: current.grouping,
        measures: current.measures,
        sort: current.sort,
      },
      hidden
    )
    if (issues.length) throw reportValidation(issues)
    return this.uow.run(async (scope) => {
      const locked = await this.reports.lock(scope, id)
      if (!locked) throw ApiError.notFound()
      if (locked.status === 'PUBLISHED') return reportView(locked)
      return reportView(await this.reports.publish(scope, id, now))
    }, context)
  }

  async duplicate(context: TenantContext, id: string, code: unknown): Promise<ReportView> {
    const source = await this.loadVisible(context, id)
    const next = typeof code === 'string' ? code.trim() : ''
    if (!CODE.test(next)) throw failure('code', 'INVALID', 'Código inválido (a-z, 0-9 e _).')
    return this.uow.run(async (scope) => {
      const created = await this.reports.insert(scope, {
        code: next,
        name: `${source.name} (cópia)`.slice(0, 160),
        datasetCode: source.datasetCode,
        selectedFields: source.selectedFields,
        filters: source.filters,
        grouping: source.grouping,
        measures: source.measures,
        sort: source.sort,
        visibility: 'PRIVATE',
      })
      if (!created)
        throw ApiError.conflict('REPORT_CODE_TAKEN', 'Já existe um relatório com este código.')
      return reportView(created)
    }, context)
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    const membershipId = membershipOf(context)
    await this.uow.run(async (scope) => {
      const current = await this.reports.lock(scope, id)
      if (!current || current.ownerMembershipId !== membershipId) throw ApiError.notFound()
      if (current.status !== 'DRAFT') {
        throw ApiError.conflict(
          'REPORT_PUBLISHED_IMMUTABLE',
          'Um relatório publicado não se apaga.'
        )
      }
      if (await this.reports.usedByWidget(scope, id)) {
        throw ApiError.conflict('REPORT_IN_USE', 'O relatório está num painel.')
      }
      await this.reports.remove(scope, id)
    }, context)
  }

  /** Corre um relatório. Um rascunho só corre para o dono; os filtros extra juntam-se aos guardados. */
  async run(
    context: TenantContext,
    id: string,
    extraFilters: unknown,
    paging: Paging
  ): Promise<RunResult> {
    const report = await this.loadVisible(context, id)
    return this.runRecord(context, report, asFilters(extraFilters), paging)
  }

  runRecord(
    context: TenantContext,
    report: ReportRecord,
    extra: Filter[],
    paging: Paging
  ): Promise<RunResult> {
    return this.query.run(
      context,
      this.dataset(report.datasetCode),
      {
        select: report.selectedFields,
        filters: [...report.filters, ...extra],
        groupBy: report.grouping,
        measures: report.measures,
        sort: report.sort,
      },
      paging
    )
  }

  /** Pré-visualização de um relatório ainda por guardar (o construtor). */
  async preview(context: TenantContext, input: Record<string, unknown>, paging: Paging) {
    const dataset = this.dataset(input['datasetCode'])
    return this.query.run(
      context,
      dataset,
      (input['query'] ?? {}) as Record<string, unknown>,
      paging
    )
  }
}

// --- painéis ---------------------------------------------------------------------------------------------

export interface WidgetData {
  widgetId: string
  title: string
  type: string
  reportId: string
  refreshSeconds: number
  layout: WidgetRecord['layout']
  result: RunResult | null
  error: { code: string; message: string } | null
  /** Filtros globais que este widget não aplicou (o dataset não tem esse campo). */
  ignoredFilters: Filter[]
  /** O que o drill-down abre: o mesmo relatório com os mesmos filtros, em listagem. */
  drill: { reportId: string; filters: Filter[] }
}

export interface DashboardView {
  id: string
  name: string
  visibility: Visibility
  filters: Filter[]
  ownerMembershipId: string
  version: number
  widgets: WidgetRecord[]
}

const dashView = (d: DashboardRecord, widgets: WidgetRecord[]): DashboardView => ({
  id: d.id,
  name: d.name,
  visibility: d.visibility,
  filters: d.filters,
  ownerMembershipId: d.ownerMembershipId,
  version: d.version,
  widgets,
})

const WIDGET_LIMIT: Record<string, number> = { KPI: 1, TABLE: 20, BAR: 50, LINE: 100, PIE: 20 }

export class DashboardUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly dashboards: DashboardStore,
    private readonly reports: ReportStore,
    private readonly reportCases: ReportUseCases
  ) {}

  private fields(input: Record<string, unknown>) {
    const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
    if (!name || name.length > 160)
      throw failure('name', 'REQUIRED', 'Indique o nome (até 160 caracteres).')
    const visibility: Visibility = input['visibility'] === 'TENANT' ? 'TENANT' : 'PRIVATE'
    const filters = Array.isArray(input['filters']) ? (input['filters'] as Filter[]) : []
    if (filters.length > 20) throw failure('filters', 'TOO_MANY', 'No máximo 20 filtros.')
    return { name, visibility, filters }
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<DashboardView> {
    membershipOf(context)
    const body = this.fields(input)
    return this.uow.run(
      async (scope) => dashView(await this.dashboards.insert(scope, body), []),
      context
    )
  }

  private visible(d: DashboardRecord, membershipId: string): boolean {
    return d.ownerMembershipId === membershipId || d.visibility === 'TENANT'
  }

  async list(context: TenantContext): Promise<DashboardView[]> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const all = await this.dashboards.list(scope, membershipId)
      return all.filter((d) => this.visible(d, membershipId)).map((d) => dashView(d, []))
    }, context)
  }

  async get(context: TenantContext, id: string): Promise<DashboardView> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const found = await this.dashboards.find(scope, id)
      if (!found || !this.visible(found, membershipId)) throw ApiError.notFound()
      return dashView(found, await this.dashboards.widgets(scope, id))
    }, context)
  }

  private async owned(
    scope: Parameters<DashboardStore['lock']>[0],
    context: TenantContext,
    id: string
  ) {
    const found = await this.dashboards.lock(scope, id)
    if (!found || found.ownerMembershipId !== membershipOf(context)) throw ApiError.notFound()
    return found
  }

  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<DashboardView> {
    const body = this.fields(input)
    return this.uow.run(async (scope) => {
      const current = await this.owned(scope, context, id)
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const widgets = await this.dashboards.widgets(scope, id)
      if (body.visibility === 'TENANT' && current.visibility !== 'TENANT') {
        for (const w of widgets) await this.requireAudience(scope, w.reportId, 'TENANT')
      }
      const updated = await this.dashboards.update(scope, id, version, body)
      if (!updated) throw ApiError.versionConflict(current.version)
      return dashView(updated, widgets)
    }, context)
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    await this.uow.run(async (scope) => {
      await this.owned(scope, context, id)
      await this.dashboards.remove(scope, id)
    }, context)
  }

  /** O relatório de um widget está publicado e é visível a quem vê o painel. */
  private async requireAudience(
    scope: Parameters<ReportStore['find']>[0],
    reportId: string,
    audience: Visibility
  ) {
    const report = await this.reports.find(scope, reportId)
    if (!report) throw failure('reportId', 'REPORT_NOT_FOUND', 'Relatório não encontrado.')
    if (report.status !== 'PUBLISHED') {
      throw failure(
        'reportId',
        'REPORT_NOT_PUBLISHED',
        'Só um relatório publicado entra num painel.'
      )
    }
    if (audience === 'TENANT' && report.visibility !== 'TENANT') {
      throw failure(
        'reportId',
        'REPORT_NOT_SHARED',
        'Num painel da organização só entram relatórios da organização.'
      )
    }
  }

  async addWidget(
    context: TenantContext,
    dashboardId: string,
    input: Record<string, unknown>
  ): Promise<WidgetRecord> {
    const { value, issues } = normalizeWidget(input)
    if (!value) throw reportValidation(issues)
    return this.uow.run(async (scope) => {
      const dashboard = await this.owned(scope, context, dashboardId)
      const report = await this.reports.find(scope, value.reportId)
      if (!report || !reportVisibleTo(report, membershipOf(context))) {
        throw failure('reportId', 'REPORT_NOT_FOUND', 'Relatório não encontrado.')
      }
      await this.requireAudience(scope, value.reportId, dashboard.visibility)
      return this.dashboards.addWidget(scope, dashboardId, value)
    }, context)
  }

  async updateWidget(
    context: TenantContext,
    dashboardId: string,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<WidgetRecord> {
    const { value, issues } = normalizeWidget(input)
    if (!value) throw reportValidation(issues)
    return this.uow.run(async (scope) => {
      const dashboard = await this.owned(scope, context, dashboardId)
      const current = await this.dashboards.findWidget(scope, dashboardId, id)
      if (!current) throw ApiError.notFound()
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      await this.requireAudience(scope, value.reportId, dashboard.visibility)
      const updated = await this.dashboards.updateWidget(scope, id, version, value)
      if (!updated) throw ApiError.versionConflict(current.version)
      return updated
    }, context)
  }

  async removeWidget(context: TenantContext, dashboardId: string, id: string): Promise<void> {
    await this.uow.run(async (scope) => {
      await this.owned(scope, context, dashboardId)
      if (!(await this.dashboards.findWidget(scope, dashboardId, id))) throw ApiError.notFound()
      await this.dashboards.removeWidget(scope, id)
    }, context)
  }

  /**
   * Dados do painel com filtros globais. Cada widget corre com os direitos de quem vê o painel (não os do dono) e uma
   * falha num widget não derruba os outros.
   */
  async data(
    context: TenantContext,
    id: string,
    globalFilters: unknown
  ): Promise<{ dashboard: DashboardView; widgets: WidgetData[]; asOf: string }> {
    const membershipId = membershipOf(context)
    const loaded = await this.uow.run(async (scope) => {
      const found = await this.dashboards.find(scope, id)
      if (!found || !this.visible(found, membershipId)) throw ApiError.notFound()
      const widgets = await this.dashboards.widgets(scope, id)
      const reports = new Map<string, ReportRecord | null>()
      for (const w of widgets) reports.set(w.reportId, await this.reports.find(scope, w.reportId))
      return { found, widgets, reports }
    }, context)
    const global = [...loaded.found.filters, ...asFilters(globalFilters)]
    const out: WidgetData[] = []
    for (const w of loaded.widgets) {
      const report = loaded.reports.get(w.reportId) ?? null
      const base: Omit<WidgetData, 'result' | 'error' | 'ignoredFilters' | 'drill'> = {
        widgetId: w.id,
        title: w.title,
        type: w.type,
        reportId: w.reportId,
        refreshSeconds: w.refreshSeconds,
        layout: w.layout,
      }
      if (
        !report ||
        (report.visibility === 'PRIVATE' && report.ownerMembershipId !== membershipId)
      ) {
        out.push({
          ...base,
          result: null,
          error: {
            code: 'REPORT_NOT_VISIBLE',
            message: 'O relatório deste widget não está disponível.',
          },
          ignoredFilters: [],
          drill: { reportId: w.reportId, filters: [] },
        })
        continue
      }
      const dataset = datasetOf(report.datasetCode)
      const merged = dataset
        ? applyGlobalFilters(dataset, asFilters(w.filters), global)
        : { filters: asFilters(w.filters), ignored: global }
      try {
        const result = await this.reportCases.runRecord(context, report, merged.filters, {
          limit: WIDGET_LIMIT[w.type] ?? 20,
        })
        out.push({
          ...base,
          result,
          error: null,
          ignoredFilters: merged.ignored,
          drill: { reportId: w.reportId, filters: merged.filters },
        })
      } catch (error) {
        const e = error instanceof ApiError ? error : null
        out.push({
          ...base,
          result: null,
          error: {
            code: e?.code ?? 'WIDGET_FAILED',
            message: e?.message ?? 'Não foi possível calcular este widget.',
          },
          ignoredFilters: merged.ignored,
          drill: { reportId: w.reportId, filters: merged.filters },
        })
      }
    }
    return {
      dashboard: dashView(loaded.found, loaded.widgets),
      widgets: out,
      asOf: new Date().toISOString(),
    }
  }
}
