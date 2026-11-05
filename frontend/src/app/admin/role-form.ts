import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import type { PermissionDefinition, Role } from './rbac-types';

/**
 * Criar ou alterar um perfil. Só se podem marcar permissões que o próprio tem (o servidor impõe a mesma regra);
 * os perfis de sistema são só de leitura.
 */
@Component({
  selector: 'app-role-form',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert],
  template: `
    <app-page-header [title]="isNew() ? 'Novo perfil' : (role()?.name ?? 'Perfil')">
      <a routerLink="/perfis" class="btn-secondary">Voltar</a>
    </app-page-header>
    <app-error-alert [error]="loadError()" />
    @if (ready()) {
      <form class="card space-y-4" (ngSubmit)="save()" novalidate>
        <app-error-alert [error]="action.error()" />
        @if (saved()) {
          <p class="text-sm text-green-700" role="status">Guardado.</p>
        }
        @if (role()?.isSystem) {
          <p class="text-sm text-slate-600">
            Perfil de sistema: tem todas as permissões e não se altera.
          </p>
        }
        <div class="grid gap-4 md:grid-cols-3">
          <div>
            <label class="label" for="code">Código *</label>
            <input
              id="code"
              name="code"
              class="input font-mono"
              [disabled]="!isNew() || !editable()"
              [(ngModel)]="code"
            />
            <p class="mt-1 text-xs text-slate-500">Minúsculas, números e _ (2 a 50).</p>
          </div>
          <div>
            <label class="label" for="name">Nome *</label>
            <input
              id="name"
              name="name"
              class="input"
              [disabled]="!editable()"
              [(ngModel)]="name"
            />
          </div>
          <div>
            <label class="label" for="status">Estado</label>
            <select
              id="status"
              name="status"
              class="input"
              [disabled]="isNew() || !editable()"
              [(ngModel)]="status"
            >
              <option value="ACTIVE">Activo</option>
              <option value="INACTIVE">Inactivo</option>
            </select>
          </div>
          <div class="md:col-span-3">
            <label class="label" for="description">Descrição</label>
            <input
              id="description"
              name="description"
              class="input"
              [disabled]="!editable()"
              [(ngModel)]="description"
            />
          </div>
        </div>
        <fieldset>
          <legend class="label">Permissões</legend>
          @for (group of groups(); track group.module) {
            <div class="mt-3">
              <p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {{ group.module }}
              </p>
              @for (p of group.items; track p.code) {
                <label class="mt-1 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    class="mt-1"
                    [checked]="selected().has(p.code)"
                    [disabled]="!editable() || !held().has(p.code)"
                    (change)="toggle(p.code)"
                  />
                  <span>
                    <span class="font-mono text-xs">{{ p.code }}</span> — {{ p.description }}
                    @if (!held().has(p.code)) {
                      <span class="text-xs text-slate-500">(não a tem: não a pode conceder)</span>
                    }
                  </span>
                </label>
              }
            </div>
          }
        </fieldset>
        @if (editable()) {
          <div class="flex flex-wrap gap-2">
            <button type="submit" class="btn-primary" [disabled]="action.busy()">
              {{ isNew() ? 'Criar' : 'Guardar' }}
            </button>
            @if (!isNew()) {
              <button
                type="button"
                class="btn-danger"
                [disabled]="action.busy()"
                (click)="remove()"
              >
                Eliminar
              </button>
            }
          </div>
        }
      </form>
    }
  `,
})
export class RoleForm {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly workspace = inject(Workspace);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly role = signal<Role | null>(null);
  protected readonly permissions = signal<PermissionDefinition[]>([]);
  protected readonly ready = signal(false);
  protected readonly saved = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly held = computed(() => this.workspace.permissions());
  protected readonly editable = computed(
    () => this.workspace.can('roles.manage') && !this.role()?.isSystem,
  );
  protected readonly groups = computed(() => {
    const map = new Map<string, PermissionDefinition[]>();
    for (const p of this.permissions()) map.set(p.module, [...(map.get(p.module) ?? []), p]);
    return [...map].map(([module, items]) => ({ module, items }));
  });
  protected readonly action = new Action();
  protected code = '';
  protected name = '';
  protected description = '';
  protected status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE';

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    this.ready.set(false);
    try {
      this.permissions.set(await this.api.get<PermissionDefinition[]>('permissions'));
      const role = id === 'novo' ? null : await this.api.get<Role>(`roles/${id}`);
      this.role.set(role);
      this.code = role?.code ?? '';
      this.name = role?.name ?? '';
      this.description = role?.description ?? '';
      this.status = role?.status ?? 'ACTIVE';
      this.selected.set(new Set(role?.permissionCodes ?? []));
      this.ready.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected toggle(code: string) {
    const next = new Set(this.selected());
    if (next.has(code)) next.delete(code);
    else next.add(code);
    this.selected.set(next);
  }

  protected async save() {
    this.saved.set(false);
    const body = {
      name: this.name.trim(),
      description: this.description.trim() || null,
      permissionCodes: [...this.selected()].sort(),
    };
    const role = this.role();
    const result = await this.action.run(() =>
      role
        ? this.api.patch<Role>(`roles/${role.id}`, {
            ...body,
            status: this.status,
            expectedVersion: role.version,
          })
        : this.api.post<Role>('roles', { ...body, code: this.code.trim() }),
    );
    if (!result) return;
    if (!role) {
      await this.router.navigate(['/perfis', result.id]);
      return;
    }
    this.role.set(result);
    this.saved.set(true);
    await this.workspace.refresh();
  }

  protected async remove() {
    const role = this.role()!;
    if (!confirm(`Eliminar o perfil "${role.name}"?`)) return;
    await this.action.run(() => this.api.delete(`roles/${role.id}`));
    if (!this.action.error()) await this.router.navigateByUrl('/perfis');
  }
}
