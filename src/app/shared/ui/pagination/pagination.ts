import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';

/** Paginação simples (anterior/seguinte). `page` começa em 1. */
@Component({
  selector: 'app-pagination',
  imports: [Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex items-center justify-between gap-4 px-4 py-3 text-sm text-fg-muted' },
  template: `
    <p aria-live="polite">
      @if (total() === 0) {
        Sem resultados
      } @else {
        {{ from() }}–{{ to() }} de {{ total() }}
      }
    </p>
    <nav aria-label="Paginação" class="flex items-center gap-1">
      <app-button
        variant="ghost"
        size="sm"
        label="Página anterior"
        [disabled]="page() <= 1"
        (click)="pageChange.emit(page() - 1)"
      >
        <app-icon name="chevron-left" class="size-4" />
      </app-button>
      <span class="px-2">Página {{ page() }} de {{ totalPages() }}</span>
      <app-button
        variant="ghost"
        size="sm"
        label="Página seguinte"
        [disabled]="page() >= totalPages()"
        (click)="pageChange.emit(page() + 1)"
      >
        <app-icon name="chevron-right" class="size-4" />
      </app-button>
    </nav>
  `,
})
export class Pagination {
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly total = input.required<number>();
  readonly pageChange = output<number>();

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize())),
  );
  protected readonly from = computed(() => (this.page() - 1) * this.pageSize() + 1);
  protected readonly to = computed(() => Math.min(this.page() * this.pageSize(), this.total()));
}
