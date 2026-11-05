import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';

export type Theme = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sem armazenamento: a preferência vale só nesta sessão */
  }
};

/**
 * Preferências de apresentação do utilizador neste browser (tema, densidade, barra lateral). Aplicadas como atributos no
 * `<html>` (`data-theme`, `data-density`), que os tokens de `styles.css` usam.
 */
@Injectable({ providedIn: 'root' })
export class Preferences {
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  readonly theme = signal<Theme>((read('sg.theme') as Theme) ?? 'system');
  readonly density = signal<Density>((read('sg.density') as Density) ?? 'comfortable');
  readonly sidebarCollapsed = signal(read('sg.sidebar') === 'collapsed');
  private readonly systemDark = signal(this.media?.matches ?? false);

  constructor() {
    this.media?.addEventListener?.('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      const theme = this.theme();
      const dark = theme === 'dark' || (theme === 'system' && this.systemDark());
      this.document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      write('sg.theme', theme);
    });
    effect(() => {
      this.document.documentElement.setAttribute('data-density', this.density());
      write('sg.density', this.density());
    });
    effect(() => write('sg.sidebar', this.sidebarCollapsed() ? 'collapsed' : 'expanded'));
  }
}
