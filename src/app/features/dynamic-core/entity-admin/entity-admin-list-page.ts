import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { hasErrors } from '../../../core/dynamic/engine/definition-integrity';
import { buttonClasses } from '../../../shared/ui/button/button';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';

interface Row {
  readonly key: string;
  readonly name: string;
  readonly scope: 'global' | 'tenant';
  readonly version: string;
  readonly fields: number;
  readonly statuses: number;
  readonly versions: number;
  readonly valid: boolean;
  readonly canOpenRecords: boolean;
}

/** Configuração → Core Dinâmico: as entidades configuráveis do tenant, globais e próprias. */
@Component({
  selector: 'app-entity-admin-list-page',
  imports: [PageHeader, Card, Table, Badge, EmptyState, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Core Dinâmico"
      description="Entidades configuráveis deste tenant. Cada formulário, listagem, validação e fluxo é gerado a partir da definição (metadados), sem código específico."
    >
      @if (canManage()) {
        <div pageActions>
          <a routerLink="novo" [class]="newButtonClasses">Nova entidade</a>
        </div>
      }
    </app-page-header>

    <app-card [flush]="true">
      @if (rows().length === 0) {
        <app-empty-state
          icon="cube"
          title="Ainda não há entidades"
          description="As definições publicadas aparecem aqui."
        />
      } @else {
        <app-table caption="Entidades configuráveis" [columns]="columns" [rows]="rows()">
          <ng-template let-row let-column="column">
            @switch (column.key) {
              @case ('name') {
                <a
                  [routerLink]="row.key"
                  class="font-medium text-brand-700 hover:underline dark:text-brand-300"
                  >{{ row.name }}</a
                >
                <code class="ms-2 text-xs text-fg-muted">{{ row.key }}</code>
              }
              @case ('scope') {
                <app-badge [tone]="row.scope === 'global' ? 'brand' : 'neutral'">{{
                  row.scope === 'global' ? 'Global' : 'Do tenant'
                }}</app-badge>
              }
              @case ('valid') {
                <app-badge [tone]="row.valid ? 'success' : 'danger'">{{
                  row.valid ? 'Íntegra' : 'Com erros'
                }}</app-badge>
              }
              @case ('records') {
                @if (row.canOpenRecords) {
                  <a
                    [routerLink]="dataLink(row.key)"
                    class="text-brand-700 hover:underline dark:text-brand-300"
                    >Ver registos</a
                  >
                } @else {
                  —
                }
              }
              @default {
                {{ row[column.key] }}
              }
            }
          </ng-template>
        </app-table>
      }
    </app-card>
  `,
})
export class EntityAdminListPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly access = inject(EntityAccessService);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  /** Os registos de uma entidade (caminho absoluto: não depende de onde esta página está montada). */
  protected dataLink(key: string): string[] {
    return ['/t', this.tenant()?.slug ?? '', 'data', key];
  }
  protected readonly canManage = computed(() => this.permissions.can('configuration.forms.manage'));
  protected readonly newButtonClasses = buttonClasses('primary', 'md');

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Entidade' },
    { key: 'scope', label: 'Âmbito' },
    { key: 'version', label: 'Versão' },
    { key: 'fields', label: 'Campos' },
    { key: 'statuses', label: 'Estados' },
    { key: 'valid', label: 'Integridade' },
    { key: 'records', label: 'Dados', align: 'end' },
  ];

  protected readonly rows = computed<readonly Row[]>(() =>
    this.registry.published().map((entity) => ({
      key: entity.key,
      name: entity.names.plural,
      scope: entity.scope,
      version: `v${entity.version}`,
      fields: entity.fields.filter((f) => !f.archived).length,
      statuses: entity.statuses.length,
      versions: this.registry.versionsOf(entity.key).length,
      valid: !hasErrors(this.registry.issues().get(entity.key) ?? []),
      canOpenRecords: this.access.can(entity, 'read'),
    })),
  );
}
