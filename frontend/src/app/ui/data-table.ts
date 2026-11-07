import {
  Component,
  Directive,
  TemplateRef,
  computed,
  contentChildren,
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

export interface Column<T = Record<string, unknown>> {
  key: string;
  label: string;
  /** Só colunas que o servidor sabe ordenar. */
  sortable?: boolean;
  /** Texto da célula (por omissão `row[key]`). */
  value?: (row: T) => unknown;
  /** Liga a célula ao detalhe. */
  link?: (row: T) => string | unknown[];
  align?: 'start' | 'end';
  /** Esconde a coluna em ecrãs pequenos. */
  hideOnMobile?: boolean;
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
  imports: [NgTemplateOutlet, RouterLink, ErrorState, Icon, Pager],
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
              @for (c of columns(); track c.key) {
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
                  @for (c of columns(); track c.key) {
                    <td [class.hidden]="c.hideOnMobile" [class.md:table-cell]="c.hideOnMobile">
                      <span class="skeleton block h-4 w-3/4"></span>
                    </td>
                  }
                </tr>
              }
            } @else if (rows().length === 0) {
              <tr>
                <td [attr.colspan]="columns().length" class="py-8 text-center text-muted">
                  {{ emptyText() }}
                </td>
              </tr>
            } @else {
              @for (row of rows(); track trackBy()(row)) {
                <tr class="hover:bg-surface-2" [class.opacity-60]="loading()">
                  @for (c of columns(); track c.key; let first = $first) {
                    <td
                      [class.text-right]="c.align === 'end'"
                      [class.hidden]="c.hideOnMobile"
                      [class.md:table-cell]="c.hideOnMobile"
                    >
                      @if (cellTemplate(c.key); as tpl) {
                        <ng-container *ngTemplateOutlet="tpl; context: { $implicit: row }" />
                      } @else if (c.link) {
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
        @if (exportable()) {
          <button
            type="button"
            class="btn-secondary"
            [disabled]="exporting() || total() === 0"
            (click)="export.emit()"
          >
            <app-icon name="download" [size]="16" />
            {{ exporting() ? 'A exportar…' : 'Exportar CSV' }}
          </button>
        }
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
  readonly trackBy = input<(row: T) => unknown>((row: T) => (row as { id?: unknown }).id ?? row);
  readonly sortChange = output<Sort>();
  readonly offsetChange = output<number>();
  readonly retry = output();
  readonly export = output();
  private readonly cells = contentChildren(CellDef);
  private readonly templates = computed(
    () => new Map(this.cells().map((c) => [c.appCell(), c.template])),
  );
  protected readonly skeletonRows = [1, 2, 3, 4, 5];

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
