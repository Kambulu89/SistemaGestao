import { Component, forwardRef, input, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

/**
 * Normaliza um valor monetário escrito pelo utilizador para texto decimal canónico (`1234.50`), sem passar por
 * números de vírgula flutuante. Aceita vírgula decimal e separadores de milhares (espaço ou ponto antes da vírgula).
 * Devolve `null` se vazio e `undefined` se inválido.
 */
export function normalizeMoney(raw: string, scale = 2): string | null | undefined {
  let text = raw.trim().replace(/\s/g, '');
  if (text === '') return null;
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) return undefined;
  const int = whole.replace(/^0+(?=\d)/, '');
  return `${sign}${int}${scale > 0 ? '.' + fraction.padEnd(scale, '0') : ''}`;
}

/** Apresentação com separadores portugueses (`1 234,50`), a partir do texto canónico. */
export function formatMoney(value: string | null, scale = 2): string {
  if (value === null || value === '') return '';
  const [int, fraction = ''] = value.replace('-', '').split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${value.startsWith('-') ? '-' : ''}${grouped}${scale > 0 ? ',' + fraction.padEnd(scale, '0') : ''}`;
}

/**
 * Campo de dinheiro: o valor do formulário é sempre texto decimal (nunca `number`), como a API espera. Mostra a moeda
 * e valida casas decimais; o servidor volta a validar.
 */
@Component({
  selector: 'app-money-input',
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MoneyInput), multi: true },
  ],
  template: `
    <div class="flex">
      <input
        class="input rounded-r-none text-right tabular-nums"
        inputmode="decimal"
        autocomplete="off"
        [id]="inputId()"
        [attr.aria-invalid]="invalid() ? true : null"
        [attr.aria-describedby]="describedBy()"
        [disabled]="disabled()"
        [value]="text()"
        (input)="text.set($any($event.target).value)"
        (blur)="commit()"
      />
      <span
        class="inline-flex items-center rounded-r-control border border-l-0 border-border-strong bg-surface-2 px-3 text-sm text-muted"
        >{{ currency() }}</span
      >
    </div>
    @if (invalid()) {
      <p class="field-error">Valor inválido (até {{ scale() }} casas decimais).</p>
    }
  `,
})
export class MoneyInput implements ControlValueAccessor {
  readonly currency = input('AOA');
  readonly scale = input(2);
  readonly inputId = input<string | null>(null);
  readonly describedBy = input<string | null>(null);
  protected readonly text = signal('');
  protected readonly invalid = signal(false);
  protected readonly disabled = signal(false);
  private onChange: (v: string | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: string | null) {
    this.text.set(formatMoney(value ?? null, this.scale()));
    this.invalid.set(false);
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

  protected commit() {
    this.onTouched();
    const value = normalizeMoney(this.text(), this.scale());
    if (value === undefined) {
      this.invalid.set(true);
      return;
    }
    this.invalid.set(false);
    this.text.set(formatMoney(value, this.scale()));
    this.onChange(value);
  }
}
