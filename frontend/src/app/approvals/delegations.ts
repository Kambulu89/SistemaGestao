import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import type { Member } from '../admin/rbac-types';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { type Delegation, personName } from './types';

/** Delegações: dar as minhas aprovações a alguém por um período; ver as recebidas; revogar as que dei. */
@Component({
  selector: 'app-delegations',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, StatusBadge],
  template: `
    <app-page-header
      title="Delegações"
      subtitle="Quem decide as suas aprovações enquanto está ausente."
    >
      <a routerLink="/aprovacoes" class="btn-secondary">Voltar</a>
    </app-page-header>

    @if (canPickMembers()) {
      <form
        class="card mb-6 grid gap-3 md:grid-cols-4"
        (ngSubmit)="create()"
        aria-label="Nova delegação"
      >
        <div>
          <label class="label" for="delegate">Delegar em *</label>
          <select id="delegate" name="delegate" class="input" [(ngModel)]="delegateId">
            <option [ngValue]="null">—</option>
            @for (m of candidates(); track m.id) {
              <option [ngValue]="m.id">{{ m.fullName }} ({{ m.email }})</option>
            }
          </select>
        </div>
        <div>
          <label class="label" for="ends">Até *</label>
          <input id="ends" name="ends" type="date" class="input" [(ngModel)]="endsOn" />
        </div>
        <div class="md:col-span-2">
          <label class="label" for="reason">Motivo *</label>
          <input
            id="reason"
            name="reason"
            class="input"
            placeholder="ex.: férias"
            [(ngModel)]="reason"
          />
        </div>
        <div class="md:col-span-4">
          <app-error-alert [error]="action.error()" />
          <button
            type="submit"
            class="btn-primary"
            [disabled]="action.busy() || !delegateId() || !endsOn() || reason().trim().length < 3"
          >
            Delegar
          </button>
        </div>
      </form>
    } @else {
      <p class="card mb-6 text-sm text-slate-600">
        Para escolher em quem delegar precisa de ver a lista de membros (permissão members.read).
        Peça ao administrador.
      </p>
    }

    <app-error-alert [error]="list.error()" />
    @if ((list.value() ?? []).length === 0 && !list.loading()) {
      <p class="card text-sm text-slate-600">Sem delegações.</p>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Delegações">
          <thead>
            <tr>
              <th>De</th>
              <th>Para</th>
              <th>Período</th>
              <th>Motivo</th>
              <th>Estado</th>
              <th><span class="sr-only">Acções</span></th>
            </tr>
          </thead>
          <tbody>
            @for (d of list.value(); track d.id) {
              <tr>
                <td>{{ person(d.delegator) }}</td>
                <td>{{ person(d.delegate) }}</td>
                <td class="whitespace-nowrap">{{ when(d.startsAt) }} – {{ when(d.endsAt) }}</td>
                <td>{{ d.reason }}</td>
                <td><app-status-badge [status]="d.status" /></td>
                <td>
                  @if (
                    d.status === 'ACTIVE' && (d.delegator.membershipId === me() || canManage())
                  ) {
                    <button
                      type="button"
                      class="btn-secondary"
                      [disabled]="action.busy()"
                      (click)="revoke(d)"
                    >
                      Revogar
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class Delegations {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly when = formatDateTime;
  protected readonly person = personName;
  protected readonly me = computed(() => this.workspace.context()?.membershipId ?? null);
  protected readonly canManage = computed(() => this.workspace.can('approvals.manage'));
  protected readonly canPickMembers = computed(() => this.workspace.can('members.read'));
  protected readonly members = signal<Member[]>([]);
  protected readonly candidates = computed(() =>
    this.members().filter((m) => m.status === 'ACTIVE' && m.id !== this.me()),
  );
  protected readonly delegateId = signal<string | null>(null);
  protected readonly endsOn = signal('');
  protected readonly reason = signal('');
  protected readonly action = new Action();
  protected readonly list = new Loadable(() =>
    this.api.get<Delegation[]>('approvals/delegations', { all: this.canManage() || undefined }),
  );

  constructor() {
    void this.list.load();
    if (this.canPickMembers())
      this.api.page<Member>('members', { status: 'ACTIVE', limit: 100 }).then(
        (p) => this.members.set(p.items),
        () => undefined,
      );
  }

  protected async create() {
    const done = await this.action.run(() =>
      this.api.post('approvals/delegations', {
        delegateMembershipId: this.delegateId(),
        endsAt: new Date(`${this.endsOn()}T23:59:59`).toISOString(),
        reason: this.reason().trim(),
      }),
    );
    if (!done) return;
    this.delegateId.set(null);
    this.endsOn.set('');
    this.reason.set('');
    await this.list.load();
  }

  protected async revoke(d: Delegation) {
    await this.action.run(() => this.api.post(`approvals/delegations/${d.id}/revoke`));
    await this.list.load();
  }
}
