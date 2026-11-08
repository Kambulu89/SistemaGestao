import { Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ApiError } from '../core/api';
import { Modal } from './modal';
import { ErrorState, Skeleton } from './states';
import { StatusBadge } from './status-badge';

/**
 * DetailDrawer: vista rápida de um registo numa gaveta lateral, sem sair da lista. Mostra carregamento, erro (com
 * repetição) e o conteúdo; a ligação "Abrir página" leva ao detalhe completo, onde estão as acções. Construída sobre o
 * `<dialog>` nativo (foco preso, Escape fecha e devolve o foco à linha).
 */
@Component({
  selector: 'app-detail-drawer',
  imports: [Modal, RouterLink, ErrorState, Skeleton, StatusBadge],
  template: `
    <app-modal [title]="title()" [open]="open()" [side]="true" (closed)="closed.emit()">
      <div data-testid="detail-drawer">
        @if (subtitle() || status()) {
          <p class="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
            @if (status()) {
              <app-status-badge [status]="status()!" />
            }
            {{ subtitle() }}
          </p>
        }
        @if (error()) {
          <app-error-state [error]="error()" (retry)="retry.emit()" />
        } @else if (loading()) {
          <app-skeleton />
        } @else {
          <ng-content />
        }
      </div>
      <ng-container actions>
        <ng-content select="[actions]" />
        @if (link()) {
          <a class="btn-primary" [routerLink]="link()" (click)="closed.emit()">Abrir página</a>
        }
      </ng-container>
    </app-modal>
  `,
})
export class DetailDrawer {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly status = input<string | null>(null);
  readonly open = input(false);
  readonly loading = input(false);
  readonly error = input<ApiError | null>(null);
  readonly link = input<string | unknown[] | null>(null);
  readonly closed = output();
  readonly retry = output();
}

/** Lista de pares rótulo/valor para gavetas e detalhes (`<dl>` acessível). */
@Component({
  selector: 'app-field-list',
  template: `
    <dl class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-2 text-sm">
      @for (f of fields(); track f.label) {
        <dt class="text-muted">{{ f.label }}</dt>
        <dd
          class="min-w-0 break-words"
          [class.text-right]="f.align === 'end'"
          [class.tabular-nums]="f.align === 'end'"
        >
          {{ f.value === null || f.value === undefined || f.value === '' ? '—' : f.value }}
        </dd>
      }
    </dl>
  `,
})
export class FieldList {
  readonly fields = input.required<{ label: string; value: unknown; align?: 'start' | 'end' }[]>();
}
