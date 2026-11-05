import { Component, forwardRef, input, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

/**
 * Data (AAAA-MM-DD, como a API) com o selector nativo do browser, limites opcionais e botão para limpar. O texto
 * mostrado segue a língua da página (`lang="pt"`).
 */
@Component({
  selector: 'app-date-input',
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DateInput), multi: true },
  ],
  template: `
    <div class="flex gap-1">
      <input
        type="date"
        class="input"
        [id]="inputId()"
        [attr.aria-describedby]="describedBy()"
        [min]="min() ?? ''"
        [max]="max() ?? ''"
        [disabled]="disabled()"
        [value]="value() ?? ''"
        (change)="set($any($event.target).value)"
        (blur)="onTouched()"
      />
      @if (value() && !disabled()) {
        <button type="button" class="btn-ghost px-2" aria-label="Limpar data" (click)="set('')">
          ×
        </button>
      }
    </div>
  `,
})
export class DateInput implements ControlValueAccessor {
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  readonly inputId = input<string | null>(null);
  readonly describedBy = input<string | null>(null);
  protected readonly value = signal<string | null>(null);
  protected readonly disabled = signal(false);
  private onChange: (v: string | null) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  writeValue(value: string | null) {
    this.value.set(value || null);
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

  protected set(raw: string) {
    this.value.set(raw || null);
    this.onChange(raw || null);
  }
}
