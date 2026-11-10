import { Component, Injectable, inject, signal } from '@angular/core';
import { Modal } from './modal';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

/** Confirmação de acções com consequências (substitui `window.confirm`, que não é acessível nem estilizável). */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  ask(options: ConfirmOptions): Promise<boolean> {
    this.current()?.resolve(false);
    return new Promise((resolve) => this.current.set({ ...options, resolve }));
  }

  answer(ok: boolean) {
    const current = this.current();
    this.current.set(null);
    current?.resolve(ok);
  }

  /**
   * Responde só se `request` ainda for o pedido actual: o evento `close` de um diálogo já respondido pode chegar
   * depois de aberto o pedido seguinte e não o pode cancelar.
   */
  answerFor(request: ConfirmOptions, ok: boolean) {
    if (this.current() === request) this.answer(ok);
  }
}

@Component({
  selector: 'app-confirm-host',
  imports: [Modal],
  template: `
    @if (service.current(); as c) {
      <app-modal [title]="c.title" [open]="true" (closed)="service.answerFor(c, false)">
        <p class="text-sm">{{ c.message }}</p>
        <ng-container actions>
          <button type="button" class="btn-secondary" (click)="service.answerFor(c, false)">
            Cancelar
          </button>
          <button
            type="button"
            [class]="c.danger ? 'btn-danger' : 'btn-primary'"
            (click)="service.answerFor(c, true)"
          >
            {{ c.confirmLabel ?? 'Confirmar' }}
          </button>
        </ng-container>
      </app-modal>
    }
  `,
})
export class ConfirmHost {
  protected readonly service = inject(ConfirmService);
}
