import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { Api } from './api';
import { Breadcrumbs } from './breadcrumbs';
import { Session } from './session';
import { Workspace } from './workspace';

export interface PageRef {
  path: string;
  title: string;
}

export const MAX_FAVORITES = 30;
export const MAX_RECENTS = 8;

/** Caminho guardável (sem query nem fragmento, só caracteres que o servidor aceita). */
export function cleanPath(url: string): string | null {
  const path = url.split(/[?#]/)[0];
  return /^\/[A-Za-z0-9/_\-.%]{0,199}$/.test(path) ? path : null;
}

/** Junta uma página ao topo da lista de recentes (sem repetidos, com limite). */
export function pushRecent(list: PageRef[], page: PageRef, max = MAX_RECENTS): PageRef[] {
  return [page, ...list.filter((p) => p.path !== page.path)].slice(0, max);
}

/** Acrescenta ou retira um favorito (sem repetidos, com limite). */
export function toggleFavorite(list: PageRef[], page: PageRef): PageRef[] {
  if (list.some((p) => p.path === page.path)) return list.filter((p) => p.path !== page.path);
  return [...list, page].slice(0, MAX_FAVORITES);
}

/**
 * Favoritos do membro na empresa em contexto, guardados no servidor (`/me/preferences/favorites`), por isso seguem o
 * utilizador entre browsers. Ao mudar de empresa recarregam; um erro deixa a lista vazia e não bloqueia a navegação.
 */
@Injectable({ providedIn: 'root' })
export class Favorites {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  readonly list = signal<PageRef[]>([]);
  readonly saving = signal(false);
  private loadedFor: string | null = null;

  constructor() {
    effect(() => {
      const ctx = this.workspace.context();
      const tenantId = ctx?.tenant.id ?? null;
      untracked(() => {
        if (tenantId === this.loadedFor) return;
        this.loadedFor = tenantId;
        this.list.set([]);
        if (tenantId) void this.load(tenantId);
      });
    });
  }

  has(path: string) {
    return this.list().some((p) => p.path === path);
  }

  private async load(tenantId: string) {
    try {
      const value = await this.api.get<PageRef[] | null>('me/preferences/favorites');
      if (this.loadedFor === tenantId) this.list.set(value ?? []);
    } catch {
      /* sem favoritos: não impede o resto da interface */
    }
  }

  /** Alterna um favorito; em caso de erro repõe a lista anterior e propaga o erro. */
  async toggle(page: PageRef) {
    const before = this.list();
    const next = toggleFavorite(before, page);
    this.list.set(next);
    this.saving.set(true);
    try {
      this.list.set(await this.api.put<PageRef[]>('me/preferences/favorites', { value: next }));
    } catch (error) {
      this.list.set(before);
      throw error;
    } finally {
      this.saving.set(false);
    }
  }
}

/**
 * Páginas visitadas recentemente, neste browser, por utilizador e empresa (não são dados de negócio; só o título da
 * página e o caminho). O título vem do trilho de navegação, já com o nome do registo quando o ecrã o define.
 */
@Injectable({ providedIn: 'root' })
export class Recents {
  private readonly session = inject(Session);
  private readonly workspace = inject(Workspace);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly key = computed(() => {
    const user = this.session.user()?.id;
    const tenant = this.workspace.context()?.tenant.id;
    return user && tenant ? `sg.recents.${user}.${tenant}` : null;
  });
  readonly list = signal<PageRef[]>([]);
  private pending: string | null = null;

  constructor() {
    effect(() => {
      const key = this.key();
      untracked(() => this.list.set(key ? readList(key) : []));
    });
    inject(Router)
      .events.pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe((e) => (this.pending = cleanPath((e as NavigationEnd).urlAfterRedirects)));
    // O título final (ex.: nome do registo) chega depois da navegação; regista quando o trilho estabiliza.
    effect(() => {
      const crumbs = this.breadcrumbs.crumbs();
      const last = crumbs[crumbs.length - 1];
      untracked(() => {
        const key = this.key();
        if (!key || !last || !this.pending) return;
        const path = this.pending;
        if (path === '/painel' || path === '/') return;
        this.list.set(pushRecent(this.list(), { path, title: last.label }));
        writeList(key, this.list());
      });
    });
  }
}

function readList(key: string): PageRef[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(value)
      ? value
          .filter(
            (p): p is PageRef =>
              typeof p?.path === 'string' && typeof p?.title === 'string' && !!cleanPath(p.path),
          )
          .slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: PageRef[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* sem armazenamento: os recentes valem só nesta sessão */
  }
}
