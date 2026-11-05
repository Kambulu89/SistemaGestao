import { Component, input, model } from '@angular/core';

export interface TabItem {
  id: string;
  label: string;
  count?: number | null;
}

/**
 * Separadores (padrão ARIA "tabs"): ←/→ mudam de separador com foco móvel; o conteúdo de cada um é mostrado pela
 * página com `@if (tab() === 'x')` dentro de `<div role="tabpanel" [attr.aria-labelledby]="'tab-x'">`.
 */
@Component({
  selector: 'app-tabs',
  host: { '(keydown)': 'onKeydown($event)' },
  template: `
    <div
      role="tablist"
      [attr.aria-label]="label()"
      class="mb-4 flex gap-1 overflow-x-auto border-b border-border"
    >
      @for (t of tabs(); track t.id) {
        <button
          type="button"
          role="tab"
          [id]="'tab-' + t.id"
          [attr.aria-selected]="active() === t.id"
          [attr.aria-controls]="'panel-' + t.id"
          [attr.tabindex]="active() === t.id ? 0 : -1"
          class="focus-ring -mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap"
          [class.border-primary]="active() === t.id"
          [class.font-semibold]="active() === t.id"
          [class.border-transparent]="active() !== t.id"
          [class.text-muted]="active() !== t.id"
          (click)="active.set(t.id)"
        >
          {{ t.label }}
          @if (t.count !== null && t.count !== undefined) {
            <span class="badge ml-1 bg-surface-2 text-muted">{{ t.count }}</span>
          }
        </button>
      }
    </div>
  `,
})
export class Tabs {
  readonly tabs = input.required<TabItem[]>();
  readonly label = input.required<string>();
  readonly active = model.required<string>();

  protected onKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.id === this.active());
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    this.active.set(next.id);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`#tab-${next.id}`)?.focus();
    event.preventDefault();
  }
}
