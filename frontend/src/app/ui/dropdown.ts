import { Component, ElementRef, inject, input, signal, viewChild } from '@angular/core';

let counter = 0;

/**
 * Menu suspenso acessível: botão com `aria-expanded`/`aria-controls`, fecha com Escape ou clique fora e devolve o foco
 * ao botão; setas ↑/↓ percorrem os itens (`[role=menuitem]`, `[role=menuitemradio]` ou `[data-menu-item]`).
 * Conteúdo: `<ng-container trigger>` para o botão e o resto para o painel.
 */
@Component({
  selector: 'app-dropdown',
  template: `
    <div class="relative">
      <button
        #trigger
        type="button"
        [class]="buttonClass()"
        [attr.aria-label]="label()"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="panelId"
        aria-haspopup="true"
        (click)="toggle()"
      >
        <ng-content select="[trigger]" />
      </button>
      @if (open()) {
        <div
          #panel
          [id]="panelId"
          class="absolute z-40 mt-2 min-w-56 rounded-card border border-border bg-surface p-1 text-sm text-fg shadow-[var(--shadow-overlay)]"
          [class.right-0]="align() === 'end'"
          [class.left-0]="align() === 'start'"
        >
          <ng-content />
        </div>
      }
    </div>
  `,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(keydown)': 'onKeydown($event)',
    '(click)': 'onPanelClick($event)',
  },
})
export class Dropdown {
  readonly label = input.required<string>();
  readonly align = input<'start' | 'end'>('end');
  readonly buttonClass = input('btn-ghost');
  /** Fecha ao escolher um item (por omissão sim). */
  readonly closeOnSelect = input(true);
  readonly open = signal(false);
  protected readonly panelId = `dropdown-${++counter}`;
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  toggle() {
    this.open.set(!this.open());
    if (this.open()) setTimeout(() => this.items()[0]?.focus());
  }

  close(returnFocus = true) {
    if (!this.open()) return;
    this.open.set(false);
    if (returnFocus) this.trigger().nativeElement.focus();
  }

  private items(): HTMLElement[] {
    const panel = this.panel()?.nativeElement;
    return panel
      ? [
          ...panel.querySelectorAll<HTMLElement>(
            '[role=menuitem],[role=menuitemradio],[data-menu-item]',
          ),
        ].filter((el) => !el.hasAttribute('disabled'))
      : [];
  }

  protected onKeydown(event: KeyboardEvent) {
    if (!this.open()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = this.items();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  protected onPanelClick(event: Event) {
    const item = (event.target as HTMLElement).closest(
      '[role=menuitem],[role=menuitemradio],[data-menu-item]',
    );
    if (item && this.closeOnSelect()) this.close(false);
  }

  protected onDocumentClick(event: Event) {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close(false);
  }
}
