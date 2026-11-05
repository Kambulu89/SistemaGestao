import { Component, forwardRef, input, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

export interface Option {
  id: string;
  label: string;
  hint?: string | null;
}

let counter = 0;

/**
 * Escolha com pesquisa (padrão ARIA "combobox" com lista): escreve-se, a função `search` (normalmente a API) devolve
 * opções, ↑/↓ percorrem, Enter escolhe, Escape fecha. O valor do formulário é o `id`; `initialLabel` mostra o nome do
 * valor já escolhido.
 */
@Component({
  selector: 'app-autocomplete',
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => Autocomplete), multi: true },
  ],
  template: `
    <div class="relative">
      <input
        class="input"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        [id]="inputId()"
        [attr.aria-describedby]="describedBy()"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="listId"
        [attr.aria-activedescendant]="active() >= 0 ? listId + '-' + active() : null"
        [placeholder]="placeholder()"
        [disabled]="disabled()"
        [value]="text()"
        (input)="onInput($any($event.target).value)"
        (keydown)="onKeydown($event)"
        (blur)="onBlur()"
        (focus)="onInput(text(), true)"
      />
      @if (open()) {
        <ul
          [id]="listId"
          role="listbox"
          class="absolute z-40 mt-1 max-h-64 w-full overflow-auto rounded-card border border-border bg-surface p-1 text-sm shadow-[var(--shadow-overlay)]"
        >
          @if (loading()) {
            <li class="px-3 py-2 text-muted">A procurar…</li>
          } @else if (options().length === 0) {
            <li class="px-3 py-2 text-muted">Sem resultados.</li>
          }
          @for (o of options(); track o.id; let i = $index) {
            <li
              [id]="listId + '-' + i"
              role="option"
              [attr.aria-selected]="i === active()"
              class="cursor-pointer rounded px-3 py-2"
              [class.bg-primary-soft]="i === active()"
              [class.text-on-primary-soft]="i === active()"
              (mousedown)="$event.preventDefault(); choose(o)"
            >
              <span class="block">{{ o.label }}</span>
              @if (o.hint) {
                <span class="text-xs text-muted">{{ o.hint }}</span>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class Autocomplete implements ControlValueAccessor {
  readonly search = input.required<(q: string) => Promise<Option[]>>();
  readonly initialLabel = input<string | null>(null);
  readonly placeholder = input('Escreva para procurar…');
  readonly inputId = input<string | null>(null);
  readonly describedBy = input<string | null>(null);
  readonly minChars = input(0);
  protected readonly listId = `listbox-${++counter}`;
  protected readonly text = signal('');
  protected readonly options = signal<Option[]>([]);
  protected readonly open = signal(false);
  protected readonly loading = signal(false);
  protected readonly active = signal(-1);
  protected readonly disabled = signal(false);
  private selected: Option | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private onChange: (v: string | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: string | null) {
    if (!value) {
      this.selected = null;
      this.text.set('');
    } else if (this.selected?.id !== value) {
      this.selected = { id: value, label: this.initialLabel() ?? value };
      this.text.set(this.selected.label);
    }
  }
  registerOnChange(fn: (v: string | null) => void) {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void) {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean) {
    this.disabled.set(disabled);
  }

  protected onInput(value: string, focusOnly = false) {
    this.text.set(value);
    if (!focusOnly && this.selected && value !== this.selected.label) {
      this.selected = null;
      this.onChange(null);
    }
    if (value.trim().length < this.minChars()) {
      this.open.set(false);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fetch(value.trim()), 200);
  }

  private async fetch(q: string) {
    const seq = ++this.seq;
    this.loading.set(true);
    this.open.set(true);
    try {
      const options = await this.search()(q);
      if (seq !== this.seq) return;
      this.options.set(options);
      this.active.set(options.length > 0 ? 0 : -1);
    } catch {
      if (seq === this.seq) this.options.set([]);
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  protected onKeydown(event: KeyboardEvent) {
    const n = this.options().length;
    if (event.key === 'ArrowDown' && n) {
      event.preventDefault();
      this.open.set(true);
      this.active.set((this.active() + 1) % n);
    } else if (event.key === 'ArrowUp' && n) {
      event.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if (event.key === 'Enter' && this.open() && this.active() >= 0) {
      event.preventDefault();
      this.choose(this.options()[this.active()]);
    } else if (event.key === 'Escape' && this.open()) {
      event.preventDefault();
      this.open.set(false);
    }
  }

  protected choose(option: Option) {
    this.selected = option;
    this.text.set(option.label);
    this.open.set(false);
    this.onChange(option.id);
  }

  protected onBlur() {
    this.onTouched();
    setTimeout(() => this.open.set(false), 100);
    if (!this.selected) this.text.set('');
  }
}
