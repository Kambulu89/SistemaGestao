import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { detailedErrorMessage, errorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { IamApi, type PermissionDto, type RoleDto } from '../data-access/iam.api';
import { groupPermissions, toggleCode } from './roles-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Perfil' },
  { key: 'permissions', label: 'Permissões' },
  { key: 'actions', label: '', align: 'end' },
];

/**
 * Perfis (papéis) do tenant: criar, alterar as permissões e apagar. Os perfis do sistema só se consultam. Quem pode
 * fazer o quê decide-o o servidor (o último administrador, por exemplo, nunca fica sem a permissão de gerir acessos).
 */
@Component({
  selector: 'app-roles-manager',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }

    @if (!editing()) {
      @if (canManage()) {
        <div class="mb-3 flex justify-end">
          <app-button (click)="startNew()">Novo perfil</app-button>
        </div>
      }
      <app-card [flush]="true">
        @if (roles.isLoading() && !roles.hasValue()) {
          <app-loading-state label="A carregar perfis…" />
        } @else if (roles.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar os perfis">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (roles.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="shield" title="Ainda não há perfis" />
          } @else {
            <app-table
              caption="Perfis do tenant"
              [columns]="columns"
              [rows]="list"
              data-testid="roles"
            >
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
                    @if (row.description) {
                      <span class="block text-xs text-fg-muted">{{ row.description }}</span>
                    }
                  }
                  @case ('permissions') {
                    {{ row.permissionCodes.length }}
                  }
                  @case ('actions') {
                    <span class="flex justify-end gap-2">
                      <app-button size="sm" variant="secondary" (click)="open(row)">{{
                        canManage() && !row.isSystem ? 'Editar' : 'Ver'
                      }}</app-button>
                      @if (canManage() && !row.isSystem) {
                        <app-button size="sm" variant="secondary" (click)="confirmDelete.set(row)"
                          >Apagar</app-button
                        >
                      }
                    </span>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>
    } @else {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">
          {{ editing()!.id ? name() : 'Novo perfil' }}
          @if (readOnly()) {
            <app-badge class="ms-2">Só leitura</app-badge>
          }
        </h2>
        @if (clientError(); as text) {
          <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
        }
        <div class="grid gap-4 sm:grid-cols-2">
          @if (!editing()!.id) {
            <app-input
              label="Código"
              [required]="true"
              hint="Minúsculas, números e _. Não muda depois de criado."
              [ngModel]="code()"
              (ngModelChange)="code.set($event ?? '')"
            />
          }
          <app-input
            label="Nome"
            [required]="true"
            [disabled]="readOnly()"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <div class="sm:col-span-2">
            <app-input
              label="Descrição"
              [disabled]="readOnly()"
              [ngModel]="description()"
              (ngModelChange)="description.set($event ?? '')"
            />
          </div>
        </div>

        <h3 class="mb-2 mt-6 text-sm font-semibold">
          Permissões ({{ selected().length }} de {{ catalogSize() }})
        </h3>
        @if (catalog.isLoading() && !catalog.hasValue()) {
          <app-loading-state label="A carregar permissões…" />
        } @else if (catalog.error()) {
          <app-alert tone="danger" title="Não foi possível carregar o catálogo de permissões">{{
            catalogError()
          }}</app-alert>
        } @else {
          <div class="grid gap-5 sm:grid-cols-2" data-testid="permission-groups">
            @for (group of groups(); track group.moduleCode) {
              <fieldset class="rounded-lg border border-line p-3">
                <legend class="px-1 text-xs font-semibold uppercase text-fg-muted">
                  {{ group.moduleCode }}
                </legend>
                @for (permission of group.permissions; track permission.code) {
                  <app-checkbox
                    [label]="permission.code"
                    [hint]="permission.description"
                    [disabled]="readOnly()"
                    [ngModel]="selected().includes(permission.code)"
                    (ngModelChange)="toggle(permission.code, !!$event)"
                  />
                }
              </fieldset>
            }
          </div>
        }

        <div class="mt-5 flex gap-2">
          @if (!readOnly()) {
            <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    }

    <app-dialog
      [open]="confirmDelete() !== null"
      title="Apagar perfil"
      (closed)="confirmDelete.set(null)"
    >
      O perfil «{{ confirmDelete()?.name }}» deixa de existir. Só se apaga um perfil sem
      atribuições.
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="confirmDelete.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="remove()">Apagar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class RolesManager {
  private readonly api = inject(IamApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantContext = inject(TenantContextService);

  protected readonly columns = COLUMNS;
  protected readonly canManage = computed(() => this.permissions.can('iam.manage'));

  private readonly reload = signal(0);
  protected readonly roles = rxResource({
    params: () => ({ tenant: this.tenantContext.tenant()?.id, reload: this.reload() }),
    stream: () => this.api.listRoles(),
  });
  protected readonly loadError = computed(() => errorMessage(this.roles.error()));

  protected readonly catalog = rxResource({
    params: () => this.tenantContext.tenant()?.id,
    stream: () => this.api.permissions(),
  });
  protected readonly catalogError = computed(() => errorMessage(this.catalog.error()));
  private readonly permissionList = computed<readonly PermissionDto[]>(() =>
    this.catalog.hasValue() ? this.catalog.value() : [],
  );
  protected readonly catalogSize = computed(() => this.permissionList().length);
  protected readonly groups = computed(() => groupPermissions(this.permissionList()));

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirmDelete = signal<RoleDto | null>(null);

  protected readonly editing = signal<{
    id: string | null;
    version: number;
    system: boolean;
  } | null>(null);
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly readOnly = computed(() => {
    const state = this.editing();
    return !this.canManage() || (state?.system ?? false);
  });

  private reset(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: done,
      error: (error: unknown) => this.actionError.set(detailedErrorMessage(error)),
    });
  }

  protected startNew(): void {
    this.reset();
    this.code.set('');
    this.name.set('');
    this.description.set('');
    this.selected.set([]);
    this.editing.set({ id: null, version: 0, system: false });
  }

  protected open(role: RoleDto): void {
    this.reset();
    this.code.set(role.code);
    this.name.set(role.name);
    this.description.set(role.description ?? '');
    this.selected.set(role.permissionCodes);
    this.editing.set({ id: role.id, version: role.version, system: role.isSystem });
  }

  protected close(): void {
    this.editing.set(null);
    this.reload.update((n) => n + 1);
  }

  protected toggle(code: string, on: boolean): void {
    this.selected.update((list) => toggleCode(list, code, on));
  }

  protected save(): void {
    const state = this.editing();
    if (!state) return;
    this.reset();
    if (!this.name().trim()) return void this.clientError.set('O nome é obrigatório.');
    if (!state.id && !/^[a-z][a-z0-9_]{1,59}$/.test(this.code().trim())) {
      return void this.clientError.set(
        'Código: minúsculas, números e _ (2 a 60, a começar por letra).',
      );
    }
    const body = {
      name: this.name().trim(),
      description: this.description().trim() || null,
      permissionCodes: this.selected(),
    };
    if (state.id) {
      this.run(this.api.updateRole(state.id, state.version, body), (saved) => {
        this.editing.set({ id: saved.id, version: saved.version, system: saved.isSystem });
        this.notice.set('Perfil guardado.');
      });
    } else {
      this.run(this.api.createRole(this.code().trim(), body), (saved) => {
        this.editing.set({ id: saved.id, version: saved.version, system: saved.isSystem });
        this.notice.set('Perfil criado.');
      });
    }
  }

  protected remove(): void {
    const role = this.confirmDelete();
    if (!role) return;
    this.reset();
    this.run(this.api.deleteRole(role.id), () => {
      this.confirmDelete.set(null);
      this.notice.set('Perfil apagado.');
      this.reload.update((n) => n + 1);
    });
    // Se o servidor recusar, o diálogo fecha e a mensagem fica no topo.
    this.confirmDelete.set(null);
  }
}
