import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  BuiltQuery,
  Filter,
  Measure,
  SortSpec,
  WidgetInput,
  WidgetType,
} from '#modules/reporting/domain/reporting'
import type {
  DashboardRecord,
  DashboardStore,
  ExportRecord,
  ExportStatus,
  ExportStore,
  NewReport,
  QueryRunner,
  ReportRecord,
  ReportStore,
  SearchHit,
  SearchItem,
  SearchStore,
  Visibility,
  WidgetRecord,
} from '#modules/reporting/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

type Bind = never[]
async function query<T>(scope: TenantScope, sql: string, bindings: unknown[] = []): Promise<T[]> {
  const result = await trxOf(scope).rawQuery(sql, bindings as Bind)
  return result.rows as T[]
}

// --- execução de consultas declarativas -------------------------------------------------------------

/** Corre o SQL construído pelo domínio. Os valores vão sempre como parâmetros nomeados. */
export class LucidQueryRunner implements QueryRunner {
  async run(scope: TenantScope, built: BuiltQuery) {
    const main = await trxOf(scope).rawQuery(built.sql, built.bindings as never)
    const counted = await trxOf(scope).rawQuery(built.countSql, built.bindings as never)
    const rows = main.rows as Record<string, unknown>[]
    const count = counted.rows as { total: number }[]
    return { rows, total: count[0]?.total ?? 0 }
  }
}

// --- relatórios --------------------------------------------------------------------------------------

interface ReportRow {
  id: string
  code: string
  name: string
  dataset_code: string
  selected_fields: string[]
  filters_schema: Filter[]
  grouping: string[]
  measures: Measure[]
  sort: SortSpec[]
  visibility: Visibility
  status: 'DRAFT' | 'PUBLISHED'
  owner_membership_id: string
  published_at: Date | null
  version: number
  created_at: Date
}

const REPORT_COLUMNS = `id, code, name, dataset_code, selected_fields, filters_schema, grouping, measures, sort,
  visibility, status, owner_membership_id, published_at, version, created_at`

const toReport = (r: ReportRow): ReportRecord => ({
  id: r.id,
  code: r.code,
  name: r.name,
  datasetCode: r.dataset_code,
  selectedFields: r.selected_fields,
  filters: r.filters_schema,
  grouping: r.grouping,
  measures: r.measures,
  sort: r.sort,
  visibility: r.visibility,
  status: r.status,
  ownerMembershipId: r.owner_membership_id,
  publishedAt: r.published_at,
  version: r.version,
  createdAt: r.created_at,
})

const json = (value: unknown) => JSON.stringify(value)

export class LucidReportStore implements ReportStore {
  async insert(scope: TenantScope, v: NewReport) {
    const rows = await query<ReportRow>(
      scope,
      `insert into report_definitions (tenant_id, code, name, dataset_code, selected_fields, filters_schema, grouping,
         measures, sort, visibility, owner_membership_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?)
       on conflict (tenant_id, code) do nothing returning ${REPORT_COLUMNS}`,
      [
        tenantOf(scope),
        v.code,
        v.name,
        v.datasetCode,
        json(v.selectedFields),
        json(v.filters),
        json(v.grouping),
        json(v.measures),
        json(v.sort),
        v.visibility,
        actorOf(scope),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return rows[0] ? toReport(rows[0]) : null
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<ReportRow>(
      scope,
      `select ${REPORT_COLUMNS} from report_definitions where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toReport(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    const rows = await query<ReportRow>(
      scope,
      `select ${REPORT_COLUMNS} from report_definitions where tenant_id = ? and id = ? for update`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toReport(rows[0]) : null
  }

  async list(scope: TenantScope, membershipId: string) {
    const rows = await query<ReportRow>(
      scope,
      `select ${REPORT_COLUMNS} from report_definitions
        where tenant_id = ? and (owner_membership_id = ? or (status = 'PUBLISHED' and visibility = 'TENANT'))
        order by name, id`,
      [tenantOf(scope), membershipId]
    )
    return rows.map(toReport)
  }

  async update(scope: TenantScope, id: string, version: number, v: Omit<NewReport, 'code'>) {
    const rows = await query<ReportRow>(
      scope,
      `update report_definitions set name = ?, dataset_code = ?, selected_fields = ?::jsonb,
              filters_schema = ?::jsonb, grouping = ?::jsonb, measures = ?::jsonb, sort = ?::jsonb, visibility = ?,
              updated_at = now(), version = version + 1, updated_by_membership_id = ?
        where tenant_id = ? and id = ? and version = ? returning ${REPORT_COLUMNS}`,
      [
        v.name,
        v.datasetCode,
        json(v.selectedFields),
        json(v.filters),
        json(v.grouping),
        json(v.measures),
        json(v.sort),
        v.visibility,
        actorOf(scope),
        tenantOf(scope),
        id,
        version,
      ]
    )
    return rows[0] ? toReport(rows[0]) : null
  }

  async publish(scope: TenantScope, id: string, at: Date) {
    const rows = await query<ReportRow>(
      scope,
      `update report_definitions set status = 'PUBLISHED', published_at = ?, updated_at = now(),
              version = version + 1, updated_by_membership_id = ?
        where tenant_id = ? and id = ? returning ${REPORT_COLUMNS}`,
      [at, actorOf(scope), tenantOf(scope), id]
    )
    return toReport(rows[0] as ReportRow)
  }

  async remove(scope: TenantScope, id: string) {
    await query(scope, `delete from report_definitions where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async usedByWidget(scope: TenantScope, id: string) {
    const rows = await query(
      scope,
      `select 1 from dashboard_widgets where tenant_id = ? and report_id = ? limit 1`,
      [tenantOf(scope), id]
    )
    return rows.length > 0
  }
}

// --- painéis -----------------------------------------------------------------------------------------

interface DashRow {
  id: string
  name: string
  owner_membership_id: string
  visibility: Visibility
  filters: Filter[]
  version: number
  created_at: Date
}

const DASH_COLUMNS = `id, name, owner_membership_id, visibility, filters, version, created_at`

const toDash = (r: DashRow): DashboardRecord => ({
  id: r.id,
  name: r.name,
  ownerMembershipId: r.owner_membership_id,
  visibility: r.visibility,
  filters: r.filters,
  version: r.version,
  createdAt: r.created_at,
})

interface WidgetRow {
  id: string
  dashboard_id: string
  report_id: string
  title: string
  type: WidgetType
  layout: WidgetInput['layout']
  filters: unknown[]
  refresh_seconds: number
  position: number
  version: number
}

const WIDGET_COLUMNS = `id, dashboard_id, report_id, title, type, layout, filters, refresh_seconds, position, version`

const toWidget = (r: WidgetRow): WidgetRecord => ({
  id: r.id,
  dashboardId: r.dashboard_id,
  reportId: r.report_id,
  title: r.title,
  type: r.type,
  layout: r.layout,
  filters: r.filters,
  refreshSeconds: r.refresh_seconds,
  position: r.position,
  version: r.version,
})

export class LucidDashboardStore implements DashboardStore {
  async insert(scope: TenantScope, v: { name: string; visibility: Visibility; filters: Filter[] }) {
    const rows = await query<DashRow>(
      scope,
      `insert into dashboards (tenant_id, name, visibility, filters, owner_membership_id,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?::jsonb, ?, ?, ?) returning ${DASH_COLUMNS}`,
      [
        tenantOf(scope),
        v.name,
        v.visibility,
        json(v.filters),
        actorOf(scope),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toDash(rows[0] as DashRow)
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<DashRow>(
      scope,
      `select ${DASH_COLUMNS} from dashboards where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toDash(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    const rows = await query<DashRow>(
      scope,
      `select ${DASH_COLUMNS} from dashboards where tenant_id = ? and id = ? for update`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toDash(rows[0]) : null
  }

  async list(scope: TenantScope, membershipId: string) {
    const rows = await query<DashRow>(
      scope,
      `select ${DASH_COLUMNS} from dashboards
        where tenant_id = ? and (owner_membership_id = ? or visibility = 'TENANT') order by name, id`,
      [tenantOf(scope), membershipId]
    )
    return rows.map(toDash)
  }

  async update(
    scope: TenantScope,
    id: string,
    version: number,
    v: { name: string; visibility: Visibility; filters: Filter[] }
  ) {
    const rows = await query<DashRow>(
      scope,
      `update dashboards set name = ?, visibility = ?, filters = ?::jsonb, updated_at = now(),
              version = version + 1, updated_by_membership_id = ?
        where tenant_id = ? and id = ? and version = ? returning ${DASH_COLUMNS}`,
      [v.name, v.visibility, json(v.filters), actorOf(scope), tenantOf(scope), id, version]
    )
    return rows[0] ? toDash(rows[0]) : null
  }

  async remove(scope: TenantScope, id: string) {
    await query(scope, `delete from dashboard_widgets where tenant_id = ? and dashboard_id = ?`, [
      tenantOf(scope),
      id,
    ])
    await query(scope, `delete from dashboards where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async widgets(scope: TenantScope, dashboardId: string) {
    const rows = await query<WidgetRow>(
      scope,
      `select ${WIDGET_COLUMNS} from dashboard_widgets where tenant_id = ? and dashboard_id = ?
        order by position, id`,
      [tenantOf(scope), dashboardId]
    )
    return rows.map(toWidget)
  }

  async findWidget(scope: TenantScope, dashboardId: string, id: string) {
    const rows = await query<WidgetRow>(
      scope,
      `select ${WIDGET_COLUMNS} from dashboard_widgets where tenant_id = ? and dashboard_id = ? and id = ?`,
      [tenantOf(scope), dashboardId, id]
    )
    return rows[0] ? toWidget(rows[0]) : null
  }

  async addWidget(scope: TenantScope, dashboardId: string, v: WidgetInput) {
    const rows = await query<WidgetRow>(
      scope,
      `insert into dashboard_widgets (tenant_id, dashboard_id, report_id, title, type, layout, filters,
         refresh_seconds, position, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?,
         (select coalesce(max(position), -1) + 1 from dashboard_widgets where tenant_id = ? and dashboard_id = ?),
         ?, ?)
       returning ${WIDGET_COLUMNS}`,
      [
        tenantOf(scope),
        dashboardId,
        v.reportId,
        v.title,
        v.type,
        json(v.layout),
        json(v.filters),
        v.refreshSeconds,
        tenantOf(scope),
        dashboardId,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toWidget(rows[0] as WidgetRow)
  }

  async updateWidget(scope: TenantScope, id: string, version: number, v: WidgetInput) {
    const rows = await query<WidgetRow>(
      scope,
      `update dashboard_widgets set report_id = ?, title = ?, type = ?, layout = ?::jsonb, filters = ?::jsonb,
              refresh_seconds = ?, updated_at = now(), version = version + 1, updated_by_membership_id = ?
        where tenant_id = ? and id = ? and version = ? returning ${WIDGET_COLUMNS}`,
      [
        v.reportId,
        v.title,
        v.type,
        json(v.layout),
        json(v.filters),
        v.refreshSeconds,
        actorOf(scope),
        tenantOf(scope),
        id,
        version,
      ]
    )
    return rows[0] ? toWidget(rows[0]) : null
  }

  async removeWidget(scope: TenantScope, id: string) {
    await query(scope, `delete from dashboard_widgets where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }
}

// --- exportações -------------------------------------------------------------------------------------

interface ExportRow {
  id: string
  report_id: string
  requested_by_membership_id: string
  filters_snapshot: Filter[]
  format: 'CSV' | 'XLSX' | 'PDF'
  status: ExportStatus
  attachment_id: string | null
  columns: string[] | null
  expires_at: Date | null
  row_count: number | null
  error_code: string | null
  error_message: string | null
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
}

const EXPORT_COLUMNS = `id, report_id, requested_by_membership_id, filters_snapshot, format, status, attachment_id,
  columns, expires_at, row_count, error_code, error_message, started_at, finished_at, created_at`

const toExport = (r: ExportRow): ExportRecord => ({
  id: r.id,
  reportId: r.report_id,
  requestedByMembershipId: r.requested_by_membership_id,
  filters: r.filters_snapshot,
  format: r.format,
  status: r.status,
  attachmentId: r.attachment_id,
  columns: r.columns,
  expiresAt: r.expires_at,
  rowCount: r.row_count,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
})

export class LucidExportStore implements ExportStore {
  async insert(
    scope: TenantScope,
    v: { reportId: string; filters: Filter[]; format: ExportRecord['format'] }
  ) {
    const rows = await query<ExportRow>(
      scope,
      `insert into export_jobs (tenant_id, report_id, requested_by_membership_id, filters_snapshot, format,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?::jsonb, ?, ?, ?) returning ${EXPORT_COLUMNS}`,
      [
        tenantOf(scope),
        v.reportId,
        actorOf(scope),
        json(v.filters),
        v.format,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toExport(rows[0] as ExportRow)
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<ExportRow>(
      scope,
      `select ${EXPORT_COLUMNS} from export_jobs where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toExport(rows[0]) : null
  }

  async listOwn(scope: TenantScope, membershipId: string, limit: number) {
    const rows = await query<ExportRow>(
      scope,
      `select ${EXPORT_COLUMNS} from export_jobs where tenant_id = ? and requested_by_membership_id = ?
        order by created_at desc, id limit ?`,
      [tenantOf(scope), membershipId, limit]
    )
    return rows.map(toExport)
  }

  async claim(scope: TenantScope, now: Date) {
    const rows = await query<ExportRow>(
      scope,
      `update export_jobs set status = 'RUNNING', started_at = ?, updated_at = now(), version = version + 1
        where id = (select id from export_jobs where tenant_id = ? and status = 'QUEUED'
                     order by created_at, id for update skip locked limit 1)
          and tenant_id = ? returning ${EXPORT_COLUMNS}`,
      [now, tenantOf(scope), tenantOf(scope)]
    )
    return rows[0] ? toExport(rows[0]) : null
  }

  async markReady(
    scope: TenantScope,
    id: string,
    v: { attachmentId: string; columns: string[]; rowCount: number; expiresAt: Date; at: Date }
  ) {
    const rows = await query<ExportRow>(
      scope,
      `update export_jobs set status = 'READY', attachment_id = ?, columns = ?::jsonb, row_count = ?,
              expires_at = ?, finished_at = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? returning ${EXPORT_COLUMNS}`,
      [v.attachmentId, json(v.columns), v.rowCount, v.expiresAt, v.at, tenantOf(scope), id]
    )
    return toExport(rows[0] as ExportRow)
  }

  async markFailed(scope: TenantScope, id: string, v: { code: string; message: string; at: Date }) {
    const rows = await query<ExportRow>(
      scope,
      `update export_jobs set status = 'FAILED', error_code = ?, error_message = ?, finished_at = ?,
              updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? returning ${EXPORT_COLUMNS}`,
      [v.code, v.message.slice(0, 300), v.at, tenantOf(scope), id]
    )
    return toExport(rows[0] as ExportRow)
  }

  async markExpired(scope: TenantScope, id: string) {
    const rows = await query<ExportRow>(
      scope,
      `update export_jobs set status = 'EXPIRED', updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and status = 'READY' returning ${EXPORT_COLUMNS}`,
      [tenantOf(scope), id]
    )
    return rows[0] ? toExport(rows[0]) : ((await this.find(scope, id)) as ExportRecord)
  }

  async expiredReady(scope: TenantScope, now: Date, limit: number) {
    const rows = await query<ExportRow>(
      scope,
      `select ${EXPORT_COLUMNS} from export_jobs where tenant_id = ? and status = 'READY' and expires_at < ?
        order by expires_at limit ?`,
      [tenantOf(scope), now, limit]
    )
    return rows.map(toExport)
  }

  async requeueStale(scope: TenantScope, before: Date) {
    const rows = await query(
      scope,
      `update export_jobs set status = 'QUEUED', updated_at = now(), version = version + 1
        where tenant_id = ? and status = 'RUNNING' and started_at < ? returning id`,
      [tenantOf(scope), before]
    )
    return rows.length
  }
}

// --- pesquisa ----------------------------------------------------------------------------------------

export class LucidSearchStore implements SearchStore {
  async upsert(scope: TenantScope, type: string, items: SearchItem[], version: number) {
    for (const item of items) {
      await query(
        scope,
        `insert into search_documents (tenant_id, resource_type, resource_id, title, searchable_text, unit_id,
           owner_membership_id, indexed_version, indexed_at, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, now(), ?, ?)
         on conflict (tenant_id, resource_type, resource_id) do update
           set title = excluded.title, searchable_text = excluded.searchable_text, unit_id = excluded.unit_id,
               owner_membership_id = excluded.owner_membership_id, indexed_version = excluded.indexed_version,
               indexed_at = now(), updated_at = now(), version = search_documents.version + 1`,
        [
          tenantOf(scope),
          type,
          item.resourceId,
          item.title.slice(0, 300),
          item.text,
          item.unitId ?? null,
          item.ownerMembershipId ?? null,
          version,
          actorOf(scope),
          actorOf(scope),
        ]
      )
    }
  }

  async prune(scope: TenantScope, type: string, version: number) {
    const rows = await query(
      scope,
      `delete from search_documents where tenant_id = ? and resource_type = ? and indexed_version < ? returning id`,
      [tenantOf(scope), type, version]
    )
    return rows.length
  }

  async currentVersion(scope: TenantScope, type: string) {
    const rows = await query<{ v: number | null }>(
      scope,
      `select max(indexed_version) as v from search_documents where tenant_id = ? and resource_type = ?`,
      [tenantOf(scope), type]
    )
    return rows[0]?.v ?? 0
  }

  async query(
    scope: TenantScope,
    type: string,
    terms: string[],
    limit: number
  ): Promise<SearchHit[]> {
    // Cada termo tem de aparecer no título ou no texto (E lógico); `ilike` com escape, sem interpretar o termo.
    const where = terms.map(() => `searchable_text ilike ? escape '\\'`).join(' and ')
    const rows = await query<{
      resource_type: string
      resource_id: string
      title: string
      searchable_text: string
      indexed_at: Date
    }>(
      scope,
      `select resource_type, resource_id, title, searchable_text, indexed_at from search_documents
        where tenant_id = ? and resource_type = ? and ${where} order by title, resource_id limit ?`,
      [
        tenantOf(scope),
        type,
        ...terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
        limit,
      ]
    )
    return rows.map((r) => ({
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      title: r.title,
      text: r.searchable_text,
      indexedAt: r.indexed_at,
    }))
  }

  async status(scope: TenantScope) {
    const rows = await query<{ resource_type: string; documents: number; indexed_at: Date | null }>(
      scope,
      `select resource_type, count(*)::int as documents, max(indexed_at) as indexed_at
         from search_documents where tenant_id = ? group by resource_type order by resource_type`,
      [tenantOf(scope)]
    )
    return rows.map((r) => ({
      resourceType: r.resource_type,
      documents: r.documents,
      indexedAt: r.indexed_at,
    }))
  }
}
