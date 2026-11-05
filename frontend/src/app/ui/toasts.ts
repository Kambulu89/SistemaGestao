import { Component, Injectable, inject, signal } from '@angular/core';
import { Icon } from './icon';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

/**
 * Avisos breves de resultado ("Guardado.", "Convite enviado."). Anunciados a leitores de ecrã (`role=status`, ou
 * `role=alert` nos erros) e fecham sozinhos; os erros de validação continuam junto dos campos.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private next = 0;

  show(message: string, kind: Toast['kind'] = 'success', ms = 4000) {
    const toast = { id: ++this.next, kind, message };
    this.toasts.set([...this.toasts(), toast]);
    if (ms > 0) setTimeout(() => this.dismiss(toast.id), ms);
  }

  dismiss(id: number) {
    this.toasts.set(this.toasts().filter((t) => t.id !== id));
  }
}

@Component({
  selector: 'app-toasts',
  imports: [Icon],
  template: `
    <div
      class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      @for (t of service.toasts(); track t.id) {
        <div
          class="pointer-events-auto flex items-start gap-2 rounded-card border p-3 text-sm shadow-[var(--shadow-overlay)]"
          [class]="tone(t.kind)"
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
        >
          <app-icon
            [name]="t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'"
          />
          <p class="flex-1">{{ t.message }}</p>
          <button
            type="button"
            class="focus-ring rounded"
            aria-label="Fechar aviso"
            (click)="service.dismiss(t.id)"
          >
            <app-icon name="close" [size]="16" />
          </button>
        </div>
      }
    </div>
  `,
})
export class Toasts {
  protected readonly service = inject(ToastService);

  protected tone(kind: Toast['kind']) {
    const base =
      'pointer-events-auto flex items-start gap-2 rounded-card border p-3 text-sm shadow-[var(--shadow-overlay)] ';
    if (kind === 'error') return base + 'border-danger-border bg-danger-soft text-danger-text';
    if (kind === 'success') return base + 'border-border bg-success-soft text-success-text';
    return base + 'border-border bg-info-soft text-info-text';
  }
}
