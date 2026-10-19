import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FieldChrome } from '../form-field/field-chrome';
import { FormFieldBase } from '../form-field/form-field-base';

@Component({
  selector: 'app-textarea',
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
      <textarea
        [id]="id"
        [value]="value() ?? ''"
        [disabled]="disabled()"
        [rows]="rows()"
        [attr.placeholder]="placeholder()"
        [attr.aria-required]="required() || null"
        [attr.aria-invalid]="error() ? true : null"
        [attr.aria-describedby]="describedBy()"
        class="block w-full rounded-lg border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-70"
        [class.border-line]="!error()"
        [class.border-red-500]="error()"
        (input)="setValue($any($event.target).value)"
        (blur)="onTouched()"
      ></textarea>
    </app-field-chrome>
  `,
})
export class Textarea extends FormFieldBase<string> {
  readonly rows = input(4);
  readonly placeholder = input<string>();
}
