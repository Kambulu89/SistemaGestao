import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormFieldBase } from '../form-field/form-field-base';

@Component({
  selector: 'app-checkbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <label class="flex items-start gap-2.5 text-sm" [for]="id">
      <input
        type="checkbox"
        [id]="id"
        class="mt-0.5 size-4 rounded border-line accent-brand-600 disabled:cursor-not-allowed"
        [checked]="value() === true"
        [disabled]="disabled()"
        [attr.aria-invalid]="error() ? true : null"
        [attr.aria-describedby]="describedBy()"
        (change)="setValue($any($event.target).checked)"
        (blur)="onTouched()"
      />
      <span class="font-medium">{{ label() }}</span>
    </label>
    @if (error(); as error) {
      <p [id]="id + '-error'" class="mt-1.5 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    } @else if (hint(); as hint) {
      <p [id]="id + '-hint'" class="mt-1.5 ps-6 text-sm text-fg-muted">{{ hint }}</p>
    }
  `,
})
export class Checkbox extends FormFieldBase<boolean> {}
