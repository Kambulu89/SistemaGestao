import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Button } from '../button/button';
import { FieldChrome } from '../form-field/field-chrome';
import { FormFieldBase } from '../form-field/form-field-base';
import { Icon } from '../icon/icon';

/** Metadados de um ficheiro escolhido. O envio dos bytes pertence ao futuro serviço de ficheiros. */
export interface FileInfo {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly id?: string;
}

const formatSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${Math.round(bytes / 1024)} kB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

/** Escolha de ficheiros que regista só os metadados (nome, tamanho, tipo). */
@Component({
  selector: 'app-file-input',
  imports: [FieldChrome, Button, Icon],
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
      <input
        [id]="id"
        type="file"
        class="block w-full text-sm file:me-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-surface-muted disabled:opacity-70"
        [multiple]="multiple()"
        [disabled]="disabled()"
        [attr.accept]="accept()"
        [attr.aria-required]="required() || null"
        [attr.aria-invalid]="error() ? true : null"
        [attr.aria-describedby]="describedBy()"
        (change)="onFiles($any($event.target).files)"
        (blur)="onTouched()"
      />
      @if (files().length > 0) {
        <ul
          class="mt-2 space-y-1 text-sm"
          [attr.aria-label]="'Ficheiros seleccionados de ' + label()"
        >
          @for (file of files(); track $index) {
            <li
              class="flex items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-1.5"
            >
              <span class="truncate"
                >{{ file.name }} <span class="text-fg-muted">({{ size(file.size) }})</span></span
              >
              <app-button
                variant="ghost"
                size="sm"
                [label]="'Remover ' + file.name"
                [disabled]="disabled()"
                (click)="remove($index)"
              >
                <app-icon name="close" class="size-4" />
              </app-button>
            </li>
          }
        </ul>
      }
    </app-field-chrome>
  `,
})
export class FileInput extends FormFieldBase<readonly FileInfo[]> {
  readonly accept = input<string>();
  readonly multiple = input(false);

  protected files(): readonly FileInfo[] {
    return this.value() ?? [];
  }

  protected size(bytes: number): string {
    return formatSize(bytes);
  }

  protected onFiles(list: FileList | null): void {
    const chosen = Array.from(list ?? []).map((f) => ({
      name: f.name,
      size: f.size,
      contentType: f.type,
    }));
    this.setValue(
      chosen.length > 0 ? (this.multiple() ? [...this.files(), ...chosen] : chosen) : this.value(),
    );
  }

  protected remove(index: number): void {
    const next = this.files().filter((_, i) => i !== index);
    this.setValue(next.length > 0 ? next : null);
  }
}
