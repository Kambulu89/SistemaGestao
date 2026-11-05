import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Api } from '../core/api';
import { formatDateTime } from './dates';
import { ErrorAlert } from './error-alert';
import { Action, Loadable } from './load';
import { ConfirmService } from './confirm';
import { ToastService } from './toasts';

export interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  createdBy: { userId: string; fullName: string | null } | null;
}

export const ACCEPTED = '.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.docx,.xlsx,.odt,.ods';
export const MAX_BYTES = 10 * 1024 * 1024;

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Anexos de um registo. O acesso é decidido pelo servidor a partir do registo; `canWrite` só esconde os botões
 * (se a interface errar, a API recusa).
 */
@Component({
  selector: 'app-attachments',
  imports: [ErrorAlert],
  template: `
    <section class="card" aria-labelledby="attachments-title">
      <h2 id="attachments-title" class="font-semibold">Anexos</h2>
      <app-error-alert [error]="list.error() ?? action.error()" />
      @if (canWrite()) {
        <div class="mt-2">
          <label class="label" for="file">Carregar ficheiro</label>
          <input
            id="file"
            type="file"
            class="block text-sm"
            [accept]="accepted"
            [disabled]="action.busy()"
            (change)="upload($event)"
          />
          <p class="mt-1 text-xs text-muted">
            PDF, imagens, texto, CSV e documentos Office/ODF; até 10 MB.
          </p>
          @if (tooBig()) {
            <p class="field-error" role="alert">O ficheiro tem mais de 10 MB.</p>
          }
        </div>
      }
      @if (list.loading()) {
        <p class="mt-2 text-sm text-muted">A carregar…</p>
      } @else if ((list.value() ?? []).length === 0) {
        <p class="mt-2 text-sm text-muted">Sem anexos.</p>
      } @else {
        <ul class="mt-2 divide-y divide-border" data-testid="attachments">
          @for (a of list.value(); track a.id) {
            <li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                <span class="font-medium">{{ a.fileName }}</span>
                <span class="block text-xs text-muted">
                  {{ size(a.sizeBytes) }} · {{ a.createdBy?.fullName ?? '—' }} ·
                  {{ when(a.createdAt) }}
                </span>
              </span>
              <span class="flex gap-2">
                <button type="button" class="btn-secondary" (click)="download(a)">
                  Descarregar
                </button>
                @if (canWrite()) {
                  <button
                    type="button"
                    class="btn-secondary"
                    [disabled]="action.busy()"
                    (click)="remove(a)"
                  >
                    Eliminar
                  </button>
                }
              </span>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class Attachments {
  readonly subjectType = input.required<string>();
  readonly subjectId = input.required<string>();
  readonly canWrite = input(false);
  private readonly api = inject(Api);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  protected readonly accepted = ACCEPTED;
  protected readonly size = formatSize;
  protected readonly when = formatDateTime;
  protected readonly tooBig = signal(false);
  protected readonly action = new Action();
  protected readonly list = new Loadable(() =>
    this.api.get<Attachment[]>('attachments', {
      subjectType: this.subjectType(),
      subjectId: this.subjectId(),
    }),
  );

  constructor() {
    effect(() => {
      this.subjectType();
      this.subjectId();
      untracked(() => void this.list.load());
    });
  }

  protected async upload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.tooBig.set(file.size > MAX_BYTES);
    if (this.tooBig()) {
      input.value = '';
      return;
    }
    const form = new FormData();
    form.append('subjectType', this.subjectType());
    form.append('subjectId', this.subjectId());
    form.append('file', file, file.name);
    const uploaded = await this.action.run(() => this.api.upload('attachments', form));
    if (uploaded) this.toasts.show(`"${file.name}" carregado.`);
    input.value = '';
    await this.list.load();
  }

  protected async download(a: Attachment) {
    const result = await this.action.run(() => this.api.download(`attachments/${a.id}/content`));
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.fileName ?? a.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  protected async remove(a: Attachment) {
    const ok = await this.confirm.ask({
      title: 'Eliminar anexo',
      message: `Eliminar "${a.fileName}"? Fica registado na auditoria.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    await this.action.run(() => this.api.delete(`attachments/${a.id}`));
    if (!this.action.error()) this.toasts.show('Anexo eliminado.');
    await this.list.load();
  }
}
