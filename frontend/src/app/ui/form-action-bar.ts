import { Component, input } from '@angular/core';

/**
 * Barra de acções fixa no fundo dos formulários de edição (EntityEditPage): indicação de alterações por guardar, acções
 * extra projectadas e o botão de submissão do formulário indicado em `formId` (sem submissão dupla enquanto `busy`).
 */
@Component({
  selector: 'app-form-action-bar',
  template: `
    <div
      class="no-print sticky bottom-0 z-20 -mx-4 mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-4 py-3"
      data-testid="form-action-bar"
    >
      @if (dirty()) {
        <span class="mr-auto text-sm text-muted" role="status">Alterações por guardar</span>
      }
      <ng-content />
      <button
        type="submit"
        class="btn-primary"
        [attr.form]="formId()"
        [disabled]="busy() || disabled()"
      >
        {{ busy() ? 'A guardar…' : saveLabel() }}
      </button>
    </div>
  `,
})
export class FormActionBar {
  readonly formId = input.required<string>();
  readonly dirty = input(false);
  readonly busy = input(false);
  readonly disabled = input(false);
  readonly saveLabel = input('Guardar alterações');
}
