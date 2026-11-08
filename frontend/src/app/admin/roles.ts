import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { Icon } from '../ui/icon';
import { Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import type { Role } from './rbac-types';

/** Perfis (EntityListPage): lista completa, colunas configuráveis. */
@Component({
  selector: 'app-roles',
  imports: [RouterLink, EntityListPage, DataTable, CellDef, StatusBadge, Icon],
  template: `
    <app-entity-list-page
      title="Perfis"
      subtitle="Conjuntos de permissões atribuídos aos membros."
      permission="roles.read"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/perfis/novo"
          ><app-icon name="plus" [size]="16" />Novo perfil</a
        >
      }
      <app-data-table
        label="Perfis"
        tableId="roles"
        [columns]="columns"
        [rows]="roles.value() ?? []"
        [total]="(roles.value() ?? []).length"
        [limit]="1000"
        [loading]="roles.loading()"
        [error]="roles.error()"
        emptyText="Sem perfis."
        (retry)="roles.load()"
      >
        <ng-template appCell="name" let-row>
          <a class="btn-link" [routerLink]="['/perfis', row.id]">{{ row.name }}</a>
          @if (row.isSystem) {
            <span class="badge ml-1 bg-surface-2 text-muted">Sistema</span>
          }
        </ng-template>
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Roles {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.can('roles.manage'));
  protected readonly columns: Column<Role>[] = [
    { key: 'name', label: 'Nome', required: true },
    { key: 'code', label: 'Código', hideOnMobile: true },
    {
      key: 'permissions',
      label: 'Permissões',
      value: (r) => r.permissionCodes.length,
      align: 'end',
    },
    { key: 'status', label: 'Estado' },
  ];
  protected readonly roles = new Loadable(() => this.api.get<Role[]>('roles'));

  constructor() {
    void this.roles.load();
  }
}
