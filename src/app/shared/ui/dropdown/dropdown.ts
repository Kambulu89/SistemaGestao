import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { Icon } from '../icon/icon';

let nextId = 0;

/**
 * Padrão "disclosure": botão com `aria-expanded` que mostra um painel.
 * Fecha com Escape, clique fora ou clique dentro do painel (ex.: ao escolher um link).
 */
@Component({
  selector: 'app-dropdown',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'relative inline-block',
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'close(true)',
  },
  template: `
    <button
      #trigger
      type="button"
      class="flex h-10 items-center gap-2 rounded-lg px-2 text-sm text-fg hover:bg-surface-muted"
      [attr.aria-label]="label()"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="panelId"
      (click)="open.set(!open())"
    >
      <ng-content select="[dropdownTrigger]" />
      <app-icon name="chevron-down" class="size-4 text-fg-muted" />
    </button>

    @if (open()) {
      <div
        [id]="panelId"
        class="absolute z-50 mt-2 min-w-56 rounded-xl border border-line bg-surface p-1 shadow-lg"
        [class.end-0]="align() === 'end'"
        [class.start-0]="align() === 'start'"
      >
        <ng-content />
      </div>
    }
  `,
})
export class Dropdown {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Nome acessível do botão. */
  readonly label = input.required<string>();
  readonly align = input<'start' | 'end'>('start');

  protected readonly open = signal(false);
  protected readonly panelId = `dropdown-panel-${nextId++}`;

  protected close(restoreFocus = false): void {
    if (!this.open()) return;
    this.open.set(false);
    if (restoreFocus) this.host.nativeElement.querySelector('button')?.focus();
  }

  protected onDocumentClick(event: Event): void {
    const target = event.target as HTMLElement;
    if (!this.host.nativeElement.contains(target)) {
      this.close();
    } else if (target.closest(`#${this.panelId} a, #${this.panelId} button`)) {
      // Escolher uma opção (link ou botão) dentro do painel fecha-o.
      this.close();
    }
  }
}
