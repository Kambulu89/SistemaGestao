import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { DashboardsTab } from './dashboards-tab';
import { ExportsTab } from './exports-tab';
import {
  ReportingApi,
  type DashboardDataDto,
  type DashboardDto,
  type ExportDto,
  type RunResultDto,
} from './reporting.api';
import {
  buildFilter,
  chartPoints,
  describeFilter,
  formatCell,
  reportingError,
} from './reporting-model';
import { ReportingPage } from './reporting-page';

const result = (over: Partial<RunResultDto> = {}): RunResultDto => ({
  dataset: 'sales_documents',
  columns: [
    { code: 'status', label: 'Estado', type: 'enum' },
    { code: 'total', label: 'Total', type: 'measure' },
  ],
  rows: [
    { status: 'ISSUED', total: '1234567.5000' },
    { status: 'CREDITED', total: '-20.0000' },
  ],
  total: 2,
  omittedFields: [],
  asOf: '2026-10-30T10:20:30.000Z',
  ...over,
});

describe('reporting model', () => {
  it('shows decimals exactly, as text, with grouping', () => {
    expect(formatCell('1234567.5000', 'decimal')).toBe('1\u202f234\u202f567,5000');
    expect(formatCell('-20.0000', 'measure')).toBe('-20,0000');
    expect(formatCell(null, 'decimal')).toBe('—');
    expect(formatCell('ISSUED', 'enum')).toBe('ISSUED');
  });

  it('builds typed filters and rejects malformed values', () => {
    const decimal = { code: 'total', label: 'Total', type: 'decimal' } as const;
    expect(buildFilter(decimal, 'gte', '10.50')).toEqual({
      filter: { field: 'total', op: 'gte', value: '10.50' },
    });
    expect(buildFilter(decimal, 'gte', 'abc')).toEqual({ error: 'Indique um número.' });
    const date = { code: 'issued_on', label: 'Data', type: 'date' } as const;
    expect(buildFilter(date, 'between', '2026-01-01', '2026-02-01')).toEqual({
      filter: { field: 'issued_on', op: 'between', value: ['2026-01-01', '2026-02-01'] },
    });
    expect(buildFilter(date, 'eq', '01/01/2026')).toEqual({
      error: 'Indique a data como AAAA-MM-DD.',
    });
    const list = { code: 'status', label: 'Estado', type: 'enum' } as const;
    expect(buildFilter(list, 'in', 'A, B')).toEqual({
      filter: { field: 'status', op: 'in', value: ['A', 'B'] },
    });
  });

  it('describes filters with the field label', () => {
    expect(
      describeFilter({ field: 'status', op: 'eq', value: 'ISSUED' }, [
        { code: 'status', label: 'Estado', type: 'enum' },
      ]),
    ).toContain('Estado');
  });

  it('turns a grouped result into chart points (category + first measure)', () => {
    expect(chartPoints(result())).toEqual([
      { label: 'ISSUED', value: 1234567.5 },
      { label: 'CREDITED', value: -20 },
    ]);
    expect(chartPoints(result({ columns: [], rows: [] }))).toEqual([]);
  });

  it('translates server error codes', () => {
    expect(reportingError({ code: 'EXPORT_ACCESS_REVOKED' }, 'x')).toContain('acesso');
    expect(reportingError({ code: 'FIELD_NOT_ALLOWED' }, 'x')).toContain('campo');
    expect(reportingError({}, 'falhou')).toBe('falhou');
  });
});

const dashboard = (): DashboardDto => ({
  id: 'd1',
  name: 'Vendas',
  visibility: 'TENANT',
  filters: [],
  ownerMembershipId: 'm1',
  version: 1,
  widgets: [],
});

const data = (): DashboardDataDto => ({
  dashboard: dashboard(),
  asOf: '2026-10-30T10:20:30.000Z',
  widgets: [
    {
      widgetId: 'w1',
      title: 'Total facturado',
      type: 'KPI',
      reportId: 'r1',
      refreshSeconds: 60,
      result: result({
        columns: [{ code: 'total', label: 'Total', type: 'measure' }],
        rows: [{ total: '1000.0000' }],
        total: 1,
      }),
      error: null,
      ignoredFilters: [{ field: 'customer', op: 'eq', value: 'x' }],
      drill: { reportId: 'r1', filters: [] },
    },
    {
      widgetId: 'w2',
      title: 'Por estado',
      type: 'BAR',
      reportId: 'r2',
      refreshSeconds: 60,
      result: result(),
      error: null,
      ignoredFilters: [],
      drill: { reportId: 'r2', filters: [] },
    },
    {
      widgetId: 'w3',
      title: 'Indisponível',
      type: 'TABLE',
      reportId: 'r3',
      refreshSeconds: 60,
      result: null,
      error: { code: 'REPORT_NOT_VISIBLE', message: 'x' },
      ignoredFilters: [],
      drill: { reportId: 'r3', filters: [] },
    },
  ],
});

function setup(granted: string[], api: Partial<Record<keyof ReportingApi, unknown>> = {}) {
  const full = {
    datasets: vi.fn(() => of([])),
    reports: vi.fn(() => of([])),
    dashboards: vi.fn(() => of([dashboard()])),
    dashboardData: vi.fn(() => of(data())),
    exports: vi.fn(() => of([])),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: ReportingApi, useValue: full },
    ],
  });
  return full;
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

const host = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement;

describe('ReportingPage', () => {
  it('only shows the tabs the person may use', async () => {
    setup(['report.read']);
    const fixture = TestBed.createComponent(ReportingPage);
    await settle(fixture);
    expect(host(fixture).querySelector('[data-testid="tab-dashboards"]')).not.toBeNull();
    expect(host(fixture).querySelector('[data-testid="tab-reports"]')).not.toBeNull();
    expect(host(fixture).querySelector('[data-testid="tab-exports"]')).toBeNull();
  });
});

describe('DashboardsTab', () => {
  it('renders KPI exact value, chart, per-widget error and freshness', async () => {
    setup(['report.read']);
    const fixture = TestBed.createComponent(DashboardsTab);
    await settle(fixture);
    const el = host(fixture);
    expect(el.querySelector('[data-testid="kpi"]')?.textContent?.trim()).toBe('1\u202f000,0000');
    expect(el.querySelector('[data-testid="widget-BAR"] svg')).not.toBeNull();
    expect(el.querySelector('[data-testid="widget-error"]')?.textContent).toContain(
      'não está disponível',
    );
    expect(el.querySelector('[data-testid="ignored"]')?.textContent).toContain('1 filtro');
    expect(el.querySelector('[data-testid="as-of"]')?.textContent).toContain('10:20:30');
    // Sem permissão de desenho não há botões de gestão.
    expect(el.textContent).not.toContain('Novo painel');
  });

  it('shows the error when the dashboard cannot be computed', async () => {
    setup(['report.read'], {
      dashboardData: vi.fn(() => throwError(() => ({ code: 'PERMISSION_DENIED' }))),
    });
    const fixture = TestBed.createComponent(DashboardsTab);
    await settle(fixture);
    expect(host(fixture).textContent).toContain('Não tem permissão');
  });
});

const exportJob = (over: Partial<ExportDto> = {}): ExportDto => ({
  id: 'e1',
  reportId: 'r1',
  format: 'CSV',
  status: 'READY',
  rowCount: 12,
  columns: ['status'],
  expiresAt: '2026-10-31T10:00:00Z',
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-10-30T10:00:00Z',
  finishedAt: '2026-10-30T10:00:05Z',
  ...over,
});

describe('ExportsTab', () => {
  it('lists exports and offers download only when ready', async () => {
    setup(['report.export'], {
      exports: vi.fn(() =>
        of([
          exportJob(),
          exportJob({ id: 'e2', status: 'EXPIRED' }),
          exportJob({ id: 'e3', status: 'FAILED', errorCode: 'ROW_LIMIT', errorMessage: 'x' }),
        ]),
      ),
    });
    const fixture = TestBed.createComponent(ExportsTab);
    await settle(fixture);
    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Pronta');
    expect(text).toContain('Expirada');
    expect(text).toContain('limite de linhas');
    expect(
      [...host(fixture).querySelectorAll('button')].filter((b) =>
        b.textContent?.includes('Descarregar'),
      ),
    ).toHaveLength(1);
  });

  it('shows the server refusal when the download is revoked', async () => {
    setup(['report.export'], {
      exports: vi.fn(() => of([exportJob()])),
      downloadExport: vi.fn(() => throwError(() => ({ code: 'EXPORT_ACCESS_REVOKED' }))),
    });
    const fixture = TestBed.createComponent(ExportsTab);
    await settle(fixture);
    const button = [...host(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Descarregar'),
    );
    button?.click();
    await settle(fixture);
    expect(host(fixture).querySelector('[data-testid="export-error"]')?.textContent).toContain(
      'Já não tem acesso',
    );
  });
});
