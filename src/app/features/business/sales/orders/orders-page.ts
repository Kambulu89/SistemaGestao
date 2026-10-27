import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { OrdersTab } from './orders-tab';
import { QuotesTab } from './quotes-tab';

type TabId = 'quotes' | 'orders';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'quotes', label: 'Propostas', permission: 'quote.read' },
  { id: 'orders', label: 'Encomendas', permission: 'order.read' },
];

/** Propostas e encomendas de venda (M04): preços e impostos em instantâneo; confirmar não reserva nem expede. */
@Component({
  selector: 'app-orders-page',
  imports: [PageHeader, QuotesTab, OrdersTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Propostas e encomendas"
      description="Propostas comerciais, conversão em encomendas e confirmação. Os preços e impostos ficam congelados no documento."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Vendas">
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
      @case ('quotes') {
        <app-sales-quotes />
      }
      @case ('orders') {
        <app-sales-orders />
      }
    }
  `,
})
export class OrdersPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'quotes',
  );
}
