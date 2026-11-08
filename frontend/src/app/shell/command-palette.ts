import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Favorites, Recents } from '../core/personal';
import { Preferences } from '../core/preferences';
import { Session } from '../core/session';
import { Workspace } from '../core/workspace';
import { Icon } from '../ui/icon';
import { type SearchHit, hitGroup, hitLink } from './global-search';
import { flatNavigation, visibleNavigation } from './navigation';

export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

/** Normaliza para comparar sem acentos nem maiúsculas. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Todas as palavras da pesquisa têm de aparecer no rótulo ou na dica. */
export function matches(command: Pick<Command, 'label' | 'hint' | 'group'>, query: string) {
  const hay = fold(`${command.label} ${command.hint ?? ''} ${command.group}`);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * Paleta de comandos (Ctrl+K / ⌘K): favoritos, recentes, todos os ecrãs que a navegação mostra a este membro, acções
 * da interface e, a partir de 2 caracteres, a pesquisa global do servidor (que só procura no que o membro pode ler).
 * Diálogo modal nativo: o foco fica preso, Escape fecha e devolve o foco a quem a abriu.
 */
@Component({
  selector: 'app-command-palette',
  imports: [Icon],
  host: { '(document:keydown)': 'shortcut($event)' },
  template: `
    <button
      type="button"
      class="btn-ghost hidden gap-2 px-2 text-sm text-muted sm:inline-flex"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      data-testid="open-palette"
      (click)="show()"
    >
      <app-icon name="command" [size]="16" />
      <span>Comandos</span>
      <kbd class="rounded border border-border px-1 font-sans text-xs">Ctrl K</kbd>
    </button>
    <dialog
      #dialog
      aria-label="Paleta de comandos"
      class="mx-auto mt-[10vh] w-full max-w-xl rounded-card border border-border bg-surface p-0 text-fg shadow-[var(--shadow-overlay)] backdrop:bg-overlay"
      (close)="open.set(false)"
    >
      <div class="flex items-center gap-2 border-b border-border px-3">
        <app-icon name="search" [size]="18" />
        <input
          #input
          class="w-full bg-transparent py-3 text-base outline-none placeholder:text-subtle"
          type="text"
          role="combobox"
          aria-label="Escreva um comando ou pesquise"
          aria-controls="palette-list"
          aria-expanded="true"
          aria-autocomplete="list"
          [attr.aria-activedescendant]="items().length ? 'palette-item-' + active() : null"
          placeholder="Ir para, acções ou pesquisar…"
          autocomplete="off"
          [value]="q()"
          (input)="onInput($any($event.target).value)"
          (keydown)="onKeydown($event)"
        />
        <kbd class="rounded border border-border px-1 text-xs text-muted">Esc</kbd>
      </div>
      <ul
        id="palette-list"
        role="listbox"
        aria-label="Comandos"
        class="max-h-[60vh] overflow-y-auto p-1 text-sm"
      >
        @for (c of items(); track c.id; let i = $index) {
          @if (i === 0 || items()[i - 1].group !== c.group) {
            <li
              role="presentation"
              class="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase"
            >
              {{ c.group }}
            </li>
          }
          <li
            [id]="'palette-item-' + i"
            role="option"
            [attr.aria-selected]="i === active()"
            class="flex cursor-pointer items-center gap-3 rounded px-3 py-2"
            [class.bg-primary-soft]="i === active()"
            [class.text-on-primary-soft]="i === active()"
            (mousemove)="active.set(i)"
            (mousedown)="$event.preventDefault(); execute(c)"
          >
            <app-icon [name]="c.icon" [size]="16" />
            <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
            @if (c.hint) {
              <span class="truncate text-xs text-muted">{{ c.hint }}</span>
            }
          </li>
        } @empty {
          <li class="px-3 py-6 text-center text-muted">
            {{ loading() ? 'A procurar…' : 'Nada encontrado para "' + q() + '".' }}
          </li>
        }
        @if (loading() && items().length) {
          <li class="px-3 py-2 text-xs text-muted" role="presentation">A procurar na empresa…</li>
        }
      </ul>
      <p class="sr-only" aria-live="polite">{{ items().length }} resultado(s)</p>
    </dialog>
  `,
})
export class CommandPalette {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly workspace = inject(Workspace);
  private readonly session = inject(Session);
  private readonly prefs = inject(Preferences);
  private readonly favorites = inject(Favorites);
  private readonly recents = inject(Recents);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  protected readonly open = signal(false);
  protected readonly q = signal('');
  protected readonly active = signal(0);
  protected readonly loading = signal(false);
  private readonly hits = signal<SearchHit[]>([]);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  private readonly pages = computed(() =>
    flatNavigation(
      visibleNavigation(
        (p, any) => (any ? this.workspace.canAny(p) : this.workspace.can(p)),
        (f) => this.workspace.has(f),
        this.workspace.context() !== null,
        this.session.user()?.isPlatformAdmin === true,
      ),
    ),
  );

  private readonly commands = computed<Command[]>(() => {
    const go = (path: string) => () => void this.router.navigateByUrl(path);
    const dark = this.prefs.theme() === 'dark';
    const favorites = this.favorites.list().map((f) => ({
      id: `fav:${f.path}`,
      group: 'Favoritos',
      label: f.title,
      hint: f.path,
      icon: 'star',
      run: go(f.path),
    }));
    const recents = this.recents.list().map((r) => ({
      id: `rec:${r.path}`,
      group: 'Recentes',
      label: r.title,
      hint: r.path,
      icon: 'clock',
      run: go(r.path),
    }));
    const pages = this.pages().map((p) => ({
      id: `page:${p.path}`,
      group: 'Ir para',
      label: p.label,
      hint: p.section ? `${p.group} · ${p.section}` : p.group,
      icon: p.icon,
      run: go(p.path),
    }));
    const actions: Command[] = [
      {
        id: 'act:theme',
        group: 'Acções',
        label: dark ? 'Usar tema claro' : 'Usar tema escuro',
        icon: dark ? 'sun' : 'moon',
        run: () => this.prefs.theme.set(dark ? 'light' : 'dark'),
      },
      {
        id: 'act:density',
        group: 'Acções',
        label: this.prefs.density() === 'compact' ? 'Densidade confortável' : 'Densidade compacta',
        icon: 'layers',
        run: () =>
          this.prefs.density.set(this.prefs.density() === 'compact' ? 'comfortable' : 'compact'),
      },
      {
        id: 'act:sidebar',
        group: 'Acções',
        label: this.prefs.sidebarCollapsed() ? 'Expandir menu lateral' : 'Recolher menu lateral',
        icon: 'menu',
        run: () => this.prefs.sidebarCollapsed.set(!this.prefs.sidebarCollapsed()),
      },
      {
        id: 'act:profile',
        group: 'Acções',
        label: 'O meu perfil',
        icon: 'user',
        run: go('/perfil'),
      },
    ];
    if (this.workspace.context())
      actions.push({
        id: 'act:switch',
        group: 'Acções',
        label: 'Mudar de empresa',
        icon: 'building',
        run: go('/empresas'),
      });
    return [...favorites, ...recents, ...pages, ...actions];
  });

  protected readonly items = computed<Command[]>(() => {
    const q = this.q().trim();
    if (!q) {
      // Sem pesquisa: favoritos, recentes e as acções; os ecrãs aparecem ao escrever.
      return this.commands().filter((c) => c.group !== 'Ir para');
    }
    const local = this.commands().filter(
      (c) => (c.group === 'Ir para' || c.group === 'Acções') && matches(c, q),
    );
    const remote = this.hits().map((h) => ({
      id: `hit:${h.type}:${h.id}`,
      group: `Registos · ${hitGroup(h)}`,
      label: h.title,
      hint: h.subtitle ?? undefined,
      icon: 'search',
      run: () => void this.router.navigateByUrl(hitLink(h)),
    }));
    return [...local, ...remote];
  });

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.open() && !el.open) {
        el.showModal?.();
        this.input().nativeElement.focus();
      }
      if (!this.open() && el.open) el.close();
    });
  }

  show() {
    this.q.set('');
    this.hits.set([]);
    this.active.set(0);
    this.open.set(true);
  }

  protected shortcut(event: KeyboardEvent) {
    if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (this.open()) this.open.set(false);
      else this.show();
    }
  }

  protected onInput(value: string) {
    this.q.set(value);
    this.active.set(0);
    if (this.timer) clearTimeout(this.timer);
    const q = value.trim();
    if (q.length < 2 || !this.workspace.context()) {
      this.hits.set([]);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.timer = setTimeout(() => void this.fetch(q), 250);
  }

  private async fetch(q: string) {
    const seq = ++this.seq;
    try {
      const hits = await this.api.get<SearchHit[]>('search', { q });
      if (seq === this.seq) this.hits.set(hits);
    } catch {
      if (seq === this.seq) this.hits.set([]);
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  protected onKeydown(event: KeyboardEvent) {
    const n = this.items().length;
    if (event.key === 'ArrowDown' && n) {
      event.preventDefault();
      this.active.set((this.active() + 1) % n);
    } else if (event.key === 'ArrowUp' && n) {
      event.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if (event.key === 'Enter' && n) {
      event.preventDefault();
      this.execute(this.items()[Math.min(this.active(), n - 1)]);
    }
  }

  protected execute(command: Command) {
    this.open.set(false);
    command.run();
  }
}
