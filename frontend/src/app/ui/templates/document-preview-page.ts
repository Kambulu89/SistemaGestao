import {
  Component,
  DestroyRef,
  type ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { Api, ApiError } from '../../core/api';
import { ErrorState, Skeleton } from '../states';
import { Icon } from '../icon';

export type PreviewKind = 'pdf' | 'image' | 'text' | null;

/**
 * Tipos que se mostram no browser. HTML, SVG e outros tipos activos nunca são mostrados (podiam executar código):
 * para esses, e para documentos Office, só a descarga.
 */
export function previewKind(contentType: string): PreviewKind {
  const t = contentType.toLowerCase().split(';')[0].trim();
  if (t === 'application/pdf') return 'pdf';
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(t)) return 'image';
  if (['text/plain', 'text/csv'].includes(t)) return 'text';
  return null;
}

/** Limite de texto mostrado (o resto descarrega-se). */
export const TEXT_PREVIEW_LIMIT = 200_000;

/**
 * DocumentPreviewPage: pré-visualização de um ficheiro da API numa janela grande (PDF no visualizador do browser,
 * imagem, ou texto como texto simples), com descarga. O ficheiro vem pela mesma rota autorizada da descarga; o URL
 * temporário é libertado ao fechar.
 */
@Component({
  selector: 'app-document-preview',
  imports: [ErrorState, Skeleton, Icon],
  template: `
    <dialog
      #dlg
      class="m-auto h-[90vh] w-[min(64rem,95vw)] max-w-none rounded-card border border-border bg-surface p-0 text-fg shadow-[var(--shadow-overlay)] backdrop:bg-overlay"
      aria-labelledby="doc-preview-title"
      (close)="closed.emit()"
      (cancel)="closed.emit()"
    >
      <div class="flex h-full flex-col">
        <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 id="doc-preview-title" class="truncate font-semibold">{{ fileName() }}</h2>
          <div class="flex gap-2">
            <button type="button" class="btn-secondary" (click)="download()" [disabled]="!blob()">
              <app-icon name="download" [size]="16" /> Descarregar
            </button>
            <button type="button" class="btn-ghost px-2" aria-label="Fechar" (click)="dlg.close()">
              <app-icon name="close" />
            </button>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto bg-surface-2 p-2" data-testid="doc-preview">
          @if (error()) {
            <app-error-state [error]="error()" (retry)="load()" />
          } @else if (!blob()) {
            <div class="card"><app-skeleton /></div>
          } @else {
            @switch (kind()) {
              @case ('pdf') {
                <iframe
                  class="h-full w-full rounded bg-surface"
                  [src]="frameUrl()"
                  [title]="'Pré-visualização de ' + fileName()"
                ></iframe>
              }
              @case ('image') {
                <img class="mx-auto max-h-full max-w-full" [src]="objectUrl()" [alt]="fileName()" />
              }
              @case ('text') {
                <pre class="card text-xs whitespace-pre-wrap">{{ text() }}</pre>
              }
              @default {
                <p class="card text-sm">
                  Este tipo de ficheiro não se pré-visualiza no browser. Use Descarregar.
                </p>
              }
            }
          }
        </div>
      </div>
    </dialog>
  `,
})
export class DocumentPreviewPage {
  /** Rota da API que devolve o conteúdo (ex.: `attachments/:id/content`). */
  readonly url = input.required<string>();
  readonly fileName = input.required<string>();
  readonly contentType = input.required<string>();
  readonly open = input(false);
  readonly closed = output();
  private readonly api = inject(Api);
  private readonly sanitizer = inject(DomSanitizer);
  protected readonly blob = signal<Blob | null>(null);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly objectUrl = signal<string | null>(null);
  protected readonly frameUrl = signal<SafeResourceUrl | null>(null);
  protected readonly text = signal('');
  protected readonly kind = signal<PreviewKind>(null);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    inject(DestroyRef).onDestroy(() => this.release());
    effect(() => {
      const open = this.open();
      untracked(() => {
        const dialog = this.dlg().nativeElement;
        if (open) {
          if (!dialog.open) dialog.showModal?.();
          void this.load();
        } else {
          if (dialog.open) dialog.close();
          this.release();
        }
      });
    });
  }

  async load() {
    this.release();
    this.error.set(null);
    this.kind.set(previewKind(this.contentType()));
    try {
      const { blob } = await this.api.download(this.url());
      this.blob.set(blob);
      if (this.kind() === 'text') {
        const t = await blob.slice(0, TEXT_PREVIEW_LIMIT).text();
        this.text.set(blob.size > TEXT_PREVIEW_LIMIT ? `${t}\n…` : t);
        return;
      }
      if (!this.kind()) return;
      // O tipo do Blob fica fixado pelo tipo verificado (não pelo cabeçalho), para o browser não o interpretar de outra forma.
      const typed = new Blob([blob], { type: this.contentType().split(';')[0] });
      const url = URL.createObjectURL(typed);
      this.objectUrl.set(url);
      if (this.kind() === 'pdf')
        this.frameUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(url));
    } catch (e) {
      this.error.set(ApiError.from(e));
    }
  }

  protected download() {
    const b = this.blob();
    if (!b) return;
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private release() {
    const url = this.objectUrl();
    if (url) URL.revokeObjectURL(url);
    this.objectUrl.set(null);
    this.frameUrl.set(null);
    this.blob.set(null);
    this.text.set('');
  }
}
