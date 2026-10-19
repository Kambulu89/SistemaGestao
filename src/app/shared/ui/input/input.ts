import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type ControlValueAccessor, NgControl, type ValidationErrors } from '@angular/forms';

let nextId = 0;

function messageFor(errors: ValidationErrors): string {
  if (errors['required']) return 'Campo obrigatório.';
  if (errors['email']) return 'Introduza um email válido.';
  const minlength = errors['minlength'] as { requiredLength: number } | undefined;
  if (minlength) return `Mínimo de ${minlength.requiredLength} caracteres.`;
  return 'Valor inválido.';
}

/**
 * Campo de texto compatível com Reactive Forms (`formControlName` / `[formControl]`).
 * Mostra o erro do controlo depois de este ser tocado.
 */
@Component({
  selector: 'app-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <label [for]="id" class="mb-1.5 block text-sm font-medium">{{ label() }}</label>
    <input
      [id]="id"
      [type]="type()"
      [value]="value()"
      [disabled]="disabled()"
      [attr.autocomplete]="autocomplete()"
      [attr.placeholder]="placeholder()"
      [attr.aria-invalid]="error() ? true : null"
      [attr.aria-describedby]="error() ? id + '-error' : hint() ? id + '-hint' : null"
      class="block h-10 w-full rounded-lg border bg-surface px-3 text-sm text-fg placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
      [class.border-line]="!error()"
      [class.border-red-500]="error()"
      (input)="onInput($event)"
      (blur)="onTouched()"
    />
    @if (error(); as error) {
      <p [id]="id + '-error'" class="mt-1.5 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    } @else if (hint(); as hint) {
      <p [id]="id + '-hint'" class="mt-1.5 text-sm text-fg-muted">{{ hint }}</p>
    }
  `,
})
export class Input implements ControlValueAccessor {
  private readonly ngControl = inject(NgControl, { self: true, optional: true });
  private readonly destroyRef = inject(DestroyRef);

  readonly label = input.required<string>();
  readonly type = input<'text' | 'email' | 'password'>('text');
  readonly autocomplete = input<string>();
  readonly placeholder = input<string>();
  readonly hint = input<string>();

  protected readonly id = `app-input-${nextId++}`;
  protected readonly value = signal('');
  protected readonly disabled = signal(false);

  /** Incrementado quando o controlo muda de estado (tocado, validado…) para recalcular o erro. */
  private readonly controlChanged = signal(0);

  protected readonly error = computed(() => {
    this.controlChanged();
    const control = this.ngControl?.control;
    return control?.touched && control.errors ? messageFor(control.errors) : null;
  });

  private onChange: (value: string) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  constructor() {
    if (this.ngControl) this.ngControl.valueAccessor = this;
  }

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
    // O controlo já existe neste ponto; `events` emite valor, estado, "tocado" e submissão.
    this.ngControl?.control?.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.controlChanged.update((n) => n + 1));
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.value.set(value);
    this.onChange(value);
  }
}
