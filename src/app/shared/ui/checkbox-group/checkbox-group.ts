import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FieldChrome } from '../form-field/field-chrome';
import { FormFieldBase } from '../form-field/form-field-base';
import type { SelectOption } from '../select/select';

/** Escolha múltipla: várias caixas num `fieldset` com `legend`. */
@Component({
  selector: 'app-checkbox-group',
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
        <div class="flex flex-wrap gap-x-5 gap-y-2">
          @for (option of options(); track option.value) {
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                class="size-4 rounded border-line accent-brand-600"
                [checked]="isChecked(option.value)"
                (change)="toggle(option.value, $any($event.target).checked)"
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
export class CheckboxGroup extends FormFieldBase<readonly string[]> {
  readonly options = input.required<readonly SelectOption[]>();

  protected isChecked(value: string): boolean {
    return this.value()?.includes(value) ?? false;
  }

  protected toggle(value: string, checked: boolean): void {
    const current = this.value() ?? [];
    const next = checked ? [...current, value] : current.filter((v) => v !== value);
    this.setValue(next.length > 0 ? next : null);
  }
}
