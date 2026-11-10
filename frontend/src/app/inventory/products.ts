import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { exportList, withoutPaging } from '../ui/export';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type Brand,
  type Category,
  categoryPaths,
  priceLabel,
  type Product,
  PRODUCT_STATUS,
  PRODUCT_TYPE,
  type ProductStatus,
  productTone,
} from './inventory-model';

/** Produtos e serviços: pesquisa por SKU, nome ou código de barras (também das variantes); filtros na URL. */
@Component({
  selector: 'app-products',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Produtos e serviços"
      subtitle="Catálogo da empresa: armazenáveis, serviços e kits, com unidades, variantes e classe contabilística."
      permission="inventory.read"
      feature="inventory"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/inventario/produtos/novo"
          ><app-icon name="plus" [size]="16" />Novo produto</a
        >
      }
      <app-filter-bar
        id="prd"
        label="produtos"
        placeholder="SKU, nome ou código de barras"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Produtos e serviços"
        tableId="inv-products"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [sort]="list.sort()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [exportable]="true"
        [exporting]="exporting()"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem produtos com estes filtros.'
            : 'Ainda não há produtos no catálogo.'
        "
        (sortChange)="list.setSort($event)"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
        (export)="export($event)"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ status(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Products {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly canManage = computed(() => this.workspace.can('inventory.products.manage'));
  protected readonly exporting = signal(false);
  private readonly categories = signal<Category[]>([]);
  private readonly brands = signal<Brand[]>([]);
  protected readonly tone = productTone;
  protected readonly status = (s: ProductStatus) => PRODUCT_STATUS[s] ?? s;
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'productType',
      label: 'Tipo',
      options: Object.entries(PRODUCT_TYPE).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(PRODUCT_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'categoryId',
      label: 'Categoria',
      options: categoryPaths(this.categories()).map((c) => ({ value: c.id, label: c.label })),
    },
    {
      key: 'brandId',
      label: 'Marca',
      options: this.brands().map((b) => ({ value: b.id, label: b.name })),
    },
  ]);
  protected readonly columns: Column<Product>[] = [
    {
      key: 'sku',
      label: 'SKU',
      sortable: true,
      required: true,
      link: (p) => ['/inventario/produtos', p.id],
    },
    { key: 'name', label: 'Nome', sortable: true },
    { key: 'productType', label: 'Tipo', value: (p) => PRODUCT_TYPE[p.productType] },
    {
      key: 'category',
      label: 'Categoria',
      hideOnMobile: true,
      value: (p) => p.category?.name ?? null,
    },
    {
      key: 'brand',
      label: 'Marca',
      hideOnMobile: true,
      hiddenByDefault: true,
      value: (p) => p.brand?.name ?? null,
    },
    { key: 'baseUom', label: 'Unidade', hideOnMobile: true, value: (p) => p.baseUom.code },
    { key: 'barcode', label: 'Código de barras', hideOnMobile: true, hiddenByDefault: true },
    {
      key: 'salePrice',
      label: 'Preço',
      align: 'end',
      hideOnMobile: true,
      value: (p) => (p.salePrice ? priceLabel(p.salePrice, p.currency) : null),
    },
    { key: 'status', label: 'Estado', value: (p) => this.status(p.status) },
  ];
  protected readonly list = new ListState<Product>(this.api, {
    url: 'inventory/products',
    filterKeys: ['productType', 'status', 'categoryId', 'brandId'],
    sortFields: ['sku', 'name', 'createdAt'],
    limit: 25,
  });

  constructor() {
    this.api.get<Category[]>('inventory/settings/categories').then(
      (c) => this.categories.set(c),
      () => undefined,
    );
    this.api.get<Brand[]>('inventory/settings/brands').then(
      (b) => this.brands.set(b),
      () => undefined,
    );
  }

  protected async export(columns: Column<Product>[]) {
    this.exporting.set(true);
    try {
      const n = await exportList(
        this.api,
        'inventory/products',
        withoutPaging(this.list.query()),
        columns,
        'produtos.csv',
      );
      this.toasts.show(`Exportados ${n} produto(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
