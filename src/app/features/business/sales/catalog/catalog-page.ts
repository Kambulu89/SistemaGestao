import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { CategoriesTab } from './categories-tab';
import { PricesTab } from './prices-tab';
import { ProductsTab } from './products-tab';

type TabId = 'products' | 'categories' | 'prices';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'products', label: 'Produtos', permission: 'catalog.read' },
  { id: 'categories', label: 'Categorias', permission: 'catalog.read' },
  { id: 'prices', label: 'Tabelas de preços', permission: 'price.read' },
];

/** Catálogo e preços (M03): produtos com variantes, categorias e tabelas de preços sobre a API real. */
@Component({
  selector: 'app-catalog-page',
  imports: [PageHeader, ProductsTab, CategoriesTab, PricesTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Catálogo e preços"
      description="Produtos, serviços e variantes; tabelas de preços por organização, moeda e período."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Catálogo">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="-mb-px border-b-2 px-4 py-2 text-sm font-medium"
          [class.border-brand-600]="active() === tab.id"
          [class.text-brand-700]="active() === tab.id"
          [class.border-transparent]="active() !== tab.id"
          [class.text-fg-muted]="active() !== tab.id"
          [attr.aria-selected]="active() === tab.id"
          [attr.data-testid]="'tab-' + tab.id"
          (click)="selected.set(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </div>
    @switch (active()) {
      @case ('products') {
        <app-catalog-products />
      }
      @case ('categories') {
        <app-catalog-categories />
      }
      @case ('prices') {
        <app-catalog-prices />
      }
    }
  `,
})
export class CatalogPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'products',
  );
}
