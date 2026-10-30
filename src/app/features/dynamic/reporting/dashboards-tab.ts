import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
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
import { Chart } from './chart';
import {
  ReportingApi,
  type DashboardDataDto,
  type DashboardDto,
  type FieldType,
  type FilterDto,
  type WidgetDataDto,
  type WidgetType,
} from './reporting.api';
import {
  buildFilter,
  chartPoints,
  errorTextOf,
  formatCell,
  reportingError,
  WIDGET_LABEL,
} from './reporting-model';
import { ResultTable } from './result-table';

const WIDGET_OPTIONS: readonly SelectOption[] = (Object.keys(WIDGET_LABEL) as WidgetType[]).map(
  (value) => ({ value, label: WIDGET_LABEL[value] }),
);
const VISIBILITY_OPTIONS: readonly SelectOption[] = [
  { value: 'PRIVATE', label: 'Privado (só eu)' },
  { value: 'TENANT', label: 'Toda a organização' },
];

/**
 * Painéis: cada widget corre um relatório publicado com a autorização de quem vê. Um widget que falha ou que a pessoa
 * não pode ver mostra o seu erro sem derrubar os restantes; os filtros globais só se aplicam aos widgets que têm o campo.
 */
@Component({
  selector: 'app-dashboards-tab',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Chart,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    ResultTable,
    Select,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="w-64">
        <app-select
          label="Painel"
          [options]="dashboardOptions()"
          [ngModel]="selectedId()"
          (ngModelChange)="select($event)"
        />
      </div>
      <div class="ml-auto flex gap-2">
        @if (canDesign()) {
          <app-button variant="secondary" (click)="openCreate()">Novo painel</app-button>
          @if (current(); as dash) {
            <app-button variant="secondary" (click)="openWidget()">Adicionar widget</app-button>
            <app-button variant="ghost" (click)="removeDashboard(dash)">Apagar painel</app-button>
          }
        }
        <app-button variant="secondary" (click)="refresh()">Actualizar</app-button>
      </div>
    </div>
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (dashboards.isLoading() && !dashboards.hasValue()) {
      <app-loading-state label="A carregar painéis…" />
    } @else if (dashboards.error()) {
      <app-alert tone="danger" title="Não foi possível carregar os painéis">{{
        describe(dashboards.error())
      }}</app-alert>
    } @else if (!current()) {
      <app-empty-state icon="chart" title="Sem painéis" />
    } @else {
      <div class="mb-3 flex flex-wrap items-end gap-2" data-testid="global-filters">
        <div class="w-48">
          <app-select
            label="Filtrar por campo"
            [options]="filterFieldOptions()"
            [ngModel]="filterField()"
            (ngModelChange)="filterField.set($event ?? '')"
          />
        </div>
        <div class="w-48">
          <app-input
            label="Igual a"
            [ngModel]="filterValue()"
            (ngModelChange)="filterValue.set($event ?? '')"
          />
        </div>
        <app-button size="sm" variant="secondary" (click)="addFilter()">Aplicar filtro</app-button>
        @for (f of globalFilters(); track $index) {
          <app-badge tone="brand"
            >{{ f.field }} = {{ f.value }}
            <button
              type="button"
              class="ml-1"
              (click)="removeFilter($index)"
              aria-label="Remover filtro"
            >
              ×
            </button>
          </app-badge>
        }
      </div>
      @if (data.isLoading() && !data.hasValue()) {
        <app-loading-state label="A calcular os widgets…" />
      } @else if (data.error()) {
        <app-alert tone="danger">{{ describe(data.error()) }}</app-alert>
      } @else if (data.hasValue() && data.value(); as shown) {
        @if (shown.widgets.length === 0) {
          <app-empty-state icon="chart" title="Painel sem widgets" />
        } @else {
          <div class="grid gap-4 md:grid-cols-2" data-testid="widgets">
            @for (w of shown.widgets; track w.widgetId) {
              <app-card [title]="w.title">
                <div [attr.data-testid]="'widget-' + w.type">
                  @if (w.error; as err) {
                    <app-alert tone="warning" data-testid="widget-error">{{
                      text(err.code, err.message)
                    }}</app-alert>
                  } @else if (w.result; as result) {
                    @switch (w.type) {
                      @case ('KPI') {
                        <p class="text-3xl font-semibold" data-testid="kpi">{{ kpi(w) }}</p>
                      }
                      @case ('TABLE') {
                        <app-result-table [result]="result" />
                      }
                      @default {
                        <app-chart
                          [kind]="chartKind(w.type)"
                          [points]="points(w)"
                          [label]="w.title"
                        />
                      }
                    }
                    @if (w.ignoredFilters.length > 0) {
                      <p class="mt-2 text-xs text-fg-muted" data-testid="ignored">
                        {{ w.ignoredFilters.length }} filtro(s) não se aplicam a este widget.
                      </p>
                    }
                    <p class="mt-2 flex items-center gap-2 text-xs text-fg-muted">
                      Dados às {{ result.asOf.slice(11, 19) }} (UTC)
                      <button type="button" class="underline" (click)="drill(w)">
                        Ver detalhe
                      </button>
                      @if (canDesign()) {
                        <button type="button" class="underline" (click)="removeWidget(w)">
                          Remover
                        </button>
                      }
                    </p>
                  }
                </div>
              </app-card>
            }
          </div>
          <p class="mt-3 text-xs text-fg-muted" data-testid="as-of">
            Dados lidos em tempo real às {{ shown.asOf.slice(11, 19) }} (UTC).
          </p>
        }
      }
    }

    <app-dialog [open]="creating()" title="Novo painel" (closed)="creating.set(false)">
      <div class="space-y-3">
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <app-select
          label="Visibilidade"
          [options]="visibilityOptions"
          [ngModel]="visibility()"
          (ngModelChange)="visibility.set($event ?? 'PRIVATE')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="createDashboard()">Criar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog [open]="addingWidget()" title="Adicionar widget" (closed)="addingWidget.set(false)">
      <div class="space-y-3" data-testid="widget-form">
        <app-input label="Título" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <app-select
          label="Relatório publicado"
          [options]="reportOptions()"
          [ngModel]="reportId()"
          (ngModelChange)="reportId.set($event ?? '')"
        />
        <app-select
          label="Tipo"
          [options]="widgetOptions"
          [ngModel]="widgetType()"
          (ngModelChange)="widgetType.set($event ?? 'KPI')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="addingWidget.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="addWidget()">Adicionar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="drilling() !== null"
      [wide]="true"
      [title]="drilling()?.title ?? 'Detalhe'"
      (closed)="drilling.set(null)"
    >
      @if (drillError(); as err) {
        <app-alert tone="danger" class="mb-3 block">{{ err }}</app-alert>
      }
      @if (drillResult(); as shown) {
        <app-result-table [result]="shown" />
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="drilling.set(null)">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class DashboardsTab {
  private readonly api = inject(ReportingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;
  private readonly destroyRef = inject(DestroyRef);

  protected readonly canDesign = computed(() => this.permissions.can('report.design'));
  protected readonly visibilityOptions = VISIBILITY_OPTIONS;
  protected readonly widgetOptions = WIDGET_OPTIONS;

  private readonly tick = signal(0);
  protected readonly selectedId = signal<string>('');
  protected readonly globalFilters = signal<readonly FilterDto[]>([]);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly dashboards = rxResource({
    params: () => {
      const t = this.tenantId();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.dashboards(),
  });
  protected readonly reports = rxResource({
    params: () => {
      const t = this.tenantId();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.reports(),
  });

  protected readonly list = computed<readonly DashboardDto[]>(() =>
    this.dashboards.hasValue() ? this.dashboards.value() : [],
  );
  protected readonly current = computed<DashboardDto | null>(
    () => this.list().find((d) => d.id === this.selectedId()) ?? this.list()[0] ?? null,
  );
  protected readonly dashboardOptions = computed<readonly SelectOption[]>(() =>
    this.list().map((d) => ({ value: d.id, label: d.name })),
  );
  protected readonly reportOptions = computed<readonly SelectOption[]>(() =>
    (this.reports.hasValue() ? this.reports.value() : [])
      .filter((r) => r.status === 'PUBLISHED')
      .map((r) => ({ value: r.id, label: r.name })),
  );

  protected readonly data = rxResource<
    DashboardDataDto,
    { id: string; filters: readonly FilterDto[]; tick: number } | undefined
  >({
    params: () => {
      const d = this.current();
      return d ? { id: d.id, filters: this.globalFilters(), tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.dashboardData(params.id, params.filters),
  });

  // Os campos filtráveis são os dos widgets já carregados (as colunas dos resultados).
  protected readonly filterFieldOptions = computed<readonly SelectOption[]>(() => {
    const seen = new Map<string, string>();
    const shown = this.data.hasValue() ? this.data.value() : null;
    for (const w of shown?.widgets ?? [])
      for (const c of w.result?.columns ?? []) seen.set(c.code, c.label);
    return [...seen].map(([value, label]) => ({ value, label }));
  });
  protected readonly filterField = signal('');
  protected readonly filterValue = signal('');

  protected readonly creating = signal(false);
  protected readonly addingWidget = signal(false);
  protected readonly name = signal('');
  protected readonly visibility = signal<string>('PRIVATE');
  protected readonly reportId = signal('');
  protected readonly widgetType = signal<string>('KPI');

  protected readonly drilling = signal<WidgetDataDto | null>(null);
  protected readonly drillResult = signal<DashboardDataDto['widgets'][number]['result']>(null);
  protected readonly drillError = signal<string | null>(null);

  constructor() {
    // Actualização automática: o menor intervalo pedido pelos widgets visíveis (nunca abaixo de 30 s).
    effect((onCleanup) => {
      const shown = this.data.hasValue() ? this.data.value() : null;
      const seconds = Math.min(
        ...(shown?.widgets.map((w) => w.refreshSeconds) ?? [0]).filter((s) => s > 0),
      );
      if (!Number.isFinite(seconds)) return;
      const handle = setInterval(() => this.refresh(), Math.max(seconds, 30) * 1000);
      onCleanup(() => clearInterval(handle));
    });
    this.destroyRef.onDestroy(() => this.tick.set(-1));
  }

  protected describe = (e: unknown) => reportingError(e, 'Pedido falhado.');
  protected text = errorTextOf;

  protected select(id: string | null): void {
    this.selectedId.set(id ?? '');
    this.globalFilters.set([]);
  }

  protected refresh(): void {
    this.tick.update((t) => t + 1);
  }

  protected chartKind(type: WidgetType): 'BAR' | 'LINE' | 'PIE' {
    return type === 'LINE' || type === 'PIE' ? type : 'BAR';
  }

  protected points(w: WidgetDataDto) {
    return w.result ? chartPoints(w.result) : [];
  }

  /** O primeiro valor da primeira linha, tal como veio do servidor (decimais exactos). */
  protected kpi(w: WidgetDataDto): string {
    const result = w.result;
    const column = result?.columns[0];
    if (!result || !column) return '—';
    return formatCell(result.rows[0]?.[column.code], column.type);
  }

  protected addFilter(): void {
    const field = this.filterField();
    if (!field || this.filterValue().trim() === '') return;
    const shown = this.data.hasValue() ? this.data.value() : null;
    const type =
      shown?.widgets.flatMap((w) => w.result?.columns ?? []).find((c) => c.code === field)?.type ??
      'string';
    const built = buildFilter(
      { code: field, label: field, type: type === 'measure' ? 'decimal' : (type as FieldType) },
      'eq',
      this.filterValue(),
    );
    if ('error' in built) {
      this.actionError.set(built.error);
      return;
    }
    this.actionError.set(null);
    this.globalFilters.update((l) => [...l, built.filter]);
    this.filterValue.set('');
  }

  protected removeFilter(index: number): void {
    this.globalFilters.update((l) => l.filter((_, i) => i !== index));
  }

  protected openCreate(): void {
    this.actionError.set(null);
    this.name.set('');
    this.visibility.set('PRIVATE');
    this.creating.set(true);
  }

  protected openWidget(): void {
    this.actionError.set(null);
    this.name.set('');
    this.reportId.set('');
    this.widgetType.set('KPI');
    this.addingWidget.set(true);
  }

  protected createDashboard(): void {
    this.act(
      this.api.createDashboard({
        name: this.name(),
        visibility: this.visibility() as 'PRIVATE' | 'TENANT',
      }),
      (created) => {
        this.creating.set(false);
        this.selectedId.set(created.id);
      },
    );
  }

  protected addWidget(): void {
    const dash = this.current();
    if (!dash) return;
    this.act(
      this.api.addWidget(dash.id, {
        title: this.name(),
        type: this.widgetType() as WidgetType,
        reportId: this.reportId(),
      }),
      () => this.addingWidget.set(false),
    );
  }

  protected removeWidget(w: WidgetDataDto): void {
    const dash = this.current();
    if (dash) this.act(this.api.removeWidget(dash.id, w.widgetId), () => undefined);
  }

  protected removeDashboard(dash: DashboardDto): void {
    this.act(this.api.deleteDashboard(dash.id), () => this.selectedId.set(''));
  }

  protected drill(w: WidgetDataDto): void {
    this.drilling.set(w);
    this.drillResult.set(null);
    this.drillError.set(null);
    this.api.run(w.drill.reportId, { filters: w.drill.filters, limit: 20 }).subscribe({
      next: (result) => this.drillResult.set(result),
      error: (e: unknown) => this.drillError.set(this.describe(e)),
    });
  }

  private act<T>(call: Observable<T>, done: (value: T) => void): void {
    this.busy.set(true);
    this.actionError.set(null);
    call.subscribe({
      next: (value) => {
        this.busy.set(false);
        done(value);
        this.refresh();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(this.describe(e));
      },
    });
  }
}
