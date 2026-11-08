import { Component, Injectable, inject, input, output } from '@angular/core';
import { Session } from './session';
import { Workspace } from './workspace';
import { formatDateTime } from '../ui/dates';

export interface Draft<T> {
  value: T;
  savedAt: string;
}

/** Rascunhos com mais de 7 dias são descartados. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Lê um rascunho guardado (ou null se inválido ou antigo). */
export function parseDraft<T>(raw: string | null, now = Date.now()): Draft<T> | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Draft<T>;
    const at = Date.parse(d?.savedAt);
    if (!d || d.value === undefined || Number.isNaN(at) || now - at > DRAFT_MAX_AGE_MS) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Rascunhos de formulários neste browser, por utilizador e empresa (nunca vão para o servidor nem para outro
 * utilizador). Servem para não perder trabalho por um separador fechado ou uma sessão expirada; o registo real só
 * existe depois de guardar na API.
 */
@Injectable({ providedIn: 'root' })
export class Drafts {
  private readonly session = inject(Session);
  private readonly workspace = inject(Workspace);

  private key(name: string) {
    const user = this.session.user()?.id;
    const tenant = this.workspace.context()?.tenant.id;
    return user && tenant ? `sg.draft.${user}.${tenant}.${name}` : null;
  }

  read<T>(name: string): Draft<T> | null {
    const key = this.key(name);
    if (!key) return null;
    try {
      const draft = parseDraft<T>(localStorage.getItem(key));
      if (!draft) localStorage.removeItem(key);
      return draft;
    } catch {
      return null;
    }
  }

  write<T>(name: string, value: T) {
    const key = this.key(name);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ value, savedAt: new Date().toISOString() }));
    } catch {
      /* sem armazenamento: sem rascunho */
    }
  }

  clear(name: string) {
    const key = this.key(name);
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* nada a fazer */
    }
  }
}

/** Aviso de rascunho por recuperar, com "Recuperar" e "Descartar". */
@Component({
  selector: 'app-draft-banner',
  template: `
    <div
      role="status"
      class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-info-soft px-4 py-3 text-sm text-info-text"
      data-testid="draft-banner"
    >
      <span>Há um rascunho por guardar deste formulário, de {{ when() }}.</span>
      <span class="flex gap-2">
        <button type="button" class="btn-secondary" (click)="discard.emit()">Descartar</button>
        <button type="button" class="btn-primary" (click)="restore.emit()">Recuperar</button>
      </span>
    </div>
  `,
})
export class DraftBanner {
  readonly savedAt = input.required<string>();
  readonly restore = output();
  readonly discard = output();
  protected when() {
    return formatDateTime(this.savedAt());
  }
}
