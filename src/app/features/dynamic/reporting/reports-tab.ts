import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import {
  ReportingApi,
  type DatasetDto,
  type FilterDto,
  type FilterOp,
  type MeasureDto,
  type MeasureFn,
  type QueryDto,
  type ReportDto,
  type RunResultDto,
  type Visibility,
} from './reporting.api';
import {
  buildFilter,
  describeFilter,
  MEASURE_LABEL,
  OP_LABEL,
  OPS_BY_TYPE,
  reportingError,
} from './reporting-model';
import { ResultTable } from './result-table';

const PAGE = 20;
const MEASURE_OPTIONS: readonly SelectOption[] = (Object.keys(MEASURE_LABEL) as MeasureFn[]).map(
  (value) => ({ value, label: MEASURE_LABEL[value] }),
);
const VISIBILITY_OPTIONS: readonly SelectOption[] = [
  { value: 'PRIVATE', label: 'Privado (só eu)' },
  { value: 'TENANT', label: 'Toda a organização' },
];

interface Draft {
  readonly select: readonly string[];
  readonly groupBy: readonly string[];
  readonly measures: readonly MeasureDto[];
  readonly filters: readonly FilterDto[];
  readonly sort: readonly { field: string; dir: 'asc' | 'desc' }[];
}

const EMPTY: Draft = { select: [], groupBy: [], measures: [], filters: [], sort: [] };

/**
 * Relatórios: consultas declarativas sobre datasets autorizados (nunca SQL). O construtor só oferece os campos que a
 * pessoa vê; o servidor volta a validar tudo e aplica a autorização antes de agregar.
 */
@Component({
  selector: 'app-reports-tab',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    ResultTable,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex items-center justify-between">
      <p class="text-sm text-fg-muted">
        Um relatório escolhe campos, filtros, agrupamento e medidas de um dataset. Publicado, deixa
        de mudar; os painéis e as exportações usam relatórios publicados.
      </p>
      @if (canDesign()) {
        <app-button (click)="openBuilder(null)">Novo relatório</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (reports.isLoading() && !reports.hasValue()) {
        <app-loading-state label="A carregar relatórios…" />
      } @else if (reports.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os relatórios">
            {{ describe(reports.error()) }}
          </app-alert>
        </div>
      } @else if (reports.hasValue() && reports.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="chart" title="Sem relatórios" />
        } @else {
          <app-table caption="Relatórios" [columns]="columns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.code }}</span>
                }
                @case ('dataset') {
                  {{ datasetName(row.datasetCode) }}
                }
                @case ('status') {
                  <app-badge [tone]="row.status === 'PUBLISHED' ? 'success' : 'neutral'">{{
                    row.status === 'PUBLISHED' ? 'Publicado' : 'Rascunho'
                  }}</app-badge>
                  <span class="block text-xs text-fg-muted">{{
                    row.visibility === 'TENANT' ? 'Organização' : 'Privado'
                  }}</span>
                }
                @case ('actions') {
                  <span class="flex flex-wrap justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="openRun(row)"
                      >Correr</app-button
                    >
                    @if (canDesign() && row.status === 'DRAFT') {
                      <app-button size="sm" variant="secondary" (click)="openBuilder(row)"
                        >Editar</app-button
                      >
                      <app-button size="sm" (click)="publish(row)">Publicar</app-button>
                    }
                    @if (canDesign() && row.status === 'PUBLISHED') {
                      <app-button size="sm" variant="secondary" (click)="duplicate(row)"
                        >Duplicar</app-button
                      >
                    }
                    @if (canExport() && row.status === 'PUBLISHED') {
                      <app-button size="sm" variant="secondary" (click)="requestExport(row)"
                        >Exportar CSV</app-button
                      >
                    }
                    @if (canDesign() && row.status === 'DRAFT') {
                      <app-button size="sm" variant="ghost" (click)="remove(row)"
                        >Apagar</app-button
                      >
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    <app-dialog
      [open]="building()"
      [wide]="true"
      [title]="editing() ? 'Editar relatório' : 'Novo relatório'"
      (closed)="building.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-4" data-testid="report-builder">
        <div class="grid gap-3 sm:grid-cols-2">
          <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
          @if (!editing()) {
            <app-input label="Código" [ngModel]="code()" (ngModelChange)="code.set($event ?? '')" />
          }
          <app-select
            label="Dataset"
            placeholder="Escolha o dataset"
            [options]="datasetOptions()"
            [ngModel]="datasetCode()"
            (ngModelChange)="chooseDataset($event ?? '')"
          />
          <app-select
            label="Visibilidade"
            [options]="visibilityOptions"
            [ngModel]="visibility()"
            (ngModelChange)="visibility.set($event ?? 'PRIVATE')"
          />
        </div>
        @if (dataset(); as ds) {
          <ul class="list-disc space-y-0.5 ps-5 text-xs text-fg-muted" data-testid="dataset-docs">
            @for (line of ds.documentation; track line) {
              <li>{{ line }}</li>
            }
          </ul>
          <fieldset>
            <legend class="mb-1 text-sm font-medium text-fg">Campos a mostrar</legend>
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              @for (f of ds.fields; track f.code) {
                <label class="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    [attr.data-testid]="'select-' + f.code"
                    [checked]="draft().select.includes(f.code)"
                    (change)="toggle('select', f.code)"
                  />
                  {{ f.label }}
                </label>
              }
            </div>
          </fieldset>
          <fieldset>
            <legend class="mb-1 text-sm font-medium text-fg">Agrupar por (opcional)</legend>
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              @for (f of ds.fields; track f.code) {
                <label class="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    [attr.data-testid]="'group-' + f.code"
                    [checked]="draft().groupBy.includes(f.code)"
                    (change)="toggle('groupBy', f.code)"
                  />
                  {{ f.label }}
                </label>
              }
            </div>
          </fieldset>
          <div>
            <div class="mb-1 flex items-center justify-between">
              <span class="text-sm font-medium text-fg">Medidas (opcional)</span>
              <app-button size="sm" variant="secondary" (click)="addMeasure()"
                >Acrescentar</app-button
              >
            </div>
            <ul class="space-y-2" data-testid="measures">
              @for (m of draft().measures; track $index; let i = $index) {
                <li class="grid items-end gap-2 sm:grid-cols-[9rem_1fr_9rem_auto]">
                  <app-select
                    label="Função"
                    [options]="measureOptions"
                    [ngModel]="m.fn"
                    (ngModelChange)="patchMeasure(i, { fn: ($event ?? 'count') + '' })"
                  />
                  <app-select
                    label="Campo"
                    placeholder="(todas as linhas)"
                    [options]="numericOptions()"
                    [ngModel]="m.field ?? ''"
                    (ngModelChange)="patchMeasure(i, { field: $event ?? '' })"
                  />
                  <app-input
                    label="Nome do resultado"
                    [ngModel]="m.alias"
                    (ngModelChange)="patchMeasure(i, { alias: $event ?? '' })"
                  />
                  <app-button size="sm" variant="ghost" (click)="removeMeasure(i)"
                    >Remover</app-button
                  >
                </li>
              }
            </ul>
          </div>
          <div>
            <span class="mb-1 block text-sm font-medium text-fg">Filtros</span>
            <ul class="mb-2 flex flex-wrap gap-2" data-testid="filters">
              @for (f of draft().filters; track $index; let i = $index) {
                <li class="flex items-center gap-1 rounded-full bg-surface-muted px-3 py-1 text-xs">
                  {{ describeFilter(f) }}
                  <button
                    type="button"
                    class="ms-1"
                    [attr.aria-label]="'Remover filtro ' + (i + 1)"
                    (click)="removeFilter(i)"
                  >
                    ×
                  </button>
                </li>
              }
            </ul>
            <div class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <app-select
                label="Campo do filtro"
                placeholder="Campo"
                [options]="fieldOptions()"
                [ngModel]="filterField()"
                (ngModelChange)="filterField.set($event ?? '')"
              />
              <app-select
                label="Operador"
                [options]="opOptions()"
                [ngModel]="filterOp()"
                (ngModelChange)="filterOp.set($event ?? 'eq')"
              />
              <app-input
                label="Valor"
                [ngModel]="filterValue()"
                (ngModelChange)="filterValue.set($event ?? '')"
              />
              @if (filterOp() === 'between') {
                <app-input
                  label="Até"
                  [ngModel]="filterValue2()"
                  (ngModelChange)="filterValue2.set($event ?? '')"
                />
              } @else {
                <span></span>
              }
              <app-button size="sm" variant="secondary" (click)="addFilter()"
                >Juntar filtro</app-button
              >
            </div>
          </div>
        }
        @if (previewResult(); as shown) {
          <div data-testid="preview">
            <app-result-table [result]="shown" />
          </div>
        }
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="building.set(false)">Cancelar</app-button>
        <app-button variant="secondary" [loading]="busy()" (click)="runPreview()"
          >Pré-visualizar</app-button
        >
        <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="running() !== null"
      [wide]="true"
      [title]="running()?.name ?? 'Relatório'"
      (closed)="running.set(null)"
    >
      @if (runError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      @if (runResult(); as shown) {
        <div data-testid="run-result">
          <app-result-table [result]="shown" />
        </div>
        <div class="mt-3 flex gap-2">
          <app-button size="sm" variant="secondary" [disabled]="offset() === 0" (click)="page(-1)"
            >Anterior</app-button
          >
          <app-button
            size="sm"
            variant="secondary"
            [disabled]="offset() + pageSize >= shown.total"
            (click)="page(1)"
            >Seguinte</app-button
          >
        </div>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="running.set(null)">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class ReportsTab {
  private readonly api = inject(ReportingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canDesign = computed(() => this.permissions.can('report.design'));
  protected readonly canExport = computed(() => this.permissions.can('report.export'));
  protected readonly measureOptions = MEASURE_OPTIONS;
  protected readonly visibilityOptions = VISIBILITY_OPTIONS;
  protected readonly pageSize = PAGE;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Relatório' },
    { key: 'dataset', label: 'Dataset' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly datasets = rxResource({
    params: () => {
      const t = this.tenantId();
      return t ? { tenantId: t.id } : undefined;
    },
    stream: () => this.api.datasets(),
  });
  protected readonly reports = rxResource({
    params: () => {
      const t = this.tenantId();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.reports(),
  });

  protected readonly datasetOptions = computed<readonly SelectOption[]>(() =>
    (this.datasets.hasValue() ? this.datasets.value() : []).map((d) => ({
      value: d.code,
      label: d.name,
    })),
  );

  // --- construtor
  protected readonly building = signal(false);
  protected readonly editing = signal<ReportDto | null>(null);
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly datasetCode = signal('');
  protected readonly visibility = signal<string>('PRIVATE');
  protected readonly draft = signal<Draft>(EMPTY);
  protected readonly filterField = signal('');
  protected readonly filterOp = signal<string>('eq');
  protected readonly filterValue = signal('');
  protected readonly filterValue2 = signal('');
  protected readonly previewResult = signal<RunResultDto | null>(null);

  protected readonly dataset = computed<DatasetDto | null>(
    () =>
      (this.datasets.hasValue() ? this.datasets.value() : []).find(
        (d) => d.code === this.datasetCode(),
      ) ?? null,
  );
  protected readonly fieldOptions = computed<readonly SelectOption[]>(() =>
    (this.dataset()?.fields ?? []).map((f) => ({ value: f.code, label: f.label })),
  );
  protected readonly numericOptions = computed<readonly SelectOption[]>(() =>
    (this.dataset()?.fields ?? [])
      .filter((f) => f.type === 'decimal' || f.type === 'integer' || f.type === 'date')
      .map((f) => ({ value: f.code, label: f.label })),
  );
  protected readonly opOptions = computed<readonly SelectOption[]>(() => {
    const field = this.dataset()?.fields.find((f) => f.code === this.filterField());
    return (field ? OPS_BY_TYPE[field.type] : (['eq'] as const)).map((op) => ({
      value: op,
      label: OP_LABEL[op],
    }));
  });

  // --- correr
  protected readonly running = signal<ReportDto | null>(null);
  protected readonly runResult = signal<RunResultDto | null>(null);
  protected readonly runError = signal<string | null>(null);
  protected readonly offset = signal(0);

  protected describe = (e: unknown) => reportingError(e, 'Pedido falhado.');
  protected datasetName = (code: string) =>
    (this.datasets.hasValue() ? this.datasets.value() : []).find((d) => d.code === code)?.name ??
    code;
  protected describeFilter = (f: FilterDto) => describeFilter(f, this.dataset()?.fields ?? []);

  protected openBuilder(report: ReportDto | null): void {
    this.notice.set(null);
    this.formError.set(null);
    this.previewResult.set(null);
    this.editing.set(report);
    this.name.set(report?.name ?? '');
    this.code.set(report?.code ?? '');
    this.datasetCode.set(report?.datasetCode ?? '');
    this.visibility.set(report?.visibility ?? 'PRIVATE');
    this.draft.set(
      report
        ? {
            select: report.query.select,
            groupBy: report.query.groupBy,
            measures: report.query.measures,
            filters: report.query.filters,
            sort: report.query.sort,
          }
        : EMPTY,
    );
    this.building.set(true);
  }

  protected chooseDataset(code: string): void {
    this.datasetCode.set(code);
    this.draft.set(EMPTY);
    this.previewResult.set(null);
  }

  protected toggle(list: 'select' | 'groupBy', field: string): void {
    this.draft.update((d) => ({
      ...d,
      [list]: d[list].includes(field) ? d[list].filter((x) => x !== field) : [...d[list], field],
    }));
  }

  protected addMeasure(): void {
    this.draft.update((d) => ({
      ...d,
      measures: [...d.measures, { fn: 'count', alias: `medida_${d.measures.length + 1}` }],
    }));
  }

  protected patchMeasure(
    index: number,
    patch: Partial<{ fn: string; field: string; alias: string }>,
  ): void {
    this.draft.update((d) => ({
      ...d,
      measures: d.measures.map((m, i): MeasureDto => {
        if (i !== index) return m;
        const { fn, field, ...rest } = patch;
        const next: MeasureDto = { ...m, ...rest, ...(fn ? { fn: fn as MeasureFn } : {}) };
        if (field === undefined) return next;
        const { field: _drop, ...withoutField } = next;
        void _drop;
        return field ? { ...withoutField, field } : withoutField;
      }),
    }));
  }

  protected removeMeasure(index: number): void {
    this.draft.update((d) => ({ ...d, measures: d.measures.filter((_, i) => i !== index) }));
  }

  protected addFilter(): void {
    const field = this.dataset()?.fields.find((f) => f.code === this.filterField());
    if (!field) {
      this.formError.set('Escolha o campo do filtro.');
      return;
    }
    const built = buildFilter(
      field,
      this.filterOp() as FilterOp,
      this.filterValue(),
      this.filterValue2(),
    );
    if ('error' in built) {
      this.formError.set(built.error);
      return;
    }
    this.formError.set(null);
    this.draft.update((d) => ({ ...d, filters: [...d.filters, built.filter] }));
    this.filterValue.set('');
    this.filterValue2.set('');
  }

  protected removeFilter(index: number): void {
    this.draft.update((d) => ({ ...d, filters: d.filters.filter((_, i) => i !== index) }));
  }

  private query(): Partial<QueryDto> {
    const d = this.draft();
    return {
      select: d.select,
      groupBy: d.groupBy,
      measures: d.measures,
      filters: d.filters,
      sort: d.sort,
    };
  }

  protected runPreview(): void {
    if (!this.datasetCode()) {
      this.formError.set('Escolha o dataset.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .preview({ datasetCode: this.datasetCode(), query: this.query() }, { limit: PAGE })
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          this.previewResult.set(r);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.previewResult.set(null);
          this.formError.set(reportingError(e, 'Não foi possível pré-visualizar.'));
        },
      });
  }

  protected save(): void {
    if (!this.name().trim() || !this.datasetCode()) {
      this.formError.set('Indique o nome e o dataset.');
      return;
    }
    const body = {
      name: this.name().trim(),
      datasetCode: this.datasetCode(),
      visibility: this.visibility() as Visibility,
      query: this.query(),
    };
    const current = this.editing();
    if (!current && !this.code().trim()) {
      this.formError.set('Indique o código.');
      return;
    }
    this.run(
      current
        ? this.api.updateReport(current.id, current.version, body)
        : this.api.createReport({ ...body, code: this.code().trim() }),
      'Relatório guardado como rascunho.',
      () => this.building.set(false),
    );
  }

  protected publish(report: ReportDto): void {
    this.run(
      this.api.publishReport(report.id),
      'Relatório publicado: passa a imutável.',
      () => undefined,
    );
  }

  protected duplicate(report: ReportDto): void {
    const code = `${report.code}_copia`.slice(0, 50);
    this.run(
      this.api.duplicateReport(report.id, code),
      `Cópia criada com o código ${code}.`,
      () => undefined,
    );
  }

  protected remove(report: ReportDto): void {
    this.run(this.api.deleteReport(report.id), 'Relatório apagado.', () => undefined);
  }

  protected requestExport(report: ReportDto): void {
    this.run(
      this.api.requestExport({ reportId: report.id }),
      'Exportação pedida: acompanhe-a no separador Exportações.',
      () => undefined,
    );
  }

  protected openRun(report: ReportDto): void {
    this.runError.set(null);
    this.runResult.set(null);
    this.offset.set(0);
    this.running.set(report);
    this.load();
  }

  protected page(direction: -1 | 1): void {
    this.offset.update((o) => Math.max(0, o + direction * PAGE));
    this.load();
  }

  private load(): void {
    const report = this.running();
    if (!report) return;
    this.api.run(report.id, { limit: PAGE, offset: this.offset() }).subscribe({
      next: (r) => this.runResult.set(r),
      error: (e: unknown) =>
        this.runError.set(reportingError(e, 'Não foi possível correr o relatório.')),
    });
  }

  private run(call: Observable<unknown>, message: string, after: () => void): void {
    this.actionError.set(null);
    this.formError.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set(message);
        this.tick.update((n) => n + 1);
        after();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        const text = reportingError(e, 'Não foi possível concluir a operação.');
        if (this.building()) this.formError.set(text);
        else this.actionError.set(text);
      },
    });
  }
}
