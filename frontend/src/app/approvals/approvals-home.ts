import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import type { Task } from '../pages/dashboard';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Loadable } from '../ui/load';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import { type ApprovalRequest, personName } from './types';

const LIMIT = 25;

/** Aprovações: o que tenho para decidir e os pedidos visíveis (os meus, ou todos com approvals.read). */
@Component({
  selector: 'app-approvals-home',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, ErrorAlert, StatusBadge],
  template: `
    <app-entity-list-page
      title="Aprovações"
      subtitle="O que tem para decidir e os pedidos que acompanha."
      feature="approvals"
    >
      <a actions routerLink="/aprovacoes/delegacoes" class="btn-secondary">Delegações</a>
      @if (canRequest()) {
        <a actions routerLink="/aprovacoes/novo" class="btn-primary">Novo pedido</a>
      }

      <section class="card mb-6" aria-labelledby="todo-title">
        <h2 id="todo-title" class="font-semibold">Para decidir</h2>
        <app-error-alert [error]="tasks.error()" />
        @if ((tasks.value() ?? []).length === 0 && !tasks.loading()) {
          <p class="mt-2 text-sm text-muted">Nada pendente.</p>
        }
        <ul class="mt-2 divide-y divide-border" data-testid="approval-tasks">
          @for (t of tasks.value(); track t.subjectId + t.onBehalfOf) {
            <li class="py-2 text-sm">
              <a class="btn-link" [routerLink]="['/aprovacoes/pedidos', t.subjectId]">{{
                t.title
              }}</a>
              <span class="block text-xs text-muted"
                >Etapa {{ t.detail }}{{ t.onBehalfOf ? ' · por delegação' : '' }} ·
                {{ when(t.since) }}</span
              >
            </li>
          }
        </ul>
      </section>

      <section aria-labelledby="req-title">
        <h2 id="req-title" class="mb-2 font-semibold">
          {{ seeAll() ? 'Pedidos da empresa' : 'Pedidos em que participo' }}
        </h2>
        <app-filter-bar
          id="req"
          label="pedidos"
          [searchable]="false"
          [state]="list"
          [filters]="filters"
        />
        <app-data-table
          label="Pedidos de aprovação"
          tableId="approval-requests"
          [columns]="columns"
          [rows]="list.page.value()?.items ?? []"
          [total]="list.page.value()?.total ?? 0"
          [loading]="list.page.loading()"
          [error]="list.page.error()"
          [offset]="list.offset()"
          [limit]="list.limit"
          emptyText="Sem pedidos."
          (offsetChange)="list.goTo($event)"
          (retry)="list.reload()"
        >
          <ng-template appCell="status" let-row
            ><app-status-badge [status]="row.status"
          /></ng-template>
        </app-data-table>
      </section>
    </app-entity-list-page>
  `,
})
export class ApprovalsHome {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canRequest = computed(() => this.workspace.can('approvals.request'));
  protected readonly seeAll = computed(() => this.workspace.can('approvals.read'));
  protected readonly when = formatDateTime;
  protected readonly person = personName;
  protected readonly tasks = new Loadable(() => this.api.get<Task[]>('me/tasks'));
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: [
        { value: 'PENDING', label: 'Pendentes' },
        { value: 'APPROVED', label: 'Aprovados' },
        { value: 'REJECTED', label: 'Rejeitados' },
        { value: 'CANCELLED', label: 'Cancelados' },
      ],
    },
  ];
  protected readonly columns: Column<ApprovalRequest>[] = [
    { key: 'title', label: 'Título', required: true, link: (r) => ['/aprovacoes/pedidos', r.id] },
    { key: 'workflow', label: 'Workflow', value: (r) => r.workflow.name },
    { key: 'requestedBy', label: 'Requerente', value: (r) => personName(r.requestedBy) },
    { key: 'status', label: 'Estado' },
    {
      key: 'createdAt',
      label: 'Criado',
      hideOnMobile: true,
      value: (r) => formatDateTime(r.createdAt),
    },
  ];
  protected readonly list = new ListState<ApprovalRequest>(this.api, {
    url: 'approvals/requests',
    filterKeys: ['status'],
    limit: LIMIT,
  });

  constructor() {
    void this.tasks.load();
  }
}
