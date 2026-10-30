import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';
import { APP_ENVIRONMENT } from '../../../core/config/app-environment';

export type FieldType = 'string' | 'enum' | 'date' | 'decimal' | 'integer';
export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'contains';
export type MeasureFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type WidgetType = 'KPI' | 'TABLE' | 'BAR' | 'LINE' | 'PIE';
export type Visibility = 'PRIVATE' | 'TENANT';

export interface DatasetField {
  readonly code: string;
  readonly label: string;
  readonly type: FieldType;
  readonly enumValues?: readonly string[];
}

export interface DatasetDto {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly documentation: readonly string[];
  readonly fields: readonly DatasetField[];
}

export interface FilterDto {
  readonly field: string;
  readonly op: FilterOp;
  readonly value: unknown;
}

export interface MeasureDto {
  readonly fn: MeasureFn;
  readonly field?: string;
  readonly alias: string;
}

export interface QueryDto {
  readonly select: readonly string[];
  readonly filters: readonly FilterDto[];
  readonly groupBy: readonly string[];
  readonly measures: readonly MeasureDto[];
  readonly sort: readonly { field: string; dir: 'asc' | 'desc' }[];
}

export interface ReportDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly datasetCode: string;
  readonly query: QueryDto;
  readonly visibility: Visibility;
  readonly status: 'DRAFT' | 'PUBLISHED';
  readonly ownerMembershipId: string;
  readonly publishedAt: string | null;
  readonly version: number;
}

export interface RunResultDto {
  readonly dataset: string;
  readonly columns: readonly { code: string; label: string; type: string }[];
  readonly rows: readonly Record<string, unknown>[];
  readonly total: number;
  readonly omittedFields: readonly string[];
  readonly asOf: string;
}

export interface WidgetDto {
  readonly id: string;
  readonly dashboardId: string;
  readonly reportId: string;
  readonly title: string;
  readonly type: WidgetType;
  readonly layout: { x: number; y: number; w: number; h: number };
  readonly filters: readonly FilterDto[];
  readonly refreshSeconds: number;
  readonly version: number;
}

export interface DashboardDto {
  readonly id: string;
  readonly name: string;
  readonly visibility: Visibility;
  readonly filters: readonly FilterDto[];
  readonly ownerMembershipId: string;
  readonly version: number;
  readonly widgets: readonly WidgetDto[];
}

export interface WidgetDataDto {
  readonly widgetId: string;
  readonly title: string;
  readonly type: WidgetType;
  readonly reportId: string;
  readonly refreshSeconds: number;
  readonly result: RunResultDto | null;
  readonly error: { code: string; message: string } | null;
  readonly ignoredFilters: readonly FilterDto[];
  readonly drill: { reportId: string; filters: readonly FilterDto[] };
}

export interface DashboardDataDto {
  readonly dashboard: DashboardDto;
  readonly widgets: readonly WidgetDataDto[];
  readonly asOf: string;
}

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';

export interface ExportDto {
  readonly id: string;
  readonly reportId: string;
  readonly format: 'CSV' | 'XLSX' | 'PDF';
  readonly status: ExportStatus;
  readonly rowCount: number | null;
  readonly columns: readonly string[] | null;
  readonly expiresAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface SearchGroupDto {
  readonly type: string;
  readonly label: string;
  readonly path: string;
  readonly items: readonly { id: string; title: string; snippet: string }[];
}

export interface SearchResultDto {
  readonly query: string;
  readonly groups: readonly SearchGroupDto[];
  readonly indexedAt: string | null;
}

export interface SearchStatusDto {
  readonly type: string;
  readonly label: string;
  readonly documents: number;
  readonly indexedAt: string | null;
}

export interface ReportBody {
  readonly code?: string;
  readonly name: string;
  readonly datasetCode: string;
  readonly visibility: Visibility;
  readonly query: Partial<QueryDto>;
}

/** Relatórios, painéis, exportações e pesquisa (S04) sobre a API real. */
@Injectable({ providedIn: 'root' })
export class ReportingApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(APP_ENVIRONMENT).apiUrl;

  datasets(): Observable<readonly DatasetDto[]> {
    return this.api.get('datasets');
  }

  reports(): Observable<readonly ReportDto[]> {
    return this.api.get('reports');
  }

  createReport(body: ReportBody & { code: string }): Observable<ReportDto> {
    return this.api.post('reports', body);
  }

  updateReport(id: string, version: number, body: ReportBody): Observable<ReportDto> {
    return this.api.patch(`reports/${id}`, { ...body, version });
  }

  publishReport(id: string): Observable<ReportDto> {
    return this.api.post(`reports/${id}/publish`, {});
  }

  duplicateReport(id: string, code: string): Observable<ReportDto> {
    return this.api.post(`reports/${id}/duplicate`, { code });
  }

  deleteReport(id: string): Observable<void> {
    return this.api.delete(`reports/${id}`);
  }

  run(
    id: string,
    body: { filters?: readonly FilterDto[]; limit?: number; offset?: number },
  ): Observable<RunResultDto> {
    return this.api.post(`reports/${id}/run`, body);
  }

  preview(
    body: { datasetCode: string; query: Partial<QueryDto> },
    paging: { limit?: number; offset?: number } = {},
  ): Observable<RunResultDto> {
    return this.api.post('reports/preview', { ...body, ...paging });
  }

  dashboards(): Observable<readonly DashboardDto[]> {
    return this.api.get('dashboards');
  }

  dashboardData(id: string, filters: readonly FilterDto[]): Observable<DashboardDataDto> {
    return this.api.get(`dashboards/${id}/data`, {
      params: filters.length > 0 ? { filters: JSON.stringify(filters) } : {},
    });
  }

  createDashboard(body: { name: string; visibility: Visibility }): Observable<DashboardDto> {
    return this.api.post('dashboards', body);
  }

  updateDashboard(
    id: string,
    version: number,
    body: { name: string; visibility: Visibility; filters?: readonly FilterDto[] },
  ): Observable<DashboardDto> {
    return this.api.patch(`dashboards/${id}`, { ...body, version });
  }

  deleteDashboard(id: string): Observable<void> {
    return this.api.delete(`dashboards/${id}`);
  }

  addWidget(
    dashboardId: string,
    body: { title: string; type: WidgetType; reportId: string; refreshSeconds?: number },
  ): Observable<WidgetDto> {
    return this.api.post(`dashboards/${dashboardId}/widgets`, body);
  }

  removeWidget(dashboardId: string, widgetId: string): Observable<void> {
    return this.api.delete(`dashboards/${dashboardId}/widgets/${widgetId}`);
  }

  exports(): Observable<readonly ExportDto[]> {
    return this.api.get('exports');
  }

  requestExport(body: { reportId: string; filters?: readonly FilterDto[] }): Observable<ExportDto> {
    return this.api.post('exports', { ...body, format: 'CSV' });
  }

  /** O ficheiro vem do servidor com os direitos revalidados; o browser guarda-o a partir do blob. */
  downloadExport(id: string): Observable<Blob> {
    return this.http
      .get(`${this.apiUrl}/exports/${id}/download`, { responseType: 'blob' })
      .pipe(map((blob) => blob));
  }

  search(q: string, types?: readonly string[]): Observable<SearchResultDto> {
    return this.api.get('search', {
      params: { q, ...(types && types.length > 0 ? { types: types.join(',') } : {}) },
    });
  }

  searchStatus(): Observable<readonly SearchStatusDto[]> {
    return this.api.get('search/status');
  }

  reindex(): Observable<readonly { type: string; indexed: number; removed: number }[]> {
    return this.api.post('search/reindex', {});
  }
}
