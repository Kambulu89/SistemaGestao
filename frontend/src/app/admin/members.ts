import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { Pager } from '../ui/pager';
import { StatusBadge } from '../ui/status-badge';
import type { Member, Role } from './rbac-types';

const LIMIT = 25;

/** Membros da empresa e convites. */
@Component({
  selector: 'app-members',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, Pager, StatusBadge],
  template: `
    <app-page-header title="Membros" subtitle="Pessoas com acesso a esta empresa.">
      @if (canInvite()) {
        <button type="button" class="btn-primary" (click)="showInvite.set(!showInvite())">
          Convidar
        </button>
      }
    </app-page-header>

    @if (showInvite()) {
      <form
        class="card mb-6 grid gap-4 md:grid-cols-3"
        (ngSubmit)="invite()"
        aria-label="Convidar membro"
      >
        <div>
          <label class="label" for="inv-email">Email *</label>
          <input
            id="inv-email"
            name="email"
            type="email"
            class="input"
            required
            [(ngModel)]="email"
          />
        </div>
        <div>
          <label class="label" for="inv-name">Nome</label>
          <input id="inv-name" name="fullName" class="input" [(ngModel)]="fullName" />
        </div>
        <div>
          <label class="label" for="inv-role">Perfil inicial (toda a empresa)</label>
          <select id="inv-role" name="role" class="input" [(ngModel)]="roleId">
            <option [ngValue]="null">Nenhum</option>
            @for (r of activeRoles(); track r.id) {
              <option [ngValue]="r.id">{{ r.name }}</option>
            }
          </select>
        </div>
        <div class="md:col-span-3">
          <app-error-alert [error]="inviteAction.error()" />
          @if (delivery(); as d) {
            <p class="mb-2 text-sm" role="status" [class.text-amber-800]="d === 'NOT_CONFIGURED'">
              {{
                d === 'NOT_CONFIGURED'
                  ? 'Convite criado, mas o envio de email não está configurado: a ligação não foi enviada.'
                  : 'Convite criado e enviado (caixa de desenvolvimento).'
              }}
            </p>
          }
          <button type="submit" class="btn-primary" [disabled]="inviteAction.busy() || !email()">
            Enviar convite
          </button>
        </div>
      </form>
    }

    <form class="mb-4 flex flex-wrap gap-2" role="search" (ngSubmit)="go(0)">
      <label class="sr-only" for="q">Pesquisar</label>
      <input id="q" name="q" class="input max-w-xs" placeholder="Nome ou email" [(ngModel)]="q" />
      <label class="sr-only" for="status">Estado</label>
      <select
        id="status"
        name="status"
        class="input w-44"
        [(ngModel)]="status"
        (ngModelChange)="go(0)"
      >
        <option value="">Todos os estados</option>
        <option value="ACTIVE">Activos</option>
        <option value="INVITED">Convidados</option>
        <option value="SUSPENDED">Suspensos</option>
      </select>
      <button type="submit" class="btn-secondary">Pesquisar</button>
    </form>
    <app-error-alert [error]="page.error()" />
    @if (page.loading()) {
      <p class="text-sm text-slate-500">A carregar…</p>
    } @else if ((page.value()?.items ?? []).length === 0) {
      <p class="card text-sm text-slate-600">Sem membros com estes filtros.</p>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Membros">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Email</th>
              <th>Estado</th>
              <th>Perfis</th>
              <th>Entrada</th>
            </tr>
          </thead>
          <tbody>
            @for (m of page.value()?.items; track m.id) {
              <tr>
                <td>
                  <a class="btn-link" [routerLink]="['/membros', m.id]">{{ m.fullName }}</a>
                </td>
                <td>{{ m.email }}</td>
                <td><app-status-badge [status]="m.status" /></td>
                <td>{{ roleNames(m) }}</td>
                <td>{{ when(m.joinedAt ?? m.invitedAt) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <app-pager
        [total]="page.value()?.total ?? 0"
        [limit]="limit"
        [offset]="offset()"
        (offsetChange)="go($event)"
      />
    }
  `,
})
export class Members {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canInvite = computed(() => this.workspace.can('members.invite'));
  protected readonly limit = LIMIT;
  protected readonly when = formatDateTime;
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly offset = signal(0);
  protected readonly showInvite = signal(false);
  protected readonly email = signal('');
  protected readonly fullName = signal('');
  protected readonly roleId = signal<string | null>(null);
  protected readonly delivery = signal<string | null>(null);
  protected readonly inviteAction = new Action();
  protected readonly roles = signal<Role[]>([]);
  protected readonly activeRoles = computed(() =>
    this.roles().filter((r) => r.status === 'ACTIVE'),
  );
  protected readonly page = new Loadable(() =>
    this.api.page<Member>('members', {
      q: this.q().trim() || undefined,
      status: this.status() || undefined,
      limit: LIMIT,
      offset: this.offset(),
    }),
  );

  constructor() {
    void this.page.load();
    if (this.workspace.can('roles.read'))
      this.api.get<Role[]>('roles').then(
        (r) => this.roles.set(r),
        () => undefined,
      );
  }

  protected roleNames(m: Member) {
    return (
      m.roles
        .map((r) => this.roles().find((x) => x.id === r.roleId)?.name ?? r.roleCode)
        .join(', ') || '—'
    );
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected async invite() {
    this.delivery.set(null);
    const result = await this.inviteAction.run(() =>
      this.api.post<{ member: Member; delivery: string }>('members/invitations', {
        email: this.email().trim(),
        fullName: this.fullName().trim() || null,
        roles: this.roleId() ? [{ roleId: this.roleId() }] : [],
      }),
    );
    if (!result) return;
    this.delivery.set(result.delivery);
    this.email.set('');
    this.fullName.set('');
    this.roleId.set(null);
    await this.page.load();
  }
}
