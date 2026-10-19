import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FieldChrome } from '../form-field/field-chrome';
import { FormFieldBase } from '../form-field/form-field-base';

export type InputType =
  'text' | 'email' | 'url' | 'password' | 'number' | 'tel' | 'date' | 'datetime-local';

const pad = (n: number): string => String(n).padStart(2, '0');

/** ISO 8601 (UTC) → valor de `<input type="datetime-local">` na hora local. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string | null {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Campo de texto compatível com Reactive Forms (`formControlName` / `[formControl]`).
 * O valor do formulário é: `string` (texto, email, telefone, data `AAAA-MM-DD`), `number | null`
 * (`number`) e ISO 8601 em UTC (`datetime-local`, apresentado na hora local).
 */
@Component({
  selector: 'app-input',
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
      <div class="relative">
        <input
          [id]="id"
          [type]="type()"
          [value]="display()"
          [disabled]="disabled()"
          [attr.autocomplete]="autocomplete()"
          [attr.placeholder]="placeholder()"
          [attr.step]="step()"
          [attr.min]="min()"
          [attr.max]="max()"
          [attr.aria-required]="required() || null"
          [attr.aria-invalid]="error() ? true : null"
          [attr.aria-describedby]="describedBy()"
          class="block h-10 w-full rounded-lg border bg-surface px-3 text-sm text-fg placeholder:text-fg-muted disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-70"
          [class.border-line]="!error()"
          [class.border-red-500]="error()"
          [class.pe-14]="suffix()"
          (input)="onInput($event)"
          (blur)="onTouched()"
        />
        @if (suffix(); as suffix) {
          <span
            class="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-fg-muted"
            aria-hidden="true"
          >
            {{ suffix }}
          </span>
        }
      </div>
    </app-field-chrome>
  `,
})
export class Input extends FormFieldBase<string | number> {
  readonly type = input<InputType>('text');
  readonly autocomplete = input<string>();
  readonly placeholder = input<string>();
  readonly step = input<string | number>();
  readonly min = input<string | number>();
  readonly max = input<string | number>();
  /** Texto fixo à direita (ex.: unidade ou moeda). */
  readonly suffix = input<string>();

  protected readonly display = computed(() => {
    const value = this.value();
    if (value === null || value === undefined) return '';
    return this.type() === 'datetime-local' ? isoToLocalInput(String(value)) : String(value);
  });

  protected onInput(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    switch (this.type()) {
      case 'number': {
        const parsed = raw === '' ? null : Number(raw);
        this.setValue(parsed === null || Number.isNaN(parsed) ? null : parsed);
        break;
      }
      case 'datetime-local':
        this.setValue(raw === '' ? null : localInputToIso(raw));
        break;
      case 'date':
        this.setValue(raw === '' ? null : raw);
        break;
      default:
        this.setValue(raw);
    }
  }
}
