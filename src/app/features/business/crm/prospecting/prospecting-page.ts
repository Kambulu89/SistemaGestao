import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { PageHeader } from '../../../../shared/ui/page-header/page-header';
import { CampaignsTab } from './campaigns-tab';
import { LeadsTab } from './leads-tab';
import { PipelineTab } from './pipeline-tab';

type TabId = 'leads' | 'pipeline' | 'campaigns';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'leads', label: 'Leads', permission: 'crm.read' },
  { id: 'pipeline', label: 'Pipeline', permission: 'crm.read' },
  { id: 'campaigns', label: 'Campanhas', permission: 'crm.read' },
];

/** Prospecção e CRM (M02): leads, pipeline de oportunidades e campanhas, sobre a API real. */
@Component({
  selector: 'app-prospecting-page',
  imports: [PageHeader, LeadsTab, PipelineTab, CampaignsTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Leads e oportunidades"
      description="Prospecção, funil comercial e campanhas. Converter uma lead cria o cliente e a oportunidade; quem recusa comunicações nunca é contactado."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Prospecção">
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
      @case ('leads') {
        <app-prospecting-leads />
      }
      @case ('pipeline') {
        <app-prospecting-pipeline />
      }
      @case ('campaigns') {
        <app-prospecting-campaigns />
      }
    }
  `,
})
export class ProspectingPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'leads',
  );
}
