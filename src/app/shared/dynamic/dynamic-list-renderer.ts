import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { forkJoin, map } from 'rxjs';
import type { Page } from '../../core/api/pagination.model';
import { EntityRecordsGateway } from '../../core/dynamic/data-access/entity-records.gateway';
import { formatFieldValue } from '../../core/dynamic/engine/format-value';
import { statusOf } from '../../core/dynamic/engine/workflow';
import type { EntityDefinition } from '../../core/dynamic/models/entity-definition.model';
import type { EntityRecord, RecordQuery } from '../../core/dynamic/models/entity-record.model';
import { hasOptions } from '../../core/dynamic/models/field-definition.model';
import { Alert } from '../ui/alert/alert';
import { Badge } from '../ui/badge/badge';
import { Button } from '../ui/button/button';
import { Card } from '../ui/card/card';
import { EmptyState } from '../ui/empty-state/empty-state';
import { Icon } from '../ui/icon/icon';
import { LoadingState } from '../ui/loading-state/loading-state';
import { Pagination } from '../ui/pagination/pagination';
import { Table, type TableColumn, type TableSort } from '../ui/table/table';

const SYSTEM_LABELS: Record<string, string> = {
  status: 'Estado',
  createdAt: 'Criado em',
  updatedAt: 'Actualizado em',
};

const BOOLEAN_OPTIONS = [
  { value: 'true', label: 'Sim' },
  { value: 'false', label: 'Não' },
];

const SEARCH_DEBOUNCE_MS = 250;
const ACTIONS = 'actions';

/** "a, b e c" */
function joinList(items: readonly string[]): string {
  return items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

interface ReferenceTarget {
  readonly entityKey: string;
  readonly ids: readonly string[];
}

/**
 * Listagem genérica de uma entidade, definida pelos seus metadados: colunas, pesquisa, filtros,
 * ordenação e paginação. É apresentacional: recebe a página e a consulta actuais e emite a
 * consulta seguinte; quem carrega os dados decide o que fazer com ela.
 */
@Component({
  selector: 'app-dynamic-list',
  imports: [
    DatePipe,
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Icon,
    LoadingState,
    Pagination,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-card [flush]="true">
      @if (hasToolbar()) {
        <div class="flex flex-wrap items-end gap-3 border-b border-line p-4" role="search">
          @if (searchLabels().length > 0) {
            <div class="min-w-48 flex-1">
              <label for="dyn-search" class="sr-only"
                >Pesquisar {{ entity().names.plural.toLowerCase() }}</label
              >
              <div class="relative">
                <app-icon
                  name="search"
                  class="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
                />
                <input
                  id="dyn-search"
                  type="search"
                  class="block h-10 w-full rounded-lg border border-line bg-surface ps-9 pe-3 text-sm placeholder:text-fg-muted"
                  [placeholder]="'Pesquisar por ' + searchSummary()"
                  [value]="searchText()"
                  (input)="onSearch($any($event.target).value)"
                />
              </div>
            </div>
          }
          @for (filter of filters(); track filter.key) {
            <div>
              <label
                [for]="'dyn-filter-' + filter.key"
                class="mb-1 block text-xs font-medium text-fg-muted"
                >{{ filter.label }}</label
              >
              <select
                [id]="'dyn-filter-' + filter.key"
                class="block h-10 rounded-lg border border-line bg-surface px-3 text-sm"
                [value]="query().filters?.[filter.key] ?? ''"
                (change)="onFilter(filter.key, $any($event.target).value)"
              >
                <option value="">Todos</option>
                @for (option of filter.options; track option.value) {
                  <option
                    [value]="option.value"
                    [selected]="option.value === query().filters?.[filter.key]"
                  >
                    {{ option.label }}
                  </option>
                }
              </select>
            </div>
          }
          @if (isFiltered()) {
            <app-button variant="ghost" (click)="clear()">Limpar</app-button>
          }
        </div>
      }

      @if (loading() && !result()) {
        <app-loading-state [label]="'A carregar ' + entity().names.plural.toLowerCase() + '…'" />
      } @else if (error(); as message) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os registos">{{
            message
          }}</app-alert>
        </div>
      } @else if (result(); as page) {
        @if (page.total === 0) {
          @if (isFiltered()) {
            <app-empty-state
              icon="search"
              title="Sem resultados"
              description="Nenhum registo corresponde à pesquisa ou aos filtros."
            >
              <app-button variant="secondary" (click)="clear()"
                >Limpar pesquisa e filtros</app-button
              >
            </app-empty-state>
          } @else {
            <app-empty-state
              [icon]="entity().icon"
              [title]="'Ainda não há ' + entity().names.plural.toLowerCase()"
            >
              <ng-content select="[emptyAction]" />
            </app-empty-state>
          }
        } @else {
          <div [class.opacity-60]="loading()" [attr.aria-busy]="loading() || null">
            <app-table
              [caption]="'Lista de ' + entity().names.plural.toLowerCase()"
              [columns]="columns()"
              [rows]="page.items"
              [sort]="sort()"
              (sortChange)="onSort($event)"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('actions') {
                    <div class="flex justify-end gap-1">
                      @if (canView()(row)) {
                        <app-button
                          variant="ghost"
                          size="sm"
                          [label]="'Ver ' + describe(row)"
                          (click)="view.emit(row)"
                        >
                          <app-icon name="eye" class="size-4" />
                        </app-button>
                      }
                      @if (canEdit()(row)) {
                        <app-button
                          variant="ghost"
                          size="sm"
                          [label]="'Editar ' + describe(row)"
                          (click)="edit.emit(row)"
                        >
                          <app-icon name="pencil" class="size-4" />
                        </app-button>
                      }
                      @if (canDelete()(row)) {
                        <app-button
                          variant="ghost"
                          size="sm"
                          [label]="'Eliminar ' + describe(row)"
                          (click)="remove.emit(row)"
                        >
                          <app-icon name="trash" class="size-4" />
                        </app-button>
                      }
                    </div>
                  }
                  @case ('status') {
                    @if (statusOfRecord(row); as status) {
                      <app-badge [tone]="status.color">{{ status.name }}</app-badge>
                    } @else {
                      —
                    }
                  }
                  @case ('createdAt') {
                    {{ row.createdAt | date: 'short' }}
                  }
                  @case ('updatedAt') {
                    {{ row.updatedAt | date: 'short' }}
                  }
                  @default {
                    {{ cell(row, column.key) }}
                  }
                }
              </ng-template>
            </app-table>
          </div>
          <app-pagination
            class="border-t border-line"
            [page]="page.page"
            [pageSize]="page.pageSize"
            [total]="page.total"
            (pageChange)="onPage($event)"
          />
        }
      }
    </app-card>
  `,
})
export class DynamicListRenderer {
  private readonly gateway = inject(EntityRecordsGateway, { optional: true });

  readonly entity = input.required<EntityDefinition>();
  /** Página actual; `null` enquanto não houver resultados. */
  readonly result = input<Page<EntityRecord> | null>(null);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly query = input.required<RecordQuery>();
  readonly canView = input<(record: EntityRecord) => boolean>(() => false);
  readonly canEdit = input<(record: EntityRecord) => boolean>(() => false);
  readonly canDelete = input<(record: EntityRecord) => boolean>(() => false);

  readonly queryChange = output<RecordQuery>();
  readonly view = output<EntityRecord>();
  readonly edit = output<EntityRecord>();
  readonly remove = output<EntityRecord>();

  protected readonly searchText = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly fields = computed(() => new Map(this.entity().fields.map((f) => [f.key, f])));

  protected readonly columns = computed<readonly TableColumn[]>(() => {
    const columns: TableColumn[] = this.entity().list.columns.map((c) => {
      const field = this.fields().get(c.field);
      return {
        key: c.field,
        label: c.label ?? field?.label ?? SYSTEM_LABELS[c.field] ?? c.field,
        sortable: field ? field.sortable : true,
      };
    });
    const hasActions = !!this.result()?.items.some(
      (r) => this.canView()(r) || this.canEdit()(r) || this.canDelete()(r),
    );
    return hasActions ? [...columns, { key: ACTIONS, label: 'Acções', align: 'end' }] : columns;
  });

  protected readonly sort = computed(() => {
    const sort = this.query().sort;
    return sort ? { key: sort.key, direction: sort.direction } : undefined;
  });

  protected readonly searchLabels = computed(() =>
    this.entity().list.searchFields.map((k) => this.fields().get(k)?.label.toLowerCase() ?? k),
  );
  protected readonly searchSummary = computed(() => joinList(this.searchLabels()));

  protected readonly filters = computed(() =>
    this.entity().list.filters.flatMap((key) => {
      if (key === 'status') {
        const options = this.entity().statuses.map((s) => ({ value: s.code, label: s.name }));
        return [{ key, label: SYSTEM_LABELS['status'] ?? key, options }];
      }
      const field = this.fields().get(key);
      if (!field) return [];
      const options = hasOptions(field)
        ? field.options
        : field.type === 'boolean'
          ? BOOLEAN_OPTIONS
          : [];
      return [{ key, label: field.label, options }];
    }),
  );

  protected readonly hasToolbar = computed(
    () => this.searchLabels().length > 0 || this.filters().length > 0,
  );

  protected readonly isFiltered = computed(
    () => !!this.query().search || Object.keys(this.query().filters ?? {}).length > 0,
  );

  private readonly referenceTargets = computed(() => {
    const items = this.result()?.items ?? [];
    return this.entity().list.columns.flatMap((c) => {
      const field = this.fields().get(c.field);
      if (field?.type !== 'entity-reference') return [];
      const ids = [
        ...new Set(
          items
            .map((r) => r.data[c.field])
            .filter((v): v is string => typeof v === 'string' && v !== ''),
        ),
      ];
      return ids.length > 0 ? [{ entityKey: field.entityKey, ids } satisfies ReferenceTarget] : [];
    });
  });

  /** Uma chamada por entidade referenciada, com todos os ids da página (sem N+1). */
  private readonly referenceLabels = rxResource({
    params: () =>
      this.gateway && this.referenceTargets().length > 0 ? this.referenceTargets() : undefined,
    stream: ({ params }) =>
      forkJoin(
        params.map((t) =>
          this.gateway!.lookup(t.entityKey, { ids: t.ids }).pipe(
            map((options) => options.map((o) => [`${t.entityKey}:${o.id}`, o.label] as const)),
          ),
        ),
      ).pipe(map((groups) => new Map(groups.flat()))),
  });

  constructor() {
    // Mantém a caixa de pesquisa alinhada com a consulta quando esta muda por fora (ex.: "Limpar").
    effect(() => this.searchText.set(this.query().search ?? ''));
  }

  protected cell(record: EntityRecord, key: string): string {
    const field = this.fields().get(key);
    if (!field) return '—';
    const value = record.data[key];
    if (field.type === 'entity-reference' && typeof value === 'string' && value) {
      return this.referenceLabels.value()?.get(`${field.entityKey}:${value}`) ?? '…';
    }
    return formatFieldValue(field, value);
  }

  protected statusOfRecord(record: EntityRecord) {
    return statusOf(this.entity(), record.status);
  }

  /** Nome acessível de uma linha: "viatura AA-11-BB". */
  protected describe(record: EntityRecord): string {
    const first = this.entity().list.columns[0]?.field;
    return `${this.entity().names.singular.toLowerCase()} ${first ? this.cell(record, first) : record.id}`;
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(
      () => this.queryChange.emit({ ...this.query(), search: text.trim() || undefined, page: 1 }),
      SEARCH_DEBOUNCE_MS,
    );
  }

  protected onFilter(key: string, value: string): void {
    const rest = Object.fromEntries(
      Object.entries(this.query().filters ?? {}).filter(([k]) => k !== key),
    );
    this.queryChange.emit({
      ...this.query(),
      filters: value ? { ...rest, [key]: value } : rest,
      page: 1,
    });
  }

  protected onSort(sort: TableSort): void {
    this.queryChange.emit({
      ...this.query(),
      sort: { key: sort.key, direction: sort.direction },
      page: 1,
    });
  }

  protected onPage(page: number): void {
    this.queryChange.emit({ ...this.query(), page });
  }

  protected clear(): void {
    clearTimeout(this.searchTimer);
    this.queryChange.emit({ ...this.query(), search: undefined, filters: {}, page: 1 });
  }
}
