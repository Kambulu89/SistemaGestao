import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { exportList, withoutPaging } from '../ui/export';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import type { Member, Role } from './rbac-types';

const LIMIT = 25;

/** Membros da empresa (EntityListPage): filtros na URL, colunas configuráveis, exportação e convite numa janela. */
@Component({
  selector: 'app-members',
  imports: [
    FormsModule,
    EntityListPage,
    FilterBar,
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
    <app-entity-list-page
      title="Membros"
      subtitle="Pessoas com acesso a esta empresa."
      permission="members.read"
    >
      @if (canInvite()) {
        <button actions type="button" class="btn-primary" (click)="openInvite()">
          <app-icon name="plus" [size]="16" />Convidar
        </button>
      }
      <app-filter-bar
        id="members"
        label="membros"
        placeholder="Nome ou email"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Membros"
        tableId="members"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [sort]="list.sort()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters() || list.q() ? 'Sem membros com estes filtros.' : 'Ainda sem membros.'
        "
        [exportable]="true"
        [exporting]="exporting()"
        (sortChange)="list.setSort($event)"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
        (export)="export($event)"
      >
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>
    </app-entity-list-page>

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
  protected readonly list = new ListState<Member>(this.api, {
    url: 'members',
    filterKeys: ['status'],
    sortFields: ['fullName', 'email', 'status', 'joinedAt'],
    limit: LIMIT,
  });
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: [
        { value: 'ACTIVE', label: 'Activos' },
        { value: 'INVITED', label: 'Convidados' },
        { value: 'SUSPENDED', label: 'Suspensos' },
      ],
    },
  ];
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
    {
      key: 'fullName',
      label: 'Nome',
      sortable: true,
      required: true,
      link: (m) => ['/membros', m.id],
    },
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
  constructor() {
    if (this.workspace.can('roles.read'))
      this.api.get<Role[]>('roles').then(
        (r) => this.roles.set(r),
        () => undefined,
      );
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
    await this.list.reload();
  }

  protected async export(columns: Column<Member>[]) {
    this.exporting.set(true);
    try {
      const query = withoutPaging(this.list.query());
      const count = await exportList(this.api, 'members', query, columns, 'membros.csv');
      this.toasts.show(`Exportados ${count} membro(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
