import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { PurchasesTab } from './purchases-tab';
import { ReceiptsTab } from './receipts-tab';
import { RequisitionsTab } from './requisitions-tab';
import { SuppliersTab } from './suppliers-tab';

type TabId = 'suppliers' | 'requisitions' | 'orders' | 'receipts';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'suppliers', label: 'Fornecedores', permission: 'supplier.read' },
  { id: 'requisitions', label: 'Requisições', permission: 'requisition.read' },
  { id: 'orders', label: 'Encomendas', permission: 'purchase.read' },
  { id: 'receipts', label: 'Recepções', permission: 'receipt.read' },
];

/** Compras (M06): confirmar uma encomenda não recebe; só uma recepção lançada dá entrada do stock. */
@Component({
  selector: 'app-purchasing-page',
  imports: [PageHeader, SuppliersTab, RequisitionsTab, PurchasesTab, ReceiptsTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Compras"
      description="Fornecedores, requisições, encomendas e recepções. A entrada de stock acontece ao lançar a recepção."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Compras">
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
      @case ('suppliers') {
        <app-purchasing-suppliers />
      }
      @case ('requisitions') {
        <app-purchasing-requisitions />
      }
      @case ('orders') {
        <app-purchasing-orders />
      }
      @case ('receipts') {
        <app-purchasing-receipts />
      }
    }
  `,
})
export class PurchasingPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'suppliers',
  );
}
