import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { ConfirmService } from '../ui/confirm';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import type { PermissionDefinition, Role } from './rbac-types';

/** Agrupa as permissões por módulo, pela ordem do catálogo. */
export function groupPermissions(defs: PermissionDefinition[]) {
  const groups = new Map<string, PermissionDefinition[]>();
  for (const d of defs) groups.set(d.module, [...(groups.get(d.module) ?? []), d]);
  return [...groups].map(([module, items]) => ({ module, items }));
}

/** Diferença entre as permissões guardadas e as editadas de um perfil (para confirmar antes de gravar). */
export function permissionDiff(before: string[], after: Set<string>) {
  const old = new Set(before);
  return {
    added: [...after].filter((c) => !old.has(c)).sort(),
    removed: before.filter((c) => !after.has(c)).sort(),
  };
}

/**
 * Matriz perfis × permissões: leitura para quem vê perfis; quem gere perfis altera as células dos perfis não-sistema e
 * grava perfil a perfil (o servidor aplica a anti-escalada e a concorrência por versão).
 */
@Component({
  selector: 'app-permission-matrix',
  imports: [RouterLink, PageHeader, ErrorAlert, ErrorState, Skeleton],
  template: `
    <app-page-header
      title="Matriz de permissões"
      subtitle="Que permissões tem cada perfil. Perfis de sistema não se alteram."
    >
      <a class="btn-secondary" routerLink="/perfis">Ver perfis</a>
    </app-page-header>
    <app-error-alert [error]="action.error()" />
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else if (!loaded()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="w-full text-sm">
          <caption class="sr-only">
            Permissões por perfil
          </caption>
          <thead>
            <tr class="border-b border-border">
              <th scope="col" class="sticky left-0 bg-surface p-2 text-left">Permissão</th>
              @for (r of roles(); track r.id) {
                <th scope="col" class="p-2 text-center whitespace-nowrap">
                  <a class="btn-link" [routerLink]="['/perfis', r.id]">{{ r.name }}</a>
                  @if (r.isSystem) {
                    <span class="block text-xs text-muted">sistema</span>
                  }
                  @if (dirty(r)) {
                    <button
                      type="button"
                      class="btn-primary mt-1"
                      [disabled]="action.busy()"
                      (click)="save(r)"
                    >
                      Guardar
                    </button>
                  }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (g of groups(); track g.module) {
              <tr class="bg-surface-2">
                <th scope="rowgroup" [attr.colspan]="roles().length + 1" class="p-2 text-left">
                  {{ g.module }}
                </th>
              </tr>
              @for (p of g.items; track p.code) {
                <tr class="border-b border-border">
                  <th scope="row" class="sticky left-0 bg-surface p-2 text-left font-normal">
                    <span class="font-mono text-xs">{{ p.code }}</span>
                    <span class="block text-xs text-muted">{{ p.description }}</span>
                  </th>
                  @for (r of roles(); track r.id) {
                    <td class="p-2 text-center">
                      <input
                        type="checkbox"
                        [attr.aria-label]="p.code + ' em ' + r.name"
                        [checked]="has(r, p.code)"
                        [disabled]="!editable(r) || action.busy()"
                        (change)="toggle(r, p.code)"
                      />
                    </td>
                  }
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class PermissionMatrix {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly roles = signal<Role[]>([]);
  protected readonly groups = signal<ReturnType<typeof groupPermissions>>([]);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  /** Permissões em edição por perfil (só os alterados). */
  protected readonly edits = signal<Record<string, Set<string>>>({});
  protected readonly action = new Action();
  private readonly canManage = computed(() => this.workspace.can('roles.manage'));

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [defs, roles] = await Promise.all([
        this.api.get<PermissionDefinition[]>('permissions'),
        this.api.get<Role[]>('roles'),
      ]);
      this.groups.set(groupPermissions(defs));
      this.roles.set(roles.filter((r) => r.status === 'ACTIVE'));
      this.edits.set({});
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected editable(r: Role) {
    return this.canManage() && !r.isSystem;
  }

  protected has(r: Role, code: string) {
    return (this.edits()[r.id] ?? new Set(r.permissionCodes)).has(code);
  }

  protected dirty(r: Role) {
    const e = this.edits()[r.id];
    if (!e) return false;
    const d = permissionDiff(r.permissionCodes, e);
    return d.added.length + d.removed.length > 0;
  }

  protected toggle(r: Role, code: string) {
    const next = new Set(this.edits()[r.id] ?? r.permissionCodes);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    this.edits.update((e) => ({ ...e, [r.id]: next }));
  }

  protected async save(r: Role) {
    const selected = this.edits()[r.id]!;
    const d = permissionDiff(r.permissionCodes, selected);
    const ok = await this.confirm.ask({
      title: `Alterar o perfil ${r.name}`,
      message: [
        d.added.length ? `Acrescenta: ${d.added.join(', ')}.` : '',
        d.removed.length ? `Retira: ${d.removed.join(', ')}.` : '',
        'Afecta todos os membros com este perfil.',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Guardar',
    });
    if (!ok) return;
    const updated = await this.action.run(() =>
      this.api.patch<Role>(`roles/${r.id}`, {
        permissionCodes: [...selected].sort(),
        expectedVersion: r.version,
      }),
    );
    if (!updated) return;
    this.roles.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
    this.edits.update((e) => {
      const next = { ...e };
      delete next[r.id];
      return next;
    });
    this.toasts.show(`Perfil ${updated.name} actualizado.`);
  }
}
