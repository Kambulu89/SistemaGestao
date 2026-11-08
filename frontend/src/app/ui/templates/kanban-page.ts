import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  Directive,
  TemplateRef,
  contentChild,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

export interface KanbanColumn<T> {
  id: string;
  label: string;
  items: T[];
}

export interface KanbanMove<T> {
  item: T;
  from: string;
  to: string;
}

/** Conteúdo de um cartão: `<ng-template appKanbanCard let-item>…</ng-template>`. */
@Directive({ selector: 'ng-template[appKanbanCard]' })
export class KanbanCard {
  readonly template = inject(TemplateRef);
}

/**
 * KanbanPage / quadro: colunas com cartões; mover por arrastar ou pelos botões do cartão (teclado e leitores de ecrã).
 * O quadro só pede a mudança (`move`): o ecrã chama a API e recarrega; se a API recusar, o cartão fica onde estava.
 */
@Component({
  selector: 'app-kanban',
  imports: [NgTemplateOutlet],
  template: `
    <div
      class="grid gap-3"
      [style.grid-template-columns]="'repeat(' + columns().length + ', minmax(14rem, 1fr))'"
      [class.overflow-x-auto]="true"
      role="list"
      [attr.aria-label]="label()"
    >
      @for (col of columns(); track col.id) {
        <section
          role="listitem"
          class="flex min-h-32 flex-col rounded-card border border-border bg-surface-2 p-2"
          [class.border-primary]="over() === col.id"
          [attr.aria-labelledby]="'kb-' + col.id"
          [attr.data-column]="col.id"
          (dragover)="onDragOver($event, col.id)"
          (dragleave)="over.set(null)"
          (drop)="onDrop($event, col.id)"
        >
          <h3
            [id]="'kb-' + col.id"
            class="mb-2 flex items-center justify-between px-1 text-sm font-semibold"
          >
            {{ col.label }}
            <span class="badge bg-surface text-muted">{{ col.items.length }}</span>
          </h3>
          <ul class="flex-1 space-y-2">
            @for (item of col.items; track trackBy()(item)) {
              <li
                class="card p-3"
                [attr.draggable]="!disabled()"
                (dragstart)="onDragStart($event, item, col.id)"
                data-testid="kanban-card"
              >
                @if (card(); as c) {
                  <ng-container *ngTemplateOutlet="c.template; context: { $implicit: item }" />
                }
                @if (!disabled()) {
                  <div class="mt-2 flex flex-wrap gap-1">
                    @for (target of columns(); track target.id) {
                      @if (target.id !== col.id) {
                        <button
                          type="button"
                          class="btn-ghost px-2 py-0.5 text-xs"
                          (click)="move.emit({ item, from: col.id, to: target.id })"
                        >
                          Mover para {{ target.label }}
                        </button>
                      }
                    }
                  </div>
                }
              </li>
            } @empty {
              <li class="px-1 py-4 text-center text-xs text-muted">{{ emptyText() }}</li>
            }
          </ul>
        </section>
      }
    </div>
  `,
})
export class KanbanBoard<T> {
  readonly columns = input.required<KanbanColumn<T>[]>();
  readonly label = input('Quadro');
  readonly disabled = input(false);
  readonly emptyText = input('Vazio.');
  readonly trackBy = input<(item: T) => unknown>(
    (item: T) => (item as { id?: unknown }).id ?? item,
  );
  readonly move = output<KanbanMove<T>>();
  protected readonly card = contentChild(KanbanCard);
  protected readonly over = signal<string | null>(null);
  private dragging: { item: T; from: string } | null = null;

  protected onDragStart(event: DragEvent, item: T, from: string) {
    if (this.disabled()) return;
    this.dragging = { item, from };
    event.dataTransfer?.setData('text/plain', String(this.trackBy()(item)));
  }

  protected onDragOver(event: DragEvent, column: string) {
    if (!this.dragging) return;
    event.preventDefault();
    this.over.set(column);
  }

  protected onDrop(event: DragEvent, to: string) {
    event.preventDefault();
    this.over.set(null);
    const d = this.dragging;
    this.dragging = null;
    if (d && d.from !== to) this.move.emit({ item: d.item, from: d.from, to });
  }
}
