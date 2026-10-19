import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'sg-theme';
const ORDER: readonly ThemePreference[] = ['light', 'dark', 'system'];

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly mediaQuery = this.document.defaultView?.matchMedia?.(
    '(prefers-color-scheme: dark)',
  );

  private readonly systemDark = signal(this.mediaQuery?.matches ?? false);

  readonly preference = signal<ThemePreference>(this.readStored());
  readonly resolved = computed<ResolvedTheme>(() => {
    const pref = this.preference();
    return pref === 'system' ? (this.systemDark() ? 'dark' : 'light') : pref;
  });

  constructor() {
    this.mediaQuery?.addEventListener('change', (e) => this.systemDark.set(e.matches));

    effect(() => {
      this.document.documentElement.classList.toggle('dark', this.resolved() === 'dark');
    });
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Armazenamento indisponível (modo privado, etc.): a preferência vale apenas na sessão.
    }
  }

  /** Alterna entre claro → escuro → sistema. */
  cycle(): void {
    const next = ORDER[(ORDER.indexOf(this.preference()) + 1) % ORDER.length] ?? 'system';
    this.set(next);
  }

  private readStored(): ThemePreference {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return ORDER.find((p) => p === value) ?? 'system';
    } catch {
      return 'system';
    }
  }
}
