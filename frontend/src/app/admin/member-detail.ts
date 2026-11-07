import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { SCOPE_LABELS } from '../ui/labels';
import { Action, Loadable } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { ToastService } from '../ui/toasts';
import { Breadcrumbs } from '../core/breadcrumbs';
import { ErrorState } from '../ui/states';
import { StatusBadge } from '../ui/status-badge';
import { type OrgRecord, recordLabel } from './org-kinds';
import { type Member, type Role, SCOPE_TARGETS } from './rbac-types';

/** Membro: estado e perfis com âmbito. As regras (anti-escalada, sem auto-alteração, último admin) são do servidor. */
@Component({
  selector: 'app-member-detail',
  imports: [FormsModule, RouterLink, PageDetail, ErrorAlert, ErrorState, StatusBadge, AuditHistory],
  template: `
    @if (member.error()) {
      <app-error-state [error]="member.error()" (retry)="member.load()" />
    }
    @if (member.value(); as m) {
      <app-page-detail [title]="m.fullName" [subtitle]="m.email" [status]="m.status">
        <ng-container actions
          ><a routerLink="/membros" class="btn-secondary">Voltar</a></ng-container
        >
        <app-error-alert [error]="action.error()" />
        <section class="card mb-4 flex flex-wrap items-center justify-between gap-3">
          <div class="text-sm">
            Estado: <app-status-badge [status]="m.status" />
            <span class="ml-3 text-muted"
              >Entrada: {{ when(m.joinedAt) }} · Convite: {{ when(m.invitedAt) }}</span
            >
          </div>
          @if (m.status === 'INVITED') {
            <div class="w-full text-sm" data-testid="invitation">
              @if (m.invitationExpiresAt) {
                <p [class.text-danger-text]="expired(m)">
                  {{ expired(m) ? 'Convite expirado em' : 'Convite válido até' }}
                  {{ when(m.invitationExpiresAt) }}.
                </p>
              } @else {
                <p class="text-muted">Sem convite válido (expirou ou foi usado).</p>
              }
              @if (canInvite()) {
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="btn-secondary"
                    [disabled]="action.busy()"
                    (click)="resendInvitation()"
                  >
                    Reenviar convite
                  </button>
                  <button
                    type="button"
                    class="btn-danger"
                    [disabled]="action.busy()"
                    (click)="revokeInvitation()"
                  >
                    Revogar convite
                  </button>
                </div>
              }
            </div>
          }
          @if (canManage() && !isSelf()) {
            @if (m.status === 'ACTIVE') {
              <button
                type="button"
                class="btn-danger"
                [disabled]="action.busy()"
                (click)="setStatus('suspend')"
              >
                Suspender
              </button>
            } @else if (m.status === 'SUSPENDED') {
              <button
                type="button"
                class="btn-primary"
                [disabled]="action.busy()"
                (click)="setStatus('reactivate')"
              >
                Reactivar
              </button>
            }
          }
        </section>

        <section class="card">
          <h2 class="font-semibold">Perfis</h2>
          @if (m.roles.length === 0) {
            <p class="mt-2 text-sm text-muted">Sem perfis: este membro não tem permissões.</p>
          } @else {
            <ul class="mt-2 divide-y divide-border">
              @for (a of m.roles; track a.id) {
                <li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span class="font-medium">{{ roleName(a.roleId, a.roleCode) }}</span>
                    <span class="text-muted">
                      · {{ scopeLabel(a.scopeType)
                      }}{{ a.scopeId ? ': ' + targetName(a.scopeId) : '' }}</span
                    >
                  </span>
                  @if (canManage() && !isSelf()) {
                    <button
                      type="button"
                      class="btn-secondary"
                      [disabled]="action.busy()"
                      (click)="unassign(a.id)"
                    >
                      Retirar
                    </button>
                  }
                </li>
              }
            </ul>
          }
          @if (isSelf()) {
            <p class="mt-3 text-sm text-muted">
              Não pode alterar os seus próprios perfis nem o seu estado.
            </p>
          } @else if (canManage()) {
            <form
              class="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-4"
              (ngSubmit)="assign()"
              aria-label="Atribuir perfil"
            >
              <div>
                <label class="label" for="role">Perfil</label>
                <select id="role" name="role" class="input" [(ngModel)]="roleId">
                  <option [ngValue]="null">—</option>
                  @for (r of activeRoles(); track r.id) {
                    <option [ngValue]="r.id">{{ r.name }}</option>
                  }
                </select>
              </div>
              <div>
                <label class="label" for="scope">Âmbito</label>
                <select
                  id="scope"
                  name="scope"
                  class="input"
                  [(ngModel)]="scopeType"
                  (ngModelChange)="scopeChanged()"
                >
                  @for (s of scopeTypes; track s) {
                    <option [ngValue]="s">{{ scopeLabel(s) }}</option>
                  }
                </select>
              </div>
              @if (targetSegment()) {
                <div>
                  <label class="label" for="target">Alvo</label>
                  <select id="target" name="target" class="input" [(ngModel)]="scopeId">
                    <option [ngValue]="null">—</option>
                    @for (t of targets(); track t.id) {
                      <option [ngValue]="t.id">{{ label(t) }}</option>
                    }
                  </select>
                </div>
              }
              <div class="flex items-end">
                <button
                  type="submit"
                  class="btn-primary"
                  [disabled]="action.busy() || !roleId() || (targetSegment() && !scopeId())"
                >
                  Atribuir
                </button>
              </div>
            </form>
          }
        </section>
        <div aside>
          <app-audit-history
            entityType="membership"
            [entityId]="m.id"
            [refreshKey]="m.version + ':' + m.roles.length"
          />
        </div>
      </app-page-detail>
    }
  `,
})
export class MemberDetail {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly when = formatDateTime;
  protected readonly label = recordLabel;
  protected readonly scopeTypes = Object.keys(SCOPE_LABELS);
  protected readonly canManage = computed(() => this.workspace.can('members.manage'));
  protected readonly canInvite = computed(() => this.workspace.can('members.invite'));
  protected readonly isSelf = computed(() => this.workspace.context()?.membershipId === this.id());
  protected readonly roles = signal<Role[]>([]);
  protected readonly activeRoles = computed(() =>
    this.roles().filter((r) => r.status === 'ACTIVE'),
  );
  protected readonly roleId = signal<string | null>(null);
  protected readonly scopeType = signal('TENANT');
  protected readonly scopeId = signal<string | null>(null);
  protected readonly targets = signal<OrgRecord[]>([]);
  private readonly allTargets = signal<Map<string, string>>(new Map());
  protected readonly targetSegment = computed(() => SCOPE_TARGETS[this.scopeType()] ?? null);
  protected readonly action = new Action();
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly member = new Loadable(async () => {
    const m = await this.api.get<Member>(`members/${this.id()}`);
    this.breadcrumbs.setCurrent(m.fullName);
    return m;
  });

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.member.load());
    });
    if (this.workspace.can('roles.read'))
      this.api.get<Role[]>('roles').then(
        (r) => this.roles.set(r),
        () => undefined,
      );
    if (this.workspace.can('organization.read') && this.workspace.has('organization'))
      void this.loadTargetNames();
  }

  private async loadTargetNames() {
    const map = new Map<string, string>();
    for (const segment of Object.values(SCOPE_TARGETS)) {
      try {
        for (const r of (await this.api.page<OrgRecord>(`organization/${segment}`, { limit: 200 }))
          .items)
          map.set(r.id, recordLabel(r));
      } catch {
        /* sem nomes: mostra-se o identificador */
      }
    }
    this.allTargets.set(map);
  }

  protected scopeLabel(s: string) {
    return SCOPE_LABELS[s] ?? s;
  }

  protected roleName(id: string, code: string) {
    return this.roles().find((r) => r.id === id)?.name ?? code;
  }

  protected targetName(id: string) {
    return this.allTargets().get(id) ?? id;
  }

  protected async scopeChanged() {
    this.scopeId.set(null);
    this.targets.set([]);
    const segment = this.targetSegment();
    if (!segment) return;
    try {
      this.targets.set(
        (
          await this.api.page<OrgRecord>(`organization/${segment}`, {
            limit: 200,
            status: 'ACTIVE',
          })
        ).items,
      );
    } catch {
      this.targets.set([]);
    }
  }

  protected async setStatus(action: 'suspend' | 'reactivate') {
    const m = this.member.value()!;
    if (
      action === 'suspend' &&
      !(await this.confirm.ask({
        title: 'Suspender membro',
        message: `${m.fullName} deixa de conseguir entrar nesta empresa até ser reactivado.`,
        confirmLabel: 'Suspender',
        danger: true,
      }))
    )
      return;
    const updated = await this.action.run(() =>
      this.api.post<Member>(`members/${m.id}/${action}`, { expectedVersion: m.version }),
    );
    if (updated) {
      this.member.value.set(updated);
      this.toasts.show(action === 'suspend' ? 'Membro suspenso.' : 'Membro reactivado.');
    }
  }

  protected expired(m: Member) {
    return !!m.invitationExpiresAt && Date.parse(m.invitationExpiresAt) < Date.now();
  }

  protected async resendInvitation() {
    const m = this.member.value()!;
    const result = await this.action.run(() =>
      this.api.post<{ member: Member; delivery: string }>(`members/${m.id}/invitation/resend`, {}),
    );
    if (!result) return;
    this.member.value.set(result.member);
    this.toasts.show(
      result.delivery === 'NOT_CONFIGURED'
        ? 'Novo convite emitido, mas o envio de email não está configurado.'
        : 'Convite reenviado; o anterior deixou de funcionar.',
      result.delivery === 'NOT_CONFIGURED' ? 'info' : 'success',
    );
  }

  protected async revokeInvitation() {
    const m = this.member.value()!;
    const ok = await this.confirm.ask({
      title: 'Revogar convite',
      message: `A ligação enviada a ${m.email} deixa de funcionar e o membro fica revogado.`,
      confirmLabel: 'Revogar',
      danger: true,
    });
    if (!ok) return;
    await this.action.run(() => this.api.delete(`members/${m.id}/invitation`));
    if (this.action.error()) return;
    this.toasts.show('Convite revogado.');
    await this.member.load();
  }

  protected async assign() {
    const updated = await this.action.run(() =>
      this.api.post<Member>(`members/${this.id()}/roles`, {
        roleId: this.roleId(),
        scopeType: this.scopeType(),
        scopeId: this.targetSegment() ? this.scopeId() : null,
      }),
    );
    if (updated) {
      this.member.value.set(updated);
      this.roleId.set(null);
      this.toasts.show('Perfil atribuído.');
    }
  }

  protected async unassign(assignmentId: string) {
    if (
      !(await this.confirm.ask({
        title: 'Retirar perfil',
        message: 'O membro perde as permissões deste perfil neste âmbito.',
        confirmLabel: 'Retirar',
        danger: true,
      }))
    )
      return;
    const updated = await this.action.run(() =>
      this.api.delete(`members/${this.id()}/roles/${assignmentId}`),
    );
    if (updated === undefined && this.action.error()) return;
    this.toasts.show('Perfil retirado.');
    await this.member.load();
  }
}
