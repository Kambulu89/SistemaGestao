import { DestroyRef, inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';
import { ConfirmService } from '../ui/confirm';

/** Ecrã com formulário que pode ter alterações por guardar. */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

/** Pergunta antes de sair de um formulário com alterações por guardar (navegação dentro da aplicação). */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) =>
  !component?.hasUnsavedChanges?.() ||
  inject(ConfirmService).ask({
    title: 'Alterações por guardar',
    message: 'Saiu sem guardar. Quer descartar as alterações?',
    confirmLabel: 'Descartar',
    danger: true,
  });

/** Avisa também ao fechar ou recarregar o separador (o browser mostra a sua própria mensagem). */
export function warnOnUnload(component: HasUnsavedChanges) {
  const handler = (event: BeforeUnloadEvent) => {
    if (component.hasUnsavedChanges()) event.preventDefault();
  };
  window.addEventListener('beforeunload', handler);
  inject(DestroyRef).onDestroy(() => window.removeEventListener('beforeunload', handler));
}

/** Instantâneo comparável de um formulário (para saber se mudou). */
export const snapshot = (value: unknown) => JSON.stringify(value, (_k, v) => (v === '' ? null : v));
