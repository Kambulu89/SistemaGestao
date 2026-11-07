import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { ORG_KINDS } from '../admin/org-kinds';
import { Icon } from '../ui/icon';

export interface SearchHit {
  type: 'organization' | 'member' | 'role' | 'approval_request' | 'approval_workflow';
  kind?: string;
  id: string;
  title: string;
  subtitle: string | null;
}

const KIND_SEGMENT: Record<string, string> = {
  legalEntities: 'legal-entities',
  branches: 'branches',
  departments: 'departments',
  positions: 'positions',
  costCenters: 'cost-centers',
};

/** Rota de um resultado de pesquisa. */
export function hitLink(hit: SearchHit): string {
  switch (hit.type) {
    case 'organization':
      return `/organizacao/${KIND_SEGMENT[hit.kind ?? ''] ?? 'legal-entities'}/${hit.id}`;
    case 'member':
      return `/membros/${hit.id}`;
    case 'role':
      return `/perfis/${hit.id}`;
    case 'approval_request':
      return `/aprovacoes/pedidos/${hit.id}`;
    default:
      return `/aprovacoes/workflows/${hit.id}`;
  }
}

export function hitGroup(hit: SearchHit): string {
  if (hit.type === 'organization') {
    const segment = KIND_SEGMENT[hit.kind ?? ''];
    return ORG_KINDS[segment]?.title ?? 'Organização';
  }
  return {
    member: 'Membros',
    role: 'Perfis',
    approval_request: 'Pedidos de aprovação',
    approval_workflow: 'Workflows',
  }[hit.type];
}

/**
 * Pesquisa global ("/"; a paleta de comandos, Ctrl+K, também a usa): o servidor só procura nas fontes que o membro pode ler na empresa em contexto.
 * Combobox ARIA com resultados agrupados; ↑/↓ e Enter navegam.
 */
@Component({
  selector: 'app-global-search',
  imports: [Icon],
  host: { '(document:keydown)': 'shortcut($event)' },
  template: `
    @if (workspace.context()) {
      <div class="relative" role="search">
        <label for="global-search" class="sr-only">Pesquisar na empresa</label>
        <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
          ><app-icon name="search" [size]="16"
        /></span>
        <input
          #input
          id="global-search"
          class="input pl-9"
          type="search"
          role="combobox"
          autocomplete="off"
          aria-autocomplete="list"
          aria-controls="global-search-results"
          aria-describedby="global-search-hint"
          [attr.aria-expanded]="open()"
          [attr.aria-activedescendant]="active() >= 0 ? 'search-hit-' + active() : null"
          placeholder="Pesquisar registos ( / )"
          [value]="q()"
          (input)="onInput($any($event.target).value)"
          (keydown)="onKeydown($event)"
          (blur)="close()"
        />
        <span id="global-search-hint" class="sr-only"
          >Mínimo de 2 caracteres. Use as setas para escolher.</span
        >
        @if (open()) {
          <ul
            id="global-search-results"
            role="listbox"
            aria-label="Resultados"
            class="absolute z-40 mt-1 max-h-96 w-full min-w-72 overflow-auto rounded-card border border-border bg-surface p-1 text-sm shadow-[var(--shadow-overlay)]"
          >
            @if (loading()) {
              <li class="px-3 py-2 text-muted">A procurar…</li>
            } @else if (hits().length === 0) {
              <li class="px-3 py-2 text-muted">Sem resultados para "{{ q() }}".</li>
            }
            @for (h of hits(); track h.type + h.id; let i = $index) {
              @if (i === 0 || group(hits()[i - 1]) !== group(h)) {
                <li
                  role="presentation"
                  class="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase"
                >
                  {{ group(h) }}
                </li>
              }
              <li
                [id]="'search-hit-' + i"
                role="option"
                [attr.aria-selected]="i === active()"
                class="cursor-pointer rounded px-3 py-2"
                [class.bg-primary-soft]="i === active()"
                [class.text-on-primary-soft]="i === active()"
                (mousedown)="$event.preventDefault(); go(h)"
              >
                <span class="block">{{ h.title }}</span>
                @if (h.subtitle) {
                  <span class="text-xs text-muted">{{ h.subtitle }}</span>
                }
              </li>
            }
          </ul>
        }
        <p class="sr-only" aria-live="polite">
          {{ open() && !loading() ? hits().length + ' resultados' : '' }}
        </p>
      </div>
    }
  `,
})
export class GlobalSearch {
  protected readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  protected readonly q = signal('');
  protected readonly hits = signal<SearchHit[]>([]);
  protected readonly loading = signal(false);
  protected readonly active = signal(-1);
  protected readonly open = computed(() => this.q().trim().length >= 2 && this.focused());
  private readonly focused = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  protected readonly group = hitGroup;

  protected shortcut(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    const typing =
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    if (event.key === '/' && !typing) {
      event.preventDefault();
      this.input()?.nativeElement.focus();
    }
  }

  protected onInput(value: string) {
    this.q.set(value);
    this.focused.set(true);
    if (this.timer) clearTimeout(this.timer);
    if (value.trim().length < 2) {
      this.hits.set([]);
      return;
    }
    this.timer = setTimeout(() => void this.fetch(value.trim()), 250);
  }

  private async fetch(q: string) {
    const seq = ++this.seq;
    this.loading.set(true);
    try {
      const hits = await this.api.get<SearchHit[]>('search', { q });
      if (seq !== this.seq) return;
      this.hits.set(hits);
      this.active.set(hits.length ? 0 : -1);
    } catch {
      if (seq === this.seq) this.hits.set([]);
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  protected onKeydown(event: KeyboardEvent) {
    const n = this.hits().length;
    if (event.key === 'ArrowDown' && n) {
      event.preventDefault();
      this.active.set((this.active() + 1) % n);
    } else if (event.key === 'ArrowUp' && n) {
      event.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if (event.key === 'Enter' && this.active() >= 0) {
      event.preventDefault();
      this.go(this.hits()[this.active()]);
    } else if (event.key === 'Escape') {
      this.q.set('');
      this.hits.set([]);
    } else {
      this.focused.set(true);
    }
  }

  protected go(hit: SearchHit) {
    this.q.set('');
    this.hits.set([]);
    void this.router.navigateByUrl(hitLink(hit));
  }

  protected close() {
    setTimeout(() => this.focused.set(false), 120);
  }
}
