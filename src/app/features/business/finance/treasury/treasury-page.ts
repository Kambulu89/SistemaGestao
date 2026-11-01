import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { AccountsTab } from './accounts-tab';
import { ObligationsTab } from './obligations-tab';
import { PaymentsTab } from './payments-tab';
import { ReconciliationTab } from './reconciliation-tab';
import { SupplierInvoicesTab } from './supplier-invoices-tab';

type TabId = 'accounts' | 'receivables' | 'payables' | 'payments' | 'invoices' | 'reconciliation';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'accounts', label: 'Contas', permission: 'treasury.read' },
  { id: 'receivables', label: 'A receber', permission: 'receivable.read' },
  { id: 'payables', label: 'A pagar', permission: 'payable.read' },
  { id: 'payments', label: 'Pagamentos', permission: 'payment.read' },
  { id: 'invoices', label: 'Facturas de fornecedor', permission: 'supplier_invoice.read' },
  { id: 'reconciliation', label: 'Conciliação', permission: 'reconciliation.read' },
];

/** Tesouraria (M09): confirmar um pagamento é a única operação que move dinheiro; reverte-se, nunca se apaga. */
@Component({
  selector: 'app-treasury-page',
  imports: [
    PageHeader,
    AccountsTab,
    ObligationsTab,
    PaymentsTab,
    SupplierInvoicesTab,
    ReconciliationTab,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Tesouraria"
      description="Contas de caixa e banco, contas a receber e a pagar, pagamentos, facturas de fornecedor e conciliação bancária."
    />
    <div
      class="mb-5 flex flex-wrap gap-1 border-b border-line"
      role="tablist"
      aria-label="Tesouraria"
    >
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
      @case ('accounts') {
        <app-finance-accounts />
      }
      @case ('receivables') {
        <app-finance-obligations kind="receivable" />
      }
      @case ('payables') {
        <app-finance-obligations kind="payable" />
      }
      @case ('payments') {
        <app-finance-payments />
      }
      @case ('invoices') {
        <app-finance-supplier-invoices />
      }
      @case ('reconciliation') {
        <app-finance-reconciliation />
      }
    }
  `,
})
export class TreasuryPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'accounts',
  );
}
