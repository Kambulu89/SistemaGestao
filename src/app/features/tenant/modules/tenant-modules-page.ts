import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ModuleAccessStatus } from '../../../core/modules/module-access';
import { ACCESS_LABELS, LIFECYCLE_LABELS } from '../../../core/modules/module-labels';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import type { ModuleLifecycle } from '../../../core/modules/module.model';
import { TenantModulesService } from '../../../core/modules/tenant-modules.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly version: string;
  readonly lifecycle: ModuleLifecycle;
  readonly contracted: string;
  readonly active: string;
  readonly access: ModuleAccessStatus;
  readonly link: string | null;
}

/**
 * Cada módulo do catálogo e porque está (ou não) disponível para si:
 * contratado → activado → dependências → feature flag → autorizado.
 */
@Component({
  selector: 'app-tenant-modules-page',
  imports: [PageHeader, Card, Table, Badge, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Módulos"
      description="Estado de cada módulo neste tenant. Contratado (subscrição), activado (decisão do tenant) e autorizado (o seu perfil) são coisas diferentes."
    />

    @for (group of groups(); track group.id) {
      <section class="mb-6" [attr.aria-label]="group.name">
        <h2 class="mb-2 text-base font-semibold">{{ group.name }}</h2>
        <app-card [flush]="true">
          <app-table
            [caption]="'Módulos do grupo ' + group.name"
            [columns]="columns"
            [rows]="group.rows"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  @if (row.link) {
                    <a
                      [routerLink]="row.link"
                      class="font-medium text-brand-700 hover:underline dark:text-brand-300"
                      >{{ row.name }}</a
                    >
                  } @else {
                    <span class="font-medium">{{ row.name }}</span>
                  }
                  <code class="ms-2 text-xs text-fg-muted">{{ row.code }}</code>
                }
                @case ('lifecycle') {
                  <app-badge [tone]="lifecycle(row.lifecycle).tone">{{
                    lifecycle(row.lifecycle).label
                  }}</app-badge>
                }
                @case ('access') {
                  <app-badge [tone]="access(row.access).tone">{{
                    access(row.access).label
                  }}</app-badge>
                  <span class="sr-only">{{ access(row.access).hint }}</span>
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
  `,
})
export class TenantModulesPage {
  private readonly registry = inject(ModuleRegistryService);
  private readonly modules = inject(TenantModulesService);
  private readonly slug = inject(TenantContextService).tenant;

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Módulo' },
    { key: 'version', label: 'Versão' },
    { key: 'lifecycle', label: 'Ciclo de vida' },
    { key: 'contracted', label: 'Contratado' },
    { key: 'active', label: 'Activado' },
    { key: 'access', label: 'Resultado' },
  ];

  protected readonly groups = computed(() => {
    const resolved = this.modules.resolved();
    const slug = this.slug()?.slug;
    return this.registry.groups
      .map((group) => ({
        ...group,
        rows: resolved
          .filter((r) => r.manifest.groupId === group.id)
          .map<Row>(({ manifest, access, contracted, active }) => ({
            id: manifest.id,
            name: manifest.name,
            code: manifest.code,
            version: manifest.version,
            lifecycle: manifest.lifecycle,
            contracted: contracted ? 'Sim' : 'Não',
            active: active ? 'Sim' : 'Não',
            access,
            link: access === 'accessible' && slug ? `/t/${slug}/${manifest.basePath}` : null,
          })),
      }))
      .filter((g) => g.rows.length > 0);
  });

  protected lifecycle(value: ModuleLifecycle) {
    return LIFECYCLE_LABELS[value];
  }

  protected access(value: ModuleAccessStatus) {
    return ACCESS_LABELS[value];
  }
}
