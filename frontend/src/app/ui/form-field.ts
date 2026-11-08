import { Component, Directive, computed, inject, input } from '@angular/core';

let counter = 0;

/**
 * Campo de formulário: etiqueta, marca de obrigatório (visual e para leitores de ecrã), ajuda e erro (do servidor ou
 * do cliente). O controlo projectado leva `appControl`, que recebe o id e os atributos ARIA certos.
 */
@Component({
  selector: 'app-field',
  template: `
    <div>
      <label class="label" [attr.for]="controlId">
        {{ label() }}
        @if (required()) {
          <span aria-hidden="true" class="text-danger-text">*</span
          ><span class="sr-only">(obrigatório)</span>
        }
      </label>
      <ng-content />
      @if (error()) {
        <p class="field-error" [id]="errorId">{{ error() }}</p>
      } @else if (hint()) {
        <p class="mt-1 text-xs text-muted" [id]="hintId">{{ hint() }}</p>
      }
    </div>
  `,
})
export class FormField {
  readonly label = input.required<string>();
  readonly required = input(false);
  readonly hint = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly controlId = `field-${++counter}`;
  readonly hintId = `${this.controlId}-hint`;
  readonly errorId = `${this.controlId}-error`;
  readonly describedBy = computed(() =>
    this.error() ? this.errorId : this.hint() ? this.hintId : null,
  );
}

@Directive({
  selector: '[appControl]',
  host: {
    '[id]': 'field.controlId',
    '[attr.aria-describedby]': 'field.describedBy()',
    '[attr.aria-invalid]': 'field.error() ? true : null',
    '[attr.aria-required]': 'field.required() ? true : null',
  },
})
export class FieldControl {
  protected readonly field = inject(FormField);
}

/** Secção de formulário com título e descrição; os campos ficam numa grelha responsiva. */
@Component({
  selector: 'app-form-section',
  template: `
    <section class="card" [attr.aria-labelledby]="headingId">
      <h2 [id]="headingId" class="font-semibold">{{ title() }}</h2>
      @if (description()) {
        <p class="mt-0.5 text-sm text-muted">{{ description() }}</p>
      }
      <div
        class="mt-4 grid grid-cols-1 gap-4"
        [class.md:grid-cols-2]="columns() === 2"
        [class.md:grid-cols-3]="columns() === 3"
      >
        <ng-content />
      </div>
    </section>
  `,
})
export class FormSection {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
  readonly columns = input<1 | 2 | 3>(2);
  protected readonly headingId = `section-${++counter}`;
}
