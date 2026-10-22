import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { errorMessage } from '../../../core/api/error-message';
import { entityPermissionDefinitions } from '../../../core/dynamic/engine/entity-permissions';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { IamApi } from '../data-access/iam.api';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';

/** Catálogo de permissões declaradas pelos módulos e quais o seu perfil concede. */
@Component({
  selector: 'app-tenant-permissions-page',
  imports: [PageHeader, Card, Table, Badge, Alert, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Permissões"
      [description]="'Perfis do servidor e permissões declaradas pelos módulos. O servidor decide sempre; esta lista é só informativa.'"
    />

    @if (canReadRoles()) {
      <section class="mb-6" aria-label="Perfis">
        <h2 class="mb-2 text-base font-semibold">Perfis</h2>
        <app-card [flush]="true">
          @if (roles.isLoading() && !roles.hasValue()) {
            <app-loading-state label="A carregar perfis…" />
          } @else if (roles.error()) {
            <div class="p-5">
              <app-alert tone="danger" title="Não foi possível carregar os perfis">
                {{ rolesError() }}
              </app-alert>
            </div>
          } @else {
            <app-table caption="Perfis da organização" [columns]="roleColumns" [rows]="roleRows()">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                    <code class="ms-2 rounded bg-surface-muted px-1.5 py-0.5 text-xs">{{
                      row.code
                    }}</code>
                    @if (row.isSystem) {
                      <app-badge class="ms-2">Sistema</app-badge>
                    }
                  }
                  @case ('permissions') {
                    {{ row.permissions }}
                  }
                }
              </ng-template>
            </app-table>
          }
        </app-card>
      </section>
    }

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

  private readonly api = inject(IamApi);

  protected readonly canReadRoles = computed(() => this.permissions.can('iam.read'));
  protected readonly roleColumns: readonly TableColumn[] = [
    { key: 'name', label: 'Perfil' },
    { key: 'permissions', label: 'Permissões' },
  ];
  protected readonly roles = rxResource({
    params: () => (this.canReadRoles() ? this.tenantContext.tenant()?.id : undefined),
    stream: () => this.api.listRoles(),
  });
  protected readonly roleRows = computed(() =>
    (this.roles.hasValue() ? this.roles.value() : []).map((r) => ({
      ...r,
      permissions: r.permissionCodes.join(', ') || '—',
    })),
  );
  protected rolesError(): string {
    return errorMessage(this.roles.error());
  }

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
