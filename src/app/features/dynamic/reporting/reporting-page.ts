import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../core/permissions/permission.service';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { DashboardsTab } from './dashboards-tab';
import { ExportsTab } from './exports-tab';
import { ReportsTab } from './reports-tab';

type TabId = 'dashboards' | 'reports' | 'exports';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'dashboards', label: 'Painéis', permission: 'report.read' },
  { id: 'reports', label: 'Relatórios', permission: 'report.read' },
  { id: 'exports', label: 'Exportações', permission: 'report.export' },
];

/** Relatórios, painéis e exportações (S04) sobre a API real. */
@Component({
  selector: 'app-reporting-page',
  imports: [PageHeader, DashboardsTab, ReportsTab, ExportsTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Relatórios e painéis"
      description="Consultas sobre dados autorizados, painéis com indicadores e exportações em CSV. Os dados são lidos em tempo real."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Relatórios">
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
      @case ('dashboards') {
        <app-dashboards-tab />
      }
      @case ('reports') {
        <app-reports-tab />
      }
      @case ('exports') {
        <app-exports-tab />
      }
    }
  `,
})
export class ReportingPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'dashboards',
  );
}
