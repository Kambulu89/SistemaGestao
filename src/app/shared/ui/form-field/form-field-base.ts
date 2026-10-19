import {
  computed,
  DestroyRef,
  Directive,
  inject,
  input,
  signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type ControlValueAccessor, NgControl, type ValidationErrors } from '@angular/forms';

let nextId = 0;

/**
 * Mensagem de erro de um controlo. Erros `dynamic` (motor de validação) e `server` (resposta do
 * backend) trazem a sua própria mensagem; os restantes são os validadores nativos do Angular.
 */
export function messageFor(errors: ValidationErrors): string {
  const custom = (errors['dynamic'] ?? errors['server']) as { message?: string } | undefined;
  if (custom?.message) return custom.message;
  if (errors['required']) return 'Campo obrigatório.';
  if (errors['email']) return 'Introduza um email válido.';
  const minlength = errors['minlength'] as { requiredLength: number } | undefined;
  if (minlength) return `Mínimo de ${minlength.requiredLength} caracteres.`;
  return 'Valor inválido.';
}

/**
 * Base dos controlos de formulário (`ControlValueAccessor`). Trata do rótulo, da dica, do estado
 * desactivado e do erro (mostrado depois de o controlo ser tocado), para que cada controlo se
 * limite a desenhar o seu elemento nativo.
 */
@Directive()
export abstract class FormFieldBase<T> implements ControlValueAccessor {
  protected readonly ngControl = inject(NgControl, { self: true, optional: true });
  private readonly destroyRef = inject(DestroyRef);

  readonly label = input.required<string>();
  readonly hint = input<string>();
  /** Só visual (asterisco e `aria-required`): a validação vem do controlo. */
  readonly required = input(false);

  protected readonly id = `app-field-${nextId++}`;
  protected readonly value: WritableSignal<T | null> = signal<T | null>(null);
  protected readonly disabled = signal(false);

  /** Incrementado quando o controlo muda de estado (tocado, validado…) para recalcular o erro. */
  private readonly controlChanged = signal(0);

  protected readonly error = computed(() => {
    this.controlChanged();
    const control = this.ngControl?.control;
    return control?.touched && control.errors ? messageFor(control.errors) : null;
  });

  protected readonly describedBy = computed(() =>
    this.error() ? `${this.id}-error` : this.hint() ? `${this.id}-hint` : null,
  );

  private onChange: (value: T | null) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  constructor() {
    if (this.ngControl) this.ngControl.valueAccessor = this;
  }

  writeValue(value: T | null): void {
    this.value.set(value ?? null);
  }

  registerOnChange(fn: (value: T | null) => void): void {
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

  /** Actualiza o valor local e notifica o formulário. */
  protected setValue(value: T | null): void {
    this.value.set(value);
    this.onChange(value);
  }
}
