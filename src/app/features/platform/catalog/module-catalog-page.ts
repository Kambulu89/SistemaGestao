import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { KIND_LABELS, LIFECYCLE_LABELS, SCOPE_LABELS } from '../../../core/modules/module-labels';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import type { ModuleLifecycle } from '../../../core/modules/module.model';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';

interface CatalogRow {
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly scope: string;
  readonly version: string;
  readonly lifecycle: ModuleLifecycle;
  readonly dependencies: string;
}

/** Catálogo global: todas as capacidades registadas, por grupo funcional. */
@Component({
  selector: 'app-module-catalog-page',
  imports: [PageHeader, Card, Table, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header title="Catálogo de módulos" [description]="summary()" />

    <div class="space-y-6">
      @for (group of groups(); track group.id) {
        <section [attr.aria-label]="group.name">
          <div class="mb-2">
            <h2 class="text-base font-semibold">{{ group.name }}</h2>
            <p class="text-sm text-fg-muted">{{ group.description }}</p>
          </div>
          <app-card [flush]="true">
            <app-table
              [caption]="'Módulos do grupo ' + group.name"
              [columns]="columns"
              [rows]="group.rows"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('code') {
                    <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{{
                      row.code
                    }}</code>
                  }
                  @case ('kind') {
                    <app-badge [tone]="row.kind === 'Fundação' ? 'brand' : 'neutral'">{{
                      row.kind
                    }}</app-badge>
                  }
                  @case ('lifecycle') {
                    <app-badge [tone]="lifecycle(row.lifecycle).tone">{{
                      lifecycle(row.lifecycle).label
                    }}</app-badge>
                  }
                  @default {
                    {{ row[column.key] }}
                  }
                }
              </ng-template>
            </app-table>
          </app-card>
        </section>
      }
    </div>
  `,
})
export class ModuleCatalogPage {
  private readonly registry = inject(ModuleRegistryService);

  protected readonly columns: readonly TableColumn[] = [
    { key: 'code', label: 'Código' },
    { key: 'name', label: 'Nome' },
    { key: 'kind', label: 'Tipo' },
    { key: 'scope', label: 'Âmbito' },
    { key: 'version', label: 'Versão' },
    { key: 'lifecycle', label: 'Ciclo de vida' },
    { key: 'dependencies', label: 'Depende de' },
  ];

  protected readonly groups = computed(() =>
    this.registry.groups
      .map((group) => ({
        ...group,
        rows: this.registry.inGroup(group.id).map<CatalogRow>((m) => ({
          code: m.code,
          name: m.name,
          kind: KIND_LABELS[m.kind],
          scope: SCOPE_LABELS[m.scope],
          version: m.version,
          lifecycle: m.lifecycle,
          dependencies:
            m.dependencies.map((id) => this.registry.find(id)?.code ?? id).join(', ') || '—',
        })),
      }))
      .filter((g) => g.rows.length > 0),
  );

  protected readonly summary = computed(() => {
    const all = this.registry.modules;
    const foundation = all.filter((m) => m.kind === 'foundation').length;
    return `${all.length} capacidades em ${this.groups().length} grupos: ${foundation} de fundação (sempre activas) e ${all.length - foundation} módulos contratáveis por tenant.`;
  });

  protected lifecycle(value: ModuleLifecycle) {
    return LIFECYCLE_LABELS[value];
  }
}
