import { Component, computed, input, output } from '@angular/core';

/** Paginação simples por offset. */
@Component({
  selector: 'app-pager',
  template: `
    @if (total() > limit()) {
      <nav
        class="mt-3 flex items-center justify-between text-sm text-slate-600"
        aria-label="Paginação"
      >
        <span>{{ from() }}–{{ to() }} de {{ total() }}</span>
        <span class="flex gap-2">
          <button type="button" class="btn-secondary" [disabled]="offset() === 0" (click)="go(-1)">
            Anterior
          </button>
          <button type="button" class="btn-secondary" [disabled]="to() >= total()" (click)="go(1)">
            Seguinte
          </button>
        </span>
      </nav>
    }
  `,
})
export class Pager {
  readonly total = input(0);
  readonly limit = input(25);
  readonly offset = input(0);
  readonly offsetChange = output<number>();
  protected readonly from = computed(() => (this.total() === 0 ? 0 : this.offset() + 1));
  protected readonly to = computed(() => Math.min(this.offset() + this.limit(), this.total()));

  protected go(direction: number) {
    this.offsetChange.emit(Math.max(0, this.offset() + direction * this.limit()));
  }
}
