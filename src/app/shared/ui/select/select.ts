import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FieldChrome } from '../form-field/field-chrome';
import { FormFieldBase } from '../form-field/form-field-base';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** Lista de escolha única sobre `<select>` nativo (teclado e leitores de ecrã de origem). */
@Component({
  selector: 'app-select',
  imports: [FieldChrome],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-field-chrome
      [fieldId]="id"
      [label]="label()"
      [required]="required()"
      [hint]="hint()"
      [error]="error()"
    >
      <select
        [id]="id"
        [disabled]="disabled()"
        [attr.aria-required]="required() || null"
        [attr.aria-invalid]="error() ? true : null"
        [attr.aria-describedby]="describedBy()"
        class="block h-10 w-full rounded-lg border bg-surface px-3 text-sm text-fg disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-70"
        [class.border-line]="!error()"
        [class.border-red-500]="error()"
        (change)="setValue($any($event.target).value || null)"
        (blur)="onTouched()"
      >
        <option value="" [selected]="!value()">{{ placeholder() }}</option>
        @for (option of options(); track option.value) {
          <option [value]="option.value" [selected]="option.value === value()">
            {{ option.label }}
          </option>
        }
      </select>
    </app-field-chrome>
  `,
})
export class Select extends FormFieldBase<string> {
  readonly options = input.required<readonly SelectOption[]>();
  readonly placeholder = input('Seleccione…');
}
