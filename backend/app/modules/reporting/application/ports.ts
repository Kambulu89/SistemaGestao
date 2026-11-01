import type { Readable } from 'node:stream'
import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  BuiltQuery,
  Filter,
  Measure,
  SortSpec,
  WidgetInput,
  WidgetType,
} from '#modules/reporting/domain/reporting'

export interface Clock {
  now(): Date
}

export interface AuthDecision {
  allowed: boolean
  hiddenFields: string[]
}

/** Autorização do servidor (RBAC + ABAC), injectada: este módulo nunca decide sozinho. */
export interface Authorizer {
  decide(context: TenantContext, permission: string): Promise<AuthDecision>
}

/** Executa o SQL já construído e parametrizado dentro da transacção do tenant. */
export interface QueryRunner {
  run(
    scope: TenantScope,
    built: BuiltQuery
  ): Promise<{ rows: Record<string, unknown>[]; total: number }>
}

// --- relatórios --------------------------------------------------------------------------------------

export type Visibility = 'PRIVATE' | 'TENANT'

export interface ReportRecord {
  id: string
  code: string
  name: string
  datasetCode: string
  selectedFields: string[]
  filters: Filter[]
  grouping: string[]
  measures: Measure[]
  sort: SortSpec[]
  visibility: Visibility
  status: 'DRAFT' | 'PUBLISHED'
  ownerMembershipId: string
  publishedAt: Date | null
  version: number
  createdAt: Date
}

export interface NewReport {
  code: string
  name: string
  datasetCode: string
  selectedFields: string[]
  filters: Filter[]
  grouping: string[]
  measures: Measure[]
  sort: SortSpec[]
  visibility: Visibility
}

export interface ReportStore {
  insert(scope: TenantScope, v: NewReport): Promise<ReportRecord | null>
  find(scope: TenantScope, id: string): Promise<ReportRecord | null>
  lock(scope: TenantScope, id: string): Promise<ReportRecord | null>
  list(scope: TenantScope, membershipId: string): Promise<ReportRecord[]>
  update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewReport, 'code'>
  ): Promise<ReportRecord | null>
  publish(scope: TenantScope, id: string, at: Date): Promise<ReportRecord>
  remove(scope: TenantScope, id: string): Promise<void>
  usedByWidget(scope: TenantScope, id: string): Promise<boolean>
}

// --- painéis -----------------------------------------------------------------------------------------

export interface DashboardRecord {
  id: string
  name: string
  ownerMembershipId: string
  visibility: Visibility
  filters: Filter[]
  version: number
  createdAt: Date
}

export interface WidgetRecord extends WidgetInput {
  id: string
  dashboardId: string
  type: WidgetType
  position: number
  version: number
}

export interface DashboardStore {
  insert(
    scope: TenantScope,
    v: { name: string; visibility: Visibility; filters: Filter[] }
  ): Promise<DashboardRecord>
  find(scope: TenantScope, id: string): Promise<DashboardRecord | null>
  lock(scope: TenantScope, id: string): Promise<DashboardRecord | null>
  list(scope: TenantScope, membershipId: string): Promise<DashboardRecord[]>
  update(
    scope: TenantScope,
    id: string,
    version: number,
    v: { name: string; visibility: Visibility; filters: Filter[] }
  ): Promise<DashboardRecord | null>
  remove(scope: TenantScope, id: string): Promise<void>
  widgets(scope: TenantScope, dashboardId: string): Promise<WidgetRecord[]>
  findWidget(scope: TenantScope, dashboardId: string, id: string): Promise<WidgetRecord | null>
  addWidget(scope: TenantScope, dashboardId: string, v: WidgetInput): Promise<WidgetRecord>
  updateWidget(
    scope: TenantScope,
    id: string,
    version: number,
    v: WidgetInput
  ): Promise<WidgetRecord | null>
  removeWidget(scope: TenantScope, id: string): Promise<void>
}

// --- exportações -------------------------------------------------------------------------------------

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED'

export interface ExportRecord {
  id: string
  reportId: string
  requestedByMembershipId: string
  filters: Filter[]
  format: 'CSV' | 'XLSX' | 'PDF'
  status: ExportStatus
  attachmentId: string | null
  columns: string[] | null
  expiresAt: Date | null
  rowCount: number | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

export interface ExportStore {
  insert(
    scope: TenantScope,
    v: { reportId: string; filters: Filter[]; format: ExportRecord['format'] }
  ): Promise<ExportRecord>
  find(scope: TenantScope, id: string): Promise<ExportRecord | null>
  listOwn(scope: TenantScope, membershipId: string, limit: number): Promise<ExportRecord[]>
  /** Reclama o mais antigo na fila (`FOR UPDATE SKIP LOCKED`). */
  claim(scope: TenantScope, now: Date): Promise<ExportRecord | null>
  markReady(
    scope: TenantScope,
    id: string,
    v: { attachmentId: string; columns: string[]; rowCount: number; expiresAt: Date; at: Date }
  ): Promise<ExportRecord>
  markFailed(
    scope: TenantScope,
    id: string,
    v: { code: string; message: string; at: Date }
  ): Promise<ExportRecord>
  markExpired(scope: TenantScope, id: string): Promise<ExportRecord>
  expiredReady(scope: TenantScope, now: Date, limit: number): Promise<ExportRecord[]>
  /** Reentra no estado `QUEUED` os que ficaram `RUNNING` há demasiado tempo (processo caído). */
  requeueStale(scope: TenantScope, before: Date): Promise<number>
}

/** Ficheiros gerados guardados pelos documentos (a quota e o armazenamento são deles). */
export interface GeneratedFiles {
  store(
    context: TenantContext,
    file: { fileName: string; mimeType: string; data: Buffer }
  ): Promise<{ id: string }>
  open(
    context: TenantContext,
    id: string
  ): Promise<{ fileName: string; mimeType: string; sizeBytes: number; stream: Readable }>
  remove(context: TenantContext, id: string): Promise<void>
}

/** Contexto de quem pediu a exportação, revalidado agora (membership activa, tenant operacional). */
export interface ContextResolver {
  forMembership(tenantId: string, membershipId: string): Promise<TenantContext | null>
  tenantIds(): Promise<string[]>
}

// --- pesquisa ----------------------------------------------------------------------------------------

export interface SearchItem {
  resourceId: string
  title: string
  text: string
  unitId?: string | null
  ownerMembershipId?: string | null
}

/** Uma origem de pesquisa: o módulo dono diz como se indexa e quem pode ver cada resultado. */
export interface SearchSource {
  type: string
  label: string
  /** Permissão para pesquisar este tipo. */
  permission: string
  /** Percorre o tipo em páginas estáveis (leitura derivada: o índice reconstrói-se daqui). */
  scan(
    scope: TenantScope,
    after: string | null,
    limit: number
  ): Promise<{ items: SearchItem[]; next: string | null }>
  /** O actor pode ver este recurso agora (aplica o âmbito e a visibilidade do módulo dono). */
  canRead(context: TenantContext, resourceId: string): Promise<boolean>
  /** Caminho no frontend. */
  path: string
}

export interface SearchHit {
  resourceType: string
  resourceId: string
  title: string
  text: string
  indexedAt: Date
}

export interface SearchStore {
  /** Substitui/acrescenta documentos de um tipo com a versão de indexação. */
  upsert(scope: TenantScope, type: string, items: SearchItem[], version: number): Promise<void>
  /** Apaga o que não foi visto na versão actual (recurso apagado entretanto). */
  prune(scope: TenantScope, type: string, version: number): Promise<number>
  currentVersion(scope: TenantScope, type: string): Promise<number>
  query(scope: TenantScope, type: string, terms: string[], limit: number): Promise<SearchHit[]>
  status(
    scope: TenantScope
  ): Promise<{ resourceType: string; documents: number; indexedAt: Date | null }[]>
}
