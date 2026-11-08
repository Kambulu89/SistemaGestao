import { Component, computed, input } from '@angular/core';
import { Icon } from './icon';
import type { ListState } from './list-state';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  key: string;
  label: string;
  /** `select` com opções (por omissão) ou `date` (AAAA-MM-DD). */
  type?: 'select' | 'date';
  options?: FilterOption[];
}

/** Texto de um filtro activo (rótulo e valor legível), para as etiquetas removíveis. */
export function chipText(def: FilterDef, value: string): string {
  const shown =
    def.type === 'date'
      ? value.split('-').reverse().join('/')
      : (def.options?.find((o) => o.value === value)?.label ?? value);
  return `${def.label}: ${shown}`;
}

/**
 * SearchAndFilterBar: pesquisa (com espera), filtros declarados (listas ou datas) e etiquetas dos filtros activos,
 * removíveis uma a uma ou todas. Lê e escreve no `ListState`, por isso tudo fica na URL e é aplicado no servidor.
 */
@Component({
  selector: 'app-filter-bar',
  imports: [Icon],
  template: `
    <div class="mb-3 space-y-2" role="search" [attr.aria-label]="'Filtrar ' + label()">
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-56 flex-1 sm:flex-none">
          <label class="label" [for]="id() + '-q'">Pesquisar</label>
          <div class="relative">
            <span
              class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
              aria-hidden="true"
              ><app-icon name="search" [size]="16"
            /></span>
            <input
              [id]="id() + '-q'"
              type="search"
              class="input w-full pl-9 sm:w-72"
              [placeholder]="placeholder()"
              [value]="state().q()"
              (input)="state().search($any($event.target).value)"
            />
          </div>
        </div>
        @for (f of filters(); track f.key) {
          <div>
            <label class="label" [for]="id() + '-' + f.key">{{ f.label }}</label>
            @if (f.type === 'date') {
              <input
                [id]="id() + '-' + f.key"
                type="date"
                class="input w-44"
                [value]="state().filters()[f.key] ?? ''"
                (change)="state().setFilter(f.key, $any($event.target).value)"
              />
            } @else {
              <select
                [id]="id() + '-' + f.key"
                class="input w-48"
                [value]="state().filters()[f.key] ?? ''"
                (change)="state().setFilter(f.key, $any($event.target).value)"
              >
                <option value="">Todos</option>
                @for (o of f.options ?? []; track o.value) {
                  <option [value]="o.value" [selected]="state().filters()[f.key] === o.value">
                    {{ o.label }}
                  </option>
                }
              </select>
            }
          </div>
        }
        <ng-content />
      </div>
      @if (chips().length > 0) {
        <div class="flex flex-wrap items-center gap-2" data-testid="filter-chips">
          @for (c of chips(); track c.key) {
            <span class="badge inline-flex items-center gap-1 bg-primary-soft text-on-primary-soft">
              {{ c.text }}
              <button
                type="button"
                class="focus-ring rounded"
                [attr.aria-label]="'Remover filtro ' + c.text"
                (click)="remove(c.key)"
              >
                <app-icon name="close" [size]="12" />
              </button>
            </span>
          }
          <button type="button" class="btn-link text-sm" (click)="state().clearFilters()">
            Limpar filtros
          </button>
        </div>
      }
    </div>
  `,
})
export class FilterBar {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a barra não depende do tipo das linhas
  readonly state = input.required<ListState<any>>();
  readonly filters = input<FilterDef[]>([]);
  readonly label = input('lista');
  readonly placeholder = input('Pesquisar…');
  readonly id = input('lista');
  protected readonly chips = computed(() => {
    const values = this.state().filters();
    const out: { key: string; text: string }[] = [];
    const q = this.state().q().trim();
    if (q) out.push({ key: 'q', text: `Pesquisa: ${q}` });
    for (const def of this.filters()) {
      const v = values[def.key];
      if (v) out.push({ key: def.key, text: chipText(def, v) });
    }
    return out;
  });

  protected remove(key: string) {
    if (key === 'q') {
      this.state().q.set('');
      this.state().search('');
    } else this.state().setFilter(key, '');
  }
}
