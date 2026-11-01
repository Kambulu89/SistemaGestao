import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { ContractsTab } from './contracts-tab';
import { CreditNotesTab } from './credit-notes-tab';
import { InvoicesTab } from './invoices-tab';

type TabId = 'invoices' | 'credit-notes' | 'contracts';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'invoices', label: 'Facturas', permission: 'invoice.read' },
  { id: 'credit-notes', label: 'Notas de crédito', permission: 'invoice.read' },
  { id: 'contracts', label: 'Contratos', permission: 'contract.read' },
];

/** Contratos e facturação (M05): emitir uma factura é distinto de confirmar, expedir e receber; uma emitida só se corrige com uma nota de crédito. */
@Component({
  selector: 'app-billing-page',
  imports: [PageHeader, InvoicesTab, CreditNotesTab, ContractsTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Facturação e contratos"
      description="Facturas, notas de crédito e contratos. Ao emitir, o número, o cliente e os valores ficam fixados."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Facturação">
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
      @case ('invoices') {
        <app-billing-invoices />
      }
      @case ('credit-notes') {
        <app-billing-credit-notes />
      }
      @case ('contracts') {
        <app-billing-contracts />
      }
    }
  `,
})
export class BillingPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'invoices',
  );
}
