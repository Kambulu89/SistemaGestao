import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';

/**
 * Diálogo modal sobre o elemento nativo `<dialog>`: o navegador trata do foco, da camada e
 * do Escape. O conteúdo vai no slot por omissão e as acções em `[dialogActions]`.
 */
@Component({
  selector: 'app-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="m-auto w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-0 text-fg shadow-xl backdrop:bg-slate-900/50"
      [class.max-w-md]="!wide()"
      [class.max-w-2xl]="wide()"
      [attr.aria-labelledby]="'dialog-title-' + uid"
      (close)="closed.emit()"
      (cancel)="closed.emit()"
    >
      @if (open()) {
        <div class="p-6">
          <h2 [id]="'dialog-title-' + uid" class="text-lg font-semibold">{{ title() }}</h2>
          <div class="mt-2 text-sm text-fg-muted"><ng-content /></div>
          <div class="mt-6 flex justify-end gap-2"><ng-content select="[dialogActions]" /></div>
        </div>
      }
    </dialog>
  `,
})
export class Dialog {
  readonly open = input.required<boolean>();
  readonly title = input.required<string>();
  /** Para conteúdo em colunas (formulários com várias listas). */
  readonly wide = input(false);
  /** Emitido quando o utilizador fecha o diálogo (Escape ou programaticamente). */
  readonly closed = output();

  private static nextUid = 0;
  protected readonly uid = Dialog.nextUid++;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const element = this.dialog().nativeElement;
      // jsdom e navegadores muito antigos não têm showModal/close: recorre-se ao atributo.
      if (this.open() && !element.open) {
        if (typeof element.showModal === 'function') element.showModal();
        else element.setAttribute('open', '');
      } else if (!this.open() && element.open) {
        if (typeof element.close === 'function') element.close();
        else element.removeAttribute('open');
      }
    });
  }
}
