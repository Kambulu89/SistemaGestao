import { Component, input, output } from '@angular/core';
import type { ApiError } from '../../core/api';
import { DraftBanner } from '../../core/drafts';
import { ErrorAlert } from '../error-alert';
import { ErrorState, Skeleton } from '../states';

/**
 * EntityCreatePage / EntityEditPage: cabeçalho, carregamento e erro de carregamento, aviso de rascunho por recuperar,
 * erro do servidor ao guardar, o formulário (projectado) e a barra de acções fixa no fundo (Cancelar / Guardar, com
 * "A guardar…" e sem submissão dupla). O aviso de alterações por guardar é do componente da página
 * (`unsavedChangesGuard` + `warnOnUnload`).
 */
@Component({
  selector: 'app-entity-form-page',
  imports: [DraftBanner, ErrorAlert, ErrorState, Skeleton],
  template: `
    <div class="mb-5">
      <h1 class="text-2xl font-semibold">{{ title() }}</h1>
      @if (subtitle()) {
        <p class="mt-1 text-sm text-muted">{{ subtitle() }}</p>
      }
    </div>
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="retry.emit()" />
    } @else if (loading()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @if (draftSavedAt()) {
        <app-draft-banner
          [savedAt]="draftSavedAt()!"
          (restore)="restoreDraft.emit()"
          (discard)="discardDraft.emit()"
        />
      }
      <app-error-alert [error]="saveError()" [showDetails]="true" />
      <form [id]="formId()" class="space-y-4 pb-20" novalidate (submit)="onSubmit($event)">
        <ng-content />
      </form>
      <div
        class="no-print sticky bottom-0 z-20 -mx-4 mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-4 py-3"
      >
        @if (dirty()) {
          <span class="mr-auto text-sm text-muted" role="status">Alterações por guardar</span>
        }
        <ng-content select="[actions]" />
        <button type="button" class="btn-secondary" (click)="cancelled.emit()">
          {{ readOnly() ? 'Voltar' : 'Cancelar' }}
        </button>
        @if (!readOnly()) {
          <button type="submit" class="btn-primary" [attr.form]="formId()" [disabled]="busy()">
            {{ busy() ? 'A guardar…' : saveLabel() }}
          </button>
        }
      </div>
    }
  `,
})
export class EntityFormPage {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly formId = input('entity-form');
  readonly loading = input(false);
  readonly loadError = input<ApiError | null>(null);
  readonly saveError = input<ApiError | null>(null);
  readonly busy = input(false);
  readonly dirty = input(false);
  readonly saveLabel = input('Guardar');
  /** Registo que já não se edita (ex.: documento confirmado): sem botão de guardar; as acções vêm no slot. */
  readonly readOnly = input(false);
  readonly draftSavedAt = input<string | null>(null);
  readonly save = output();
  readonly cancelled = output();
  readonly retry = output();
  readonly restoreDraft = output();
  readonly discardDraft = output();

  protected onSubmit(event: Event) {
    event.preventDefault();
    if (!this.busy() && !this.readOnly()) this.save.emit();
  }
}
