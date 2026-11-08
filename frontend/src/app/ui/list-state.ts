import { DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { Api, Page } from '../core/api';
import type { Sort } from './data-table';
import { Loadable } from './load';

export type Filters = Record<string, string>;
export type ListQuery = Record<string, string | number | undefined>;

export interface ListSnapshot {
  q: string;
  filters: Filters;
  sort: Sort | null;
  offset: number;
}

/** Estado da lista para a URL (só valores não vazios; a página 0 e a ordenação por omissão não aparecem). */
export function toQueryParams(state: ListSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  if (state.q.trim()) out['q'] = state.q.trim();
  for (const [k, v] of Object.entries(state.filters)) if (v) out[k] = v;
  if (state.sort) {
    out['sort'] = state.sort.field;
    out['direction'] = state.sort.direction;
  }
  if (state.offset > 0) out['offset'] = String(state.offset);
  return out;
}

/** Lê o estado a partir da URL, aceitando só os filtros e campos de ordenação conhecidos. */
export function fromQueryParams(
  params: Record<string, string | undefined>,
  filterKeys: readonly string[],
  sortFields: readonly string[],
): ListSnapshot {
  const filters: Filters = {};
  for (const k of filterKeys) if (params[k]) filters[k] = params[k]!;
  const field = params['sort'];
  const sort: Sort | null =
    field && sortFields.includes(field)
      ? { field, direction: params['direction'] === 'desc' ? 'desc' : 'asc' }
      : null;
  const offset = Math.max(0, Number.parseInt(params['offset'] ?? '0', 10) || 0);
  return { q: params['q'] ?? '', filters, sort, offset };
}

/** Consulta para a API (pesquisa, filtros, ordenação e paginação). */
export function toApiQuery(state: ListSnapshot, limit: number, extra: ListQuery = {}): ListQuery {
  const q: ListQuery = { ...extra };
  if (state.q.trim()) q['q'] = state.q.trim();
  for (const [k, v] of Object.entries(state.filters)) if (v) q[k] = v;
  if (state.sort) {
    q['sort'] = state.sort.field;
    q['direction'] = state.sort.direction;
  }
  q['limit'] = limit;
  q['offset'] = state.offset;
  return q;
}

export interface ListStateOptions {
  url: string;
  filterKeys?: readonly string[];
  sortFields?: readonly string[];
  limit?: number;
  /** Parâmetros sempre enviados (ex.: âmbito da entidade legal) e que não vão para a URL. */
  extra?: () => ListQuery;
}

/**
 * Estado de uma listagem (EntityListPage): pesquisa com espera, filtros, ordenação e página, reflectidos na URL (a
 * ligação partilhada abre a mesma vista; voltar atrás repõe-na) e carregados no servidor. Criar dentro do contexto de
 * injecção do componente.
 */
export class ListState<T> {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly limit: number;
  readonly q = signal('');
  readonly filters = signal<Filters>({});
  readonly sort = signal<Sort | null>(null);
  readonly offset = signal(0);
  readonly page: Loadable<Page<T>>;
  readonly activeFilters = computed(
    () => Object.entries(this.filters()).filter(([, v]) => !!v).length,
  );
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: Api,
    private readonly options: ListStateOptions,
  ) {
    this.limit = options.limit ?? 25;
    this.page = new Loadable(() => this.api.page<T>(options.url, this.query()));
    const sub = this.route.queryParams.subscribe((params) => {
      const s = fromQueryParams(params, options.filterKeys ?? [], options.sortFields ?? []);
      this.q.set(s.q);
      this.filters.set(s.filters);
      this.sort.set(s.sort);
      this.offset.set(s.offset);
      void this.page.load();
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      if (this.timer) clearTimeout(this.timer);
    });
  }

  snapshot(): ListSnapshot {
    return { q: this.q(), filters: this.filters(), sort: this.sort(), offset: this.offset() };
  }

  /** Consulta actual para a API (também usada na exportação, sem paginação). */
  query(): ListQuery {
    return toApiQuery(this.snapshot(), this.limit, this.options.extra?.() ?? {});
  }

  /** Pesquisa com espera (300 ms); volta à primeira página. */
  search(value: string) {
    this.q.set(value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.apply({ offset: 0 }), 300);
  }

  setFilter(key: string, value: string) {
    this.apply({ filters: { ...this.filters(), [key]: value }, offset: 0 });
  }

  clearFilters() {
    this.apply({ q: '', filters: {}, offset: 0 });
  }

  setSort(sort: Sort) {
    this.apply({ sort, offset: 0 });
  }

  goTo(offset: number) {
    this.apply({ offset });
  }

  /** Recarrega sem mexer na URL (ex.: âmbito mudou). */
  reload() {
    return this.page.load();
  }

  private apply(change: Partial<ListSnapshot>) {
    const next = { ...this.snapshot(), ...change };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toQueryParams(next),
      replaceUrl: false,
    });
  }
}
