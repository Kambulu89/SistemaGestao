import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Rótulo, dica e erro à volta de um controlo. Evita repetir o mesmo markup em cada controlo.
 * `<label for>` só serve controlos de elemento único; os agrupados usam `legend` (ver `grouped`).
 */
@Component({
  selector: 'app-field-chrome',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (!grouped()) {
      <label [for]="fieldId()" class="mb-1.5 block text-sm font-medium">
        {{ label() }}
        @if (required()) {
          <span aria-hidden="true" class="text-red-600 dark:text-red-400"> *</span>
        }
      </label>
    }
    <ng-content />
    @if (error(); as error) {
      <p [id]="fieldId() + '-error'" class="mt-1.5 text-sm text-red-600 dark:text-red-400">
        {{ error }}
      </p>
    } @else if (hint(); as hint) {
      <p [id]="fieldId() + '-hint'" class="mt-1.5 text-sm text-fg-muted">{{ hint }}</p>
    }
  `,
})
export class FieldChrome {
  readonly fieldId = input.required<string>();
  readonly label = input.required<string>();
  readonly required = input(false);
  readonly hint = input<string>();
  readonly error = input<string | null>(null);
  /** Controlos agrupados (ex.: várias caixas) desenham o seu próprio `legend`. */
  readonly grouped = input(false);
}
