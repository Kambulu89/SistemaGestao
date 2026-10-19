import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FieldChrome } from '../form-field/field-chrome';
import { FormFieldBase } from '../form-field/form-field-base';
import type { SelectOption } from '../select/select';

/** Escolha única visível: botões de opção num `fieldset` com `legend`. */
@Component({
  selector: 'app-radio-group',
  imports: [FieldChrome],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-field-chrome
      [fieldId]="id"
      [label]="label()"
      [grouped]="true"
      [hint]="hint()"
      [error]="error()"
    >
      <fieldset
        class="rounded-lg border p-3"
        [class.border-line]="!error()"
        [class.border-red-500]="error()"
        [disabled]="disabled()"
        [attr.aria-describedby]="describedBy()"
      >
        <legend class="px-1 text-sm font-medium">
          {{ label() }}
          @if (required()) {
            <span aria-hidden="true" class="text-red-600 dark:text-red-400"> *</span>
          }
        </legend>
        <div class="flex flex-wrap gap-x-5 gap-y-2" role="radiogroup">
          @for (option of options(); track option.value) {
            <label class="flex items-center gap-2 text-sm">
              <input
                type="radio"
                class="size-4 accent-brand-600"
                [name]="id"
                [value]="option.value"
                [checked]="value() === option.value"
                (change)="setValue(option.value)"
                (blur)="onTouched()"
              />
              {{ option.label }}
            </label>
          }
        </div>
      </fieldset>
    </app-field-chrome>
  `,
})
export class RadioGroup extends FormFieldBase<string> {
  readonly options = input.required<readonly SelectOption[]>();
}
