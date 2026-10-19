import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { entityPermissionDefinitions } from '../../../core/dynamic/engine/entity-permissions';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';

/** Catálogo de permissões declaradas pelos módulos e quais o seu perfil concede. */
@Component({
  selector: 'app-tenant-permissions-page',
  imports: [PageHeader, Card, Table, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Permissões"
      [description]="
        'Perfil actual: ' +
        (role() ?? '—') +
        '. Cada módulo declara as suas permissões; a atribuição por perfil (RBAC/ABAC) será construída com o backend.'
      "
    />

    @for (group of allGroups(); track group.id) {
      <section class="mb-6" [attr.aria-label]="group.name">
        <h2 class="mb-2 text-base font-semibold">{{ group.name }}</h2>
        <app-card [flush]="true">
          <app-table
            [caption]="'Permissões do grupo ' + group.name"
            [columns]="columns"
            [rows]="group.rows"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('key') {
                  <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{{ row.key }}</code>
                }
                @case ('granted') {
                  <app-badge [tone]="row.granted ? 'success' : 'neutral'">{{
                    row.granted ? 'Concedida' : 'Não concedida'
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
  `,
})
export class TenantPermissionsPage {
  private readonly registry = inject(ModuleRegistryService);
  private readonly entities = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly tenantContext = inject(TenantContextService);

  protected readonly role = computed(() => this.tenantContext.active()?.roleName);

  protected readonly columns: readonly TableColumn[] = [
    { key: 'key', label: 'Permissão' },
    { key: 'name', label: 'Descrição' },
    { key: 'module', label: 'Módulo' },
    { key: 'granted', label: 'Estado' },
  ];

  protected readonly groups = computed(() =>
    this.registry.groups
      .map((group) => ({
        ...group,
        rows: this.registry.inGroup(group.id).flatMap((m) =>
          m.scope === 'tenant'
            ? m.permissions.map((p) => ({
                key: p.key,
                name: p.name,
                module: m.name,
                granted: this.permissions.can(p.key),
              }))
            : [],
        ),
      }))
      .filter((g) => g.rows.length > 0),
  );

  /** Permissões das entidades dinâmicas: as mesmas chaves do IAM, declaradas pelas definições. */
  protected readonly allGroups = computed(() => [...this.groups(), ...this.entityGroups()]);

  protected readonly entityGroups = computed(() =>
    this.entities.published().map((entity) => ({
      id: `entity-${entity.key}`,
      name: `Entidade: ${entity.names.plural}`,
      rows: entityPermissionDefinitions(entity).map((p) => ({
        key: p.key,
        name: p.name,
        module: 'Core Dinâmico',
        granted: this.permissions.can(p.key),
      })),
    })),
  );
}
