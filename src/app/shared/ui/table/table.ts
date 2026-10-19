import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  contentChild,
  input,
  output,
  TemplateRef,
} from '@angular/core';
import { Icon } from '../icon/icon';

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  readonly sortable?: boolean;
  readonly align?: 'start' | 'end';
}

export interface TableSort {
  readonly key: string;
  readonly direction: 'asc' | 'desc';
}

export interface TableCellContext<T> {
  $implicit: T;
  column: TableColumn;
}

/**
 * Tabela presentacional. Sem `<ng-template let-row let-column="column">` projectado,
 * mostra `row[column.key]`; com ele, o consumidor decide o conteúdo de cada célula.
 * Ordenação e paginação são controladas pelo consumidor (ver `sort` / `sortChange`).
 */
@Component({
  selector: 'app-table',
  imports: [NgTemplateOutlet, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block overflow-x-auto' },
  template: `
    <table class="w-full text-sm">
      <caption class="sr-only">
        {{
          caption()
        }}
      </caption>
      <thead class="border-b border-line bg-surface-muted text-fg-muted">
        <tr>
          @for (column of columns(); track column.key) {
            <th
              scope="col"
              class="px-4 py-3 font-medium"
              [class.text-start]="column.align !== 'end'"
              [class.text-end]="column.align === 'end'"
              [attr.aria-sort]="ariaSort(column)"
            >
              @if (column.sortable) {
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded hover:text-fg"
                  (click)="toggleSort(column)"
                >
                  {{ column.label }}
                  @if (sort()?.key === column.key) {
                    <app-icon
                      name="arrow-up"
                      class="size-3.5"
                      [class.rotate-180]="sort()?.direction === 'desc'"
                    />
                  }
                </button>
              } @else {
                {{ column.label }}
              }
            </th>
          }
        </tr>
      </thead>
      <tbody class="divide-y divide-line">
        @for (row of rows(); track $index) {
          <tr class="hover:bg-surface-muted/60">
            @for (column of columns(); track column.key) {
              <td class="px-4 py-3" [class.text-end]="column.align === 'end'">
                @if (cell(); as cell) {
                  <ng-container
                    [ngTemplateOutlet]="cell"
                    [ngTemplateOutletContext]="{ $implicit: row, column: column }"
                  />
                } @else {
                  {{ valueOf(row, column) }}
                }
              </td>
            }
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class Table<T extends object> {
  readonly caption = input.required<string>();
  readonly columns = input.required<readonly TableColumn[]>();
  readonly rows = input.required<readonly T[]>();
  readonly sort = input<TableSort | undefined>();
  readonly sortChange = output<TableSort>();

  protected readonly cell = contentChild<TemplateRef<TableCellContext<T>>>(TemplateRef);

  protected valueOf(row: T, column: TableColumn): string {
    return String((row as Record<string, unknown>)[column.key] ?? '');
  }

  protected ariaSort(column: TableColumn): string | null {
    const sort = this.sort();
    if (!column.sortable) return null;
    if (sort?.key !== column.key) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected toggleSort(column: TableColumn): void {
    const current = this.sort();
    const direction = current?.key === column.key && current.direction === 'asc' ? 'desc' : 'asc';
    this.sortChange.emit({ key: column.key, direction });
  }
}
