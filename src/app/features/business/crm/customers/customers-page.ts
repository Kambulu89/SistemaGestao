import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { CustomersTab } from './customers-tab';
import { SegmentsTab } from './segments-tab';

type TabId = 'customers' | 'segments';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'customers', label: 'Clientes' },
  { id: 'segments', label: 'Segmentos' },
];

/** Clientes e relacionamento comercial (M01): condições comerciais sobre a Party, segmentos e interacções. */
@Component({
  selector: 'app-customers-page',
  imports: [PageHeader, CustomersTab, SegmentsTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Clientes"
      description="Condições comerciais, segmentos e interacções sobre as pessoas e organizações do tenant."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Clientes">
      @for (tab of tabs; track tab.id) {
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
      @case ('customers') {
        <app-customers />
      }
      @case ('segments') {
        <app-customer-segments />
      }
    }
  `,
})
export class CustomersPage {
  protected readonly tabs = TABS;
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(() => this.selected() ?? 'customers');
}
