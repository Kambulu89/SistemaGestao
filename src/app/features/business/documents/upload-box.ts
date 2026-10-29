import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { DocumentsApi, type AttachmentDto, type UploadState } from './documents.api';
import { documentError, formatSize, STATUS, unavailableText, uploadLabel } from './documents-model';

/**
 * Escolha e envio de um ficheiro com progresso (AttachmentUploader): nome, tipo, tamanho, progresso, cancelar e
 * tentar de novo. O estado de quarentena é sempre visível e só um ficheiro `AVAILABLE` é entregue a quem o usa.
 */
@Component({
  selector: 'app-upload-box',
  imports: [Alert, Badge, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-2" data-testid="upload-box">
      <label class="block text-sm font-medium text-fg" for="upload-file">Ficheiro</label>
      <input
        id="upload-file"
        type="file"
        class="block w-full text-sm file:me-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium"
        [disabled]="busy()"
        (change)="choose($event)"
      />
      @if (file(); as chosen) {
        <p class="text-sm" data-testid="upload-file-info">
          {{ chosen.name }}
          <span class="text-fg-muted"
            >({{ size(chosen.size) }} · {{ chosen.type || 'tipo desconhecido' }})</span
          >
        </p>
      }
      @if (state(); as current) {
        @if (current.stage === 'uploading') {
          <div
            class="h-2 overflow-hidden rounded bg-surface-muted"
            role="progressbar"
            aria-label="Progresso do envio"
            aria-valuemin="0"
            aria-valuemax="100"
            [attr.aria-valuenow]="current.percent"
          >
            <div class="h-full bg-brand-600" [style.width.%]="current.percent"></div>
          </div>
        }
        @if (current.stage !== 'done') {
          <p class="text-sm text-fg-muted" data-testid="upload-stage">{{ label(current) }}</p>
        }
      }
      @if (result(); as attachment) {
        <p class="text-sm">
          <app-badge [tone]="status(attachment).tone" data-testid="upload-status">{{
            status(attachment).label
          }}</app-badge>
        </p>
        @if (problem(attachment); as text) {
          <app-alert tone="danger">{{ text }}</app-alert>
        }
      }
      @if (error(); as text) {
        <app-alert tone="danger" data-testid="upload-error">{{ text }}</app-alert>
      }
      <div class="flex gap-2">
        @if (busy()) {
          <app-button size="sm" variant="secondary" (click)="cancel()">Cancelar</app-button>
        } @else if (file() && !result()?.downloadable) {
          <app-button size="sm" variant="secondary" (click)="start()">Tentar de novo</app-button>
        }
      </div>
    </div>
  `,
})
export class UploadBox {
  private readonly api = inject(DocumentsApi);

  /** O anexo disponível, ou `null` quando ainda não há um (ou deixou de haver). */
  readonly attachmentChange = output<AttachmentDto | null>();

  protected readonly file = signal<File | null>(null);
  protected readonly state = signal<UploadState | null>(null);
  protected readonly result = signal<AttachmentDto | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  private running: Subscription | null = null;

  protected size = formatSize;
  protected status = (a: AttachmentDto) => STATUS[a.status];
  protected problem = (a: AttachmentDto) => unavailableText(a.status, a.rejectCode);
  protected label = (s: UploadState) =>
    s.stage === 'done' ? '' : uploadLabel(s.stage, s.stage === 'uploading' ? s.percent : 0);

  protected choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.item(0) ?? null;
    this.cancel();
    this.file.set(chosen);
    this.reset();
    if (chosen) this.start();
  }

  protected start(): void {
    const chosen = this.file();
    if (!chosen) return;
    this.reset();
    this.busy.set(true);
    this.running = this.api.upload(chosen).subscribe({
      next: (s) => {
        this.state.set(s);
        if (s.stage === 'done') {
          this.result.set(s.attachment);
          this.busy.set(false);
          this.attachmentChange.emit(s.attachment.downloadable ? s.attachment : null);
        }
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.state.set(null);
        this.error.set(documentError(e, 'Não foi possível enviar o ficheiro.'));
      },
    });
  }

  protected cancel(): void {
    this.running?.unsubscribe();
    this.running = null;
    if (this.busy()) {
      this.busy.set(false);
      this.state.set(null);
      this.error.set('Envio cancelado.');
    }
  }

  private reset(): void {
    this.state.set(null);
    this.result.set(null);
    this.error.set(null);
    this.attachmentChange.emit(null);
  }
}
