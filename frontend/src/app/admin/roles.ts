import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { ErrorAlert } from '../ui/error-alert';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import type { Role } from './rbac-types';

@Component({
  selector: 'app-roles',
  imports: [RouterLink, PageHeader, ErrorAlert, StatusBadge],
  template: `
    <app-page-header title="Perfis" subtitle="Conjuntos de permissões atribuídos aos membros.">
      @if (canManage()) {
        <a class="btn-primary" routerLink="/perfis/novo">Novo perfil</a>
      }
    </app-page-header>
    <app-error-alert [error]="roles.error()" />
    @if (roles.loading()) {
      <p class="text-sm text-slate-500">A carregar…</p>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Perfis">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Código</th>
              <th>Permissões</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            @for (r of roles.value(); track r.id) {
              <tr>
                <td>
                  <a class="btn-link" [routerLink]="['/perfis', r.id]">{{ r.name }}</a>
                  @if (r.isSystem) {
                    <span class="badge ml-1 bg-slate-100 text-slate-700">Sistema</span>
                  }
                </td>
                <td class="font-mono text-xs">{{ r.code }}</td>
                <td>{{ r.permissionCodes.length }}</td>
                <td><app-status-badge [status]="r.status" /></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class Roles {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.can('roles.manage'));
  protected readonly roles = new Loadable(() => this.api.get<Role[]>('roles'));

  constructor() {
    void this.roles.load();
  }
}
