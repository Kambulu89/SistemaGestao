import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { PreferencesTab } from './preferences-tab';
import { SequencesTab } from './sequences-tab';
import { TaxRatesTab } from './tax-rates-tab';
import { UnitsTab } from './units-tab';

type TabId = 'preferences' | 'taxes' | 'units' | 'sequences';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'preferences', label: 'Preferências' },
  { id: 'taxes', label: 'Impostos' },
  { id: 'units', label: 'Unidades' },
  { id: 'sequences', label: 'Sequências' },
];

/** Configurações do tenant (C09): preferências com herança, impostos, unidades de medida e sequências. */
@Component({
  selector: 'app-tenant-settings',
  imports: [PageHeader, PreferencesTab, TaxRatesTab, UnitsTab, SequencesTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Configurações"
      description="Preferências com herança, impostos por organização, unidades de medida e numeração de documentos."
    />

    <div
      role="tablist"
      aria-label="Secções das configurações"
      class="mb-4 flex gap-1 border-b border-line"
    >
      @for (tab of tabs; track tab.id) {
        <button
          type="button"
          role="tab"
          [id]="'settings-tab-' + tab.id"
          [attr.aria-selected]="active() === tab.id"
          [attr.aria-controls]="'settings-panel-' + tab.id"
          class="-mb-px border-b-2 px-3 py-2 text-sm font-medium"
          [class.border-brand-600]="active() === tab.id"
          [class.text-brand-700]="active() === tab.id"
          [class.border-transparent]="active() !== tab.id"
          [class.text-fg-muted]="active() !== tab.id"
          (click)="active.set(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </div>

    <div
      role="tabpanel"
      [id]="'settings-panel-' + active()"
      [attr.aria-labelledby]="'settings-tab-' + active()"
    >
      @switch (active()) {
        @case ('preferences') {
          <app-settings-preferences />
        }
        @case ('taxes') {
          <app-settings-tax-rates />
        }
        @case ('units') {
          <app-settings-units />
        }
        @case ('sequences') {
          <app-settings-sequences />
        }
      }
    </div>
  `,
})
export class TenantSettings {
  protected readonly tabs = TABS;
  protected readonly active = signal<TabId>('preferences');
}
