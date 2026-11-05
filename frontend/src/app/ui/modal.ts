import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { Icon } from './icon';

let counter = 0;

/**
 * Janela modal sobre `<dialog>` nativo (`showModal`): o browser prende o foco, torna o resto inerte e fecha com Escape;
 * ao fechar o foco volta ao elemento que a abriu. `side` transforma-a numa gaveta lateral.
 */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  template: `
    <dialog
      #dialog
      [attr.aria-labelledby]="titleId"
      class="m-auto w-full max-w-lg rounded-card border border-border bg-surface p-0 text-fg shadow-[var(--shadow-overlay)] backdrop:bg-overlay"
      [class.max-w-lg]="!side()"
      [class.mr-0]="side()"
      [class.h-full]="side()"
      [class.max-h-full]="side()"
      [class.max-w-md]="side()"
      [class.rounded-none]="side()"
      (close)="closed.emit()"
      (cancel)="closed.emit()"
    >
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 [id]="titleId" class="font-semibold">{{ title() }}</h2>
        <button type="button" class="btn-ghost px-2" aria-label="Fechar" (click)="close()">
          <app-icon name="close" />
        </button>
      </div>
      <div class="px-4 py-4"><ng-content /></div>
      <div class="flex justify-end gap-2 border-t border-border px-4 py-3 empty:hidden">
        <ng-content select="[actions]" />
      </div>
    </dialog>
  `,
})
export class Modal {
  readonly title = input.required<string>();
  readonly open = input(false);
  readonly side = input(false);
  readonly closed = output();
  protected readonly titleId = `modal-${++counter}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.open() && !el.open) el.showModal?.();
      if (!this.open() && el.open) el.close();
    });
  }

  close() {
    this.dialog().nativeElement.close?.();
  }
}
