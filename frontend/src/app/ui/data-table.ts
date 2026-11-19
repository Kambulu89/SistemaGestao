import {
  Component,
  Directive,
  TemplateRef,
  computed,
  contentChildren,
  effect,
  signal,
  untracked,
  inject,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { ApiError } from '../core/api';
import { ErrorState } from './states';
import { Icon } from './icon';
import { Pager } from './pager';
import { Dropdown } from './dropdown';

export interface Column<T = Record<string, unknown>> {
  key: string;
  label: string;
  /** Só colunas que o servidor sabe ordenar. */
  sortable?: boolean;
  /** Texto da célula (por omissão `row[key]`). */
  value?: (row: T) => unknown;
  /** Liga a célula ao detalhe (sem ligação nas linhas em que devolve `null`). */
  link?: (row: T) => string | unknown[] | null;
  align?: 'start' | 'end';
  /** Esconde a coluna em ecrãs pequenos. */
  hideOnMobile?: boolean;
  /** Não pode ser escondida na configuração de colunas (ex.: a coluna que liga ao detalhe). */
  required?: boolean;
  /** Escondida por omissão (o utilizador pode mostrá-la). */
  hiddenByDefault?: boolean;
}

/** Colunas visíveis: as obrigatórias sempre; as outras segundo a escolha guardada ou a predefinição. */
export function visibleColumns<T>(columns: Column<T>[], hidden: ReadonlySet<string> | null) {
  return columns.filter((c) =>
    c.required ? true : hidden ? !hidden.has(c.key) : !c.hiddenByDefault,
  );
}

const COLUMNS_KEY = (id: string) => `sg.columns.${id}`;

function readHidden(id: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY(id));
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(value) ? new Set(value.filter((v) => typeof v === 'string')) : null;
  } catch {
    return null;
  }
}

function writeHidden(id: string, hidden: Set<string> | null) {
  try {
    if (hidden) localStorage.setItem(COLUMNS_KEY(id), JSON.stringify([...hidden]));
    else localStorage.removeItem(COLUMNS_KEY(id));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

export interface Sort {
  field: string;
  direction: 'asc' | 'desc';
}

/** Conteúdo personalizado de uma coluna: `<ng-template appCell="status" let-row>…</ng-template>`. */
@Directive({ selector: 'ng-template[appCell]' })
export class CellDef {
  readonly appCell = input.required<string>();
  readonly template = inject(TemplateRef);
}

/**
 * Tabela de listagem com ordenação e paginação no servidor, estados de carregamento (esqueleto), vazio e erro com
 * repetição, e exportação (a página decide o que exporta, sempre pela API e com as permissões do utilizador).
 */
@Component({
  selector: 'app-data-table',
  imports: [NgTemplateOutlet, RouterLink, ErrorState, Icon, Pager, Dropdown],
  template: `
    @if (error()) {
      <app-error-state [error]="error()" (retry)="retry.emit()" />
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" [attr.aria-label]="label()" [attr.aria-busy]="loading()">
          <caption class="sr-only">
            {{
              label()
            }}{{
              total() ? ', ' + total() + ' registos' : ''
            }}
          </caption>
          <thead>
            <tr>
              @for (c of shown(); track c.key) {
                <th
                  scope="col"
                  [attr.aria-sort]="ariaSort(c)"
                  [class.text-right]="c.align === 'end'"
                  [class.hidden]="c.hideOnMobile"
                  [class.md:table-cell]="c.hideOnMobile"
                >
                  @if (c.sortable) {
                    <button
                      type="button"
                      class="focus-ring inline-flex items-center gap-1 rounded hover:text-fg"
                      (click)="toggleSort(c)"
                    >
                      {{ c.label }}
                      <app-icon [name]="sortIcon(c)" [size]="14" />
                    </button>
                  } @else {
                    {{ c.label }}
                  }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @if (loading() && rows().length === 0) {
              @for (i of skeletonRows; track i) {
                <tr>
                  @for (c of shown(); track c.key) {
                    <td [class.hidden]="c.hideOnMobile" [class.md:table-cell]="c.hideOnMobile">
                      <span class="skeleton block h-4 w-3/4"></span>
                    </td>
                  }
                </tr>
              }
            } @else if (rows().length === 0) {
              <tr>
                <td [attr.colspan]="shown().length" class="py-8 text-center text-muted">
                  {{ emptyText() }}
                </td>
              </tr>
            } @else {
              @for (row of rows(); track trackBy()(row)) {
                <tr class="hover:bg-surface-2" [class.opacity-60]="loading()">
                  @for (c of shown(); track c.key; let first = $first) {
                    <td
                      [class.text-right]="c.align === 'end'"
                      [class.hidden]="c.hideOnMobile"
                      [class.md:table-cell]="c.hideOnMobile"
                    >
                      @if (cellTemplate(c.key); as tpl) {
                        <ng-container *ngTemplateOutlet="tpl; context: { $implicit: row }" />
                      } @else if (c.link && c.link(row)) {
                        <a class="btn-link" [routerLink]="$any(c.link(row))">{{
                          display(c, row)
                        }}</a>
                      } @else {
                        {{ display(c, row) }}
                      }
                    </td>
                  }
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-muted" aria-live="polite">
          {{ loading() ? 'A carregar…' : total() + ' registo(s)' }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          @if (tableId()) {
            <app-dropdown
              label="Configurar colunas"
              align="end"
              buttonClass="btn-secondary"
              [closeOnSelect]="false"
            >
              <span trigger class="inline-flex items-center gap-1"
                ><app-icon name="layers" [size]="16" /> Colunas</span
              >
              <div class="px-2 py-1 text-xs font-semibold text-muted uppercase">
                Colunas visíveis
              </div>
              @for (c of columns(); track c.key) {
                <label
                  class="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
                  data-menu-item
                  tabindex="-1"
                >
                  <input
                    type="checkbox"
                    class="size-4"
                    [checked]="isShown(c)"
                    [disabled]="c.required"
                    (change)="toggleColumn(c, $any($event.target).checked)"
                  />
                  {{ c.label }}
                </label>
              }
              <button
                type="button"
                class="btn-link w-full px-2 py-1.5 text-left text-sm"
                (click)="resetColumns()"
              >
                Repor colunas
              </button>
            </app-dropdown>
          }
          @if (exportable()) {
            <button
              type="button"
              class="btn-secondary"
              [disabled]="exporting() || total() === 0"
              (click)="export.emit(shown())"
            >
              <app-icon name="download" [size]="16" />
              {{ exporting() ? 'A exportar…' : 'Exportar CSV' }}
            </button>
          }
        </div>
      </div>
      <app-pager
        [total]="total()"
        [limit]="limit()"
        [offset]="offset()"
        (offsetChange)="offsetChange.emit($event)"
      />
    }
  `,
})
export class DataTable<T extends object = Record<string, unknown>> {
  readonly label = input.required<string>();
  readonly columns = input.required<Column<T>[]>();
  readonly rows = input<T[]>([]);
  readonly total = input(0);
  readonly loading = input(false);
  readonly error = input<ApiError | null>(null);
  readonly sort = input<Sort | null>(null);
  readonly offset = input(0);
  readonly limit = input(25);
  readonly emptyText = input('Sem registos.');
  readonly exportable = input(false);
  readonly exporting = input(false);
  /** Identificador estável da tabela: activa a configuração de colunas (guardada neste browser). */
  readonly tableId = input<string | null>(null);
  readonly trackBy = input<(row: T) => unknown>((row: T) => (row as { id?: unknown }).id ?? row);
  readonly sortChange = output<Sort>();
  readonly offsetChange = output<number>();
  readonly retry = output();
  /** Pede a exportação com as colunas visíveis. */
  readonly export = output<Column<T>[]>();
  private readonly cells = contentChildren(CellDef);
  private readonly templates = computed(
    () => new Map(this.cells().map((c) => [c.appCell(), c.template])),
  );
  protected readonly skeletonRows = [1, 2, 3, 4, 5];
  private readonly hidden = signal<Set<string> | null>(null);
  /** Colunas mostradas e exportadas. */
  readonly shown = computed(() => visibleColumns(this.columns(), this.hidden()));

  constructor() {
    effect(() => {
      const id = this.tableId();
      untracked(() => this.hidden.set(id ? readHidden(id) : null));
    });
  }

  protected isShown(c: Column<T>) {
    return this.shown().some((x) => x.key === c.key);
  }

  protected toggleColumn(c: Column<T>, show: boolean) {
    const hidden = new Set(
      this.columns()
        .filter((x) => !this.isShown(x))
        .map((x) => x.key),
    );
    if (show) hidden.delete(c.key);
    else hidden.add(c.key);
    this.hidden.set(hidden);
    const id = this.tableId();
    if (id) writeHidden(id, hidden);
  }

  protected resetColumns() {
    this.hidden.set(null);
    const id = this.tableId();
    if (id) writeHidden(id, null);
  }

  protected cellTemplate(key: string) {
    return this.templates().get(key) ?? null;
  }

  protected display(c: Column<T>, row: T) {
    const value = c.value ? c.value(row) : (row as Record<string, unknown>)[c.key];
    return value === null || value === undefined || value === '' ? '—' : value;
  }

  protected ariaSort(c: Column<T>) {
    const s = this.sort();
    if (!c.sortable) return null;
    if (s?.field !== c.key) return 'none';
    return s.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected sortIcon(c: Column<T>) {
    const s = this.sort();
    if (s?.field !== c.key) return 'sort';
    return s.direction === 'asc' ? 'sortUp' : 'sortDown';
  }

  protected toggleSort(c: Column<T>) {
    const s = this.sort();
    this.sortChange.emit({
      field: c.key,
      direction: s?.field === c.key && s.direction === 'asc' ? 'desc' : 'asc',
    });
  }
}
