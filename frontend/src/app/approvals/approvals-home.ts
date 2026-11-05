import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import type { Task } from '../pages/dashboard';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { Pager } from '../ui/pager';
import { StatusBadge } from '../ui/status-badge';
import { type ApprovalRequest, personName } from './types';

const LIMIT = 25;

/** Aprovações: o que tenho para decidir e os pedidos visíveis (os meus, ou todos com approvals.read). */
@Component({
  selector: 'app-approvals-home',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, Pager, StatusBadge],
  template: `
    <app-page-header title="Aprovações">
      <a routerLink="/aprovacoes/delegacoes" class="btn-secondary">Delegações</a>
      @if (canRequest()) {
        <a routerLink="/aprovacoes/novo" class="btn-primary">Novo pedido</a>
      }
    </app-page-header>

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
      <div class="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h2 id="req-title" class="font-semibold">
          {{ seeAll() ? 'Pedidos da empresa' : 'Pedidos em que participo' }}
        </h2>
        <label class="text-sm">
          <span class="sr-only">Estado</span>
          <select class="input" [(ngModel)]="status" (ngModelChange)="go(0)" name="status">
            <option value="">Todos os estados</option>
            <option value="PENDING">Pendentes</option>
            <option value="APPROVED">Aprovados</option>
            <option value="REJECTED">Rejeitados</option>
            <option value="CANCELLED">Cancelados</option>
          </select>
        </label>
      </div>
      <app-error-alert [error]="requests.error()" />
      @if ((requests.value()?.items ?? []).length === 0 && !requests.loading()) {
        <p class="card text-sm text-muted">Sem pedidos.</p>
      } @else {
        <div class="card overflow-x-auto p-0">
          <table class="table" aria-label="Pedidos de aprovação">
            <thead>
              <tr>
                <th>Título</th>
                <th>Workflow</th>
                <th>Requerente</th>
                <th>Estado</th>
                <th>Criado</th>
              </tr>
            </thead>
            <tbody>
              @for (r of requests.value()?.items; track r.id) {
                <tr>
                  <td>
                    <a class="btn-link" [routerLink]="['/aprovacoes/pedidos', r.id]">{{
                      r.title
                    }}</a>
                  </td>
                  <td>{{ r.workflow.name }}</td>
                  <td>{{ person(r.requestedBy) }}</td>
                  <td><app-status-badge [status]="r.status" /></td>
                  <td>{{ when(r.createdAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <app-pager
          [total]="requests.value()?.total ?? 0"
          [limit]="limit"
          [offset]="offset()"
          (offsetChange)="go($event)"
        />
      }
    </section>
  `,
})
export class ApprovalsHome {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canRequest = computed(() => this.workspace.can('approvals.request'));
  protected readonly seeAll = computed(() => this.workspace.can('approvals.read'));
  protected readonly limit = LIMIT;
  protected readonly when = formatDateTime;
  protected readonly person = personName;
  protected readonly status = signal('');
  protected readonly offset = signal(0);
  protected readonly tasks = new Loadable(() => this.api.get<Task[]>('me/tasks'));
  protected readonly requests = new Loadable(() =>
    this.api.page<ApprovalRequest>('approvals/requests', {
      status: this.status() || undefined,
      limit: LIMIT,
      offset: this.offset(),
    }),
  );

  constructor() {
    void this.tasks.load();
    void this.requests.load();
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.requests.load();
  }
}
