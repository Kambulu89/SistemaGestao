import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { qty } from './stock-model';
import { type CostPool, METHOD, money } from './valuation-model';

/**
 * Valorização do stock (8.9): valor por entidade legal, produto e variante — custo médio, FIFO ou específico por lote.
 * Daqui abre-se o detalhe (camadas e livro de custo) e a reconciliação com a contabilidade.
 */
@Component({
  selector: 'app-valuation',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable],
  template: `
    <app-entity-list-page
      title="Valorização do stock"
      subtitle="Valor do stock por entidade legal, na moeda funcional. O passado nunca é recalculado: correcções entram como ajustes de custo."
      feature="inventory"
    >
      <a
        actions
        class="btn-secondary"
        routerLink="/inventario/valorizacao/reconciliacao"
        data-testid="val-recon"
        >Reconciliação</a
      >
      @if (totals().length) {
        <div class="mb-3 flex flex-wrap gap-3" data-testid="val-totals">
          @for (t of totals(); track t.legalEntityId) {
            <div class="card px-4 py-2">
              <span class="block text-xs text-muted">{{ leCode(t.legalEntityId) }}</span>
              <span class="font-semibold">{{ m(t.value) }}</span>
            </div>
          }
        </div>
      }
      <app-filter-bar
        id="val"
        label="valorização"
        placeholder="SKU ou produto"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Valor do stock"
        tableId="inv-valuation"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem stock valorizado com estes filtros.'
            : 'Sem stock valorizado.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      />
    </app-entity-list-page>
  `,
})
export class Valuation {
  private readonly api = inject(Api);
  protected readonly m = money;
  private readonly entities = signal<{ id: string; code: string; legalName?: string }[]>([]);
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'legalEntityId',
      label: 'Entidade legal',
      options: this.entities().map((e) => ({ value: e.id, label: e.code })),
    },
  ]);
  protected readonly columns: Column<CostPool>[] = [
    { key: 'legalEntity', label: 'Entidade', value: (r) => r.legalEntity.code },
    {
      key: 'product',
      label: 'Produto',
      required: true,
      value: (r) => r.variant?.sku ?? r.product.sku,
      link: (r) => ['/inventario/valorizacao', r.legalEntity.id, r.product.id],
    },
    { key: 'name', label: 'Nome', hideOnMobile: true, value: (r) => r.product.name },
    { key: 'method', label: 'Método', hideOnMobile: true, value: (r) => METHOD[r.method] },
    {
      key: 'quantity',
      label: 'Quantidade',
      align: 'end',
      value: (r) => `${qty(r.quantity)} ${r.uom}`,
    },
    {
      key: 'unitCost',
      label: 'Custo unitário',
      align: 'end',
      hideOnMobile: true,
      value: (r) => qty(r.unitCost),
    },
    { key: 'value', label: 'Valor', align: 'end', value: (r) => money(r.value, r.currency) },
  ];
  protected readonly list = new ListState<CostPool>(this.api, {
    url: 'inventory/valuation',
    filterKeys: ['legalEntityId', 'productId'],
    sortFields: [],
    limit: 50,
  });
  /** Valor total por entidade (todas as que o membro vê). */
  protected readonly totals = signal<{ legalEntityId: string; value: string }[]>([]);

  constructor() {
    this.api.get<{ id: string; code: string }[]>('organization/legal-entities').then(
      (e) => this.entities.set(e),
      () => undefined,
    );
    this.api.getWithMeta<CostPool[]>('inventory/valuation', { limit: 1 }).then(
      (r) =>
        this.totals.set((r.meta?.['totals'] as { legalEntityId: string; value: string }[]) ?? []),
      () => undefined,
    );
  }

  protected leCode(id: string) {
    return this.entities().find((e) => e.id === id)?.code ?? '';
  }
}
