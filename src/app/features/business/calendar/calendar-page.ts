import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../core/permissions/permission.service';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { AgendaTab } from './agenda-tab';
import { BusinessHoursTab } from './business-hours-tab';
import { ResourcesTab } from './resources-tab';

type TabId = 'agenda' | 'resources' | 'hours';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'agenda', label: 'Agenda', permission: 'calendar.read' },
  { id: 'resources', label: 'Recursos e reservas', permission: 'resource.read' },
  { id: 'hours', label: 'Horário útil', permission: 'calendar.read' },
];

/** Calendário, recursos e reservas (S03) sobre a API real. */
@Component({
  selector: 'app-calendar-page',
  imports: [PageHeader, AgendaTab, ResourcesTab, BusinessHoursTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Calendário e agendamentos"
      description="Eventos com repetição e fusos horários, participantes, salas e equipamentos que não se sobrepõem, e horário útil."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Calendário">
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
      @case ('agenda') {
        <app-agenda-tab />
      }
      @case ('resources') {
        <app-resources-tab />
      }
      @case ('hours') {
        <app-business-hours-tab />
      }
    }
  `,
})
export class CalendarPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'agenda',
  );
}
