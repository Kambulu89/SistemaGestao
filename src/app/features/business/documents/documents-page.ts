import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PermissionService } from '../../../core/permissions/permission.service';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { LibraryTab } from './library-tab';
import { TemplatesTab } from './templates-tab';

type TabId = 'library' | 'templates';

const TABS: readonly { id: TabId; label: string; permission: string }[] = [
  { id: 'library', label: 'Biblioteca', permission: 'document.read' },
  { id: 'templates', label: 'Modelos', permission: 'template.read' },
];

/** Documentos, anexos e modelos (S01) sobre a API real. */
@Component({
  selector: 'app-documents-page',
  imports: [PageHeader, LibraryTab, TemplatesTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Documentos"
      description="Biblioteca com versões, ficheiros verificados antes de ficarem disponíveis e modelos que geram documentos em PDF."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Documentos">
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
      @case ('library') {
        <app-documents-library />
      }
      @case ('templates') {
        <app-documents-templates />
      }
    }
  `,
})
export class DocumentsPage {
  private readonly permissions = inject(PermissionService);

  protected readonly tabs = computed(() => TABS.filter((t) => this.permissions.can(t.permission)));
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'library',
  );
}
