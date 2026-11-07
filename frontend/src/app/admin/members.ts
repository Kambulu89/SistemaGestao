import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable, type Sort } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { exportList, withoutPaging } from '../ui/export';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action, Loadable } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import type { Member, Role } from './rbac-types';

const LIMIT = 25;

/** Membros da empresa: lista ordenável e exportável, convite numa janela. */
@Component({
  selector: 'app-members',
  imports: [
    FormsModule,
    PageHeader,
    DataTable,
    CellDef,
    StatusBadge,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    Icon,
  ],
  template: `
    <app-page-header title="Membros" subtitle="Pessoas com acesso a esta empresa.">
      @if (canInvite()) {
        <button type="button" class="btn-primary" (click)="openInvite()">
          <app-icon name="plus" [size]="16" />Convidar
        </button>
      }
    </app-page-header>

    <form class="mb-4 flex flex-wrap items-end gap-2" role="search" (ngSubmit)="go(0)">
      <div>
        <label class="label" for="q">Pesquisar</label>
        <input
          id="q"
          name="q"
          type="search"
          class="input w-64"
          placeholder="Nome ou email"
          [(ngModel)]="q"
        />
      </div>
      <div>
        <label class="label" for="status">Estado</label>
        <select
          id="status"
          name="status"
          class="input w-44"
          [(ngModel)]="status"
          (ngModelChange)="go(0)"
        >
          <option value="">Todos</option>
          <option value="ACTIVE">Activos</option>
          <option value="INVITED">Convidados</option>
          <option value="SUSPENDED">Suspensos</option>
        </select>
      </div>
      <button type="submit" class="btn-secondary">Pesquisar</button>
    </form>

    <app-data-table
      label="Membros"
      [columns]="columns"
      [rows]="page.value()?.items ?? []"
      [total]="page.value()?.total ?? 0"
      [loading]="page.loading()"
      [error]="page.error()"
      [sort]="sort()"
      [offset]="offset()"
      [limit]="limit"
      emptyText="Sem membros com estes filtros."
      [exportable]="true"
      [exporting]="exporting()"
      (sortChange)="onSort($event)"
      (offsetChange)="go($event)"
      (retry)="page.load()"
      (export)="export()"
    >
      <ng-template appCell="status" let-row><app-status-badge [status]="row.status" /></ng-template>
    </app-data-table>

    <app-modal title="Convidar membro" [open]="inviteOpen()" (closed)="inviteOpen.set(false)">
      <form id="invite-form" class="space-y-4" (ngSubmit)="invite()" novalidate>
        <app-error-alert [error]="inviteAction.error()" [showDetails]="false" />
        <app-field label="Email" [required]="true" [error]="inviteAction.field('email')">
          <input
            appControl
            name="email"
            type="email"
            class="input"
            autocomplete="off"
            [(ngModel)]="email"
          />
        </app-field>
        <app-field label="Nome" hint="Usado se a pessoa ainda não tiver conta.">
          <input appControl name="fullName" class="input" [(ngModel)]="fullName" />
        </app-field>
        <app-field
          label="Perfil inicial (toda a empresa)"
          hint="Pode atribuir outros perfis e âmbitos depois."
        >
          <select appControl name="role" class="input" [(ngModel)]="roleId">
            <option [ngValue]="null">Nenhum</option>
            @for (r of activeRoles(); track r.id) {
              <option [ngValue]="r.id">{{ r.name }}</option>
            }
          </select>
        </app-field>
      </form>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="inviteOpen.set(false)">
          Cancelar
        </button>
        <button
          type="submit"
          form="invite-form"
          class="btn-primary"
          [disabled]="inviteAction.busy() || !email().trim()"
        >
          {{ inviteAction.busy() ? 'A enviar…' : 'Enviar convite' }}
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class Members {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly canInvite = computed(() => this.workspace.can('members.invite'));
  protected readonly limit = LIMIT;
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly offset = signal(0);
  protected readonly sort = signal<Sort | null>(null);
  protected readonly exporting = signal(false);
  protected readonly inviteOpen = signal(false);
  protected readonly email = signal('');
  protected readonly fullName = signal('');
  protected readonly roleId = signal<string | null>(null);
  protected readonly inviteAction = new Action();
  protected readonly roles = signal<Role[]>([]);
  protected readonly activeRoles = computed(() =>
    this.roles().filter((r) => r.status === 'ACTIVE'),
  );
  protected readonly columns: Column<Member>[] = [
    { key: 'fullName', label: 'Nome', sortable: true, link: (m) => ['/membros', m.id] },
    { key: 'email', label: 'Email', sortable: true },
    { key: 'status', label: 'Estado', sortable: true },
    {
      key: 'roles',
      label: 'Perfis',
      hideOnMobile: true,
      value: (m) =>
        m.roles
          .map((r) => this.roles().find((x) => x.id === r.roleId)?.name ?? r.roleCode)
          .join(', ') || null,
    },
    {
      key: 'joinedAt',
      label: 'Entrada',
      sortable: true,
      hideOnMobile: true,
      value: (m) => formatDateTime(m.joinedAt ?? m.invitedAt),
    },
  ];
  protected readonly page = new Loadable(() => this.api.page<Member>('members', this.query()));

  constructor() {
    void this.page.load();
    if (this.workspace.can('roles.read'))
      this.api.get<Role[]>('roles').then(
        (r) => this.roles.set(r),
        () => undefined,
      );
  }

  private query() {
    return {
      q: this.q().trim() || undefined,
      status: this.status() || undefined,
      sort: this.sort()?.field,
      direction: this.sort()?.direction,
      limit: LIMIT,
      offset: this.offset(),
    };
  }

  protected onSort(sort: Sort) {
    this.sort.set(sort);
    this.go(0);
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected openInvite() {
    this.inviteAction.error.set(null);
    this.inviteOpen.set(true);
  }

  protected async invite() {
    if (this.inviteAction.busy()) return;
    const result = await this.inviteAction.run(() =>
      this.api.post<{ member: Member; delivery: string }>('members/invitations', {
        email: this.email().trim(),
        fullName: this.fullName().trim() || null,
        roles: this.roleId() ? [{ roleId: this.roleId() }] : [],
      }),
    );
    if (!result) return;
    this.toasts.show(
      result.delivery === 'NOT_CONFIGURED'
        ? 'Convite criado, mas o envio de email não está configurado: a ligação não foi enviada.'
        : 'Convite criado e enviado.',
      result.delivery === 'NOT_CONFIGURED' ? 'info' : 'success',
      8000,
    );
    this.inviteOpen.set(false);
    this.email.set('');
    this.fullName.set('');
    this.roleId.set(null);
    await this.page.load();
  }

  protected async export() {
    this.exporting.set(true);
    try {
      const query = withoutPaging(this.query());
      const count = await exportList(this.api, 'members', query, this.columns, 'membros.csv');
      this.toasts.show(`Exportados ${count} membro(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
