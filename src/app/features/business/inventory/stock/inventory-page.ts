import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { LotsTab } from './lots-tab';
import { MovementsTab } from './movements-tab';
import { ReservationsTab } from './reservations-tab';
import { StockTab } from './stock-tab';
import { WarehousesTab } from './warehouses-tab';

type TabId = 'stock' | 'movements' | 'reservations' | 'warehouses' | 'lots';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'stock', label: 'Stock' },
  { id: 'movements', label: 'Movimentos' },
  { id: 'reservations', label: 'Reservas' },
  { id: 'warehouses', label: 'Armazéns' },
  { id: 'lots', label: 'Lotes' },
];

/** Inventário (M07): stock, livro de movimentos, reservas, armazéns e lotes sobre a API real. */
@Component({
  selector: 'app-inventory-page',
  imports: [PageHeader, StockTab, MovementsTab, ReservationsTab, WarehousesTab, LotsTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Armazéns e stock"
      description="Saldos por local e lote, livro de movimentos, reservas e armazéns. O saldo só muda por movimentos."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Inventário">
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
      @case ('stock') {
        <app-inventory-stock (history)="showHistory($event)" />
      }
      @case ('movements') {
        <app-inventory-movements [filterVariantId]="historyOf()" />
      }
      @case ('reservations') {
        <app-inventory-reservations />
      }
      @case ('warehouses') {
        <app-inventory-warehouses />
      }
      @case ('lots') {
        <app-inventory-lots />
      }
    }
  `,
})
export class InventoryPage {
  private readonly permissions = inject(PermissionService);

  // Todos os separadores precisam de `inventory.read`; as acções de escrita pedem a sua própria permissão.
  protected readonly tabs = computed(() => (this.permissions.can('inventory.read') ? TABS : []));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly historyOf = signal<string | null>(null);
  protected readonly active = computed<TabId>(() => this.selected() ?? 'stock');

  protected showHistory(variantId: string): void {
    this.historyOf.set(variantId);
    this.selected.set('movements');
  }
}
