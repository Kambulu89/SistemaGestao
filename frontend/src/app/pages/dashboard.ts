import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { statusLabel } from '../ui/labels';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';

export interface Task {
  type: string;
  subjectType: string;
  subjectId: string;
  title: string;
  detail: string;
  onBehalfOf: string | null;
  since: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  subjectType: string | null;
  subjectId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** Destino na interface de uma notificação ou tarefa (só para assuntos com ecrã). */
export function subjectLink(subjectType: string | null, subjectId: string | null): string | null {
  if (subjectType === 'approval_request' && subjectId) return `/aprovacoes/pedidos/${subjectId}`;
  if (subjectType === 'approval_delegation') return '/aprovacoes/delegacoes';
  return null;
}

/** Painel: dados reais da empresa (sem indicadores fictícios de módulos que ainda não existem). */
@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, PageHeader, ErrorAlert],
  template: `
    @if (workspace.context(); as ctx) {
      <app-page-header
        [title]="ctx.tenant.name"
        [subtitle]="
          ctx.tenant.code + ' · ' + ctx.tenant.countryCode + ' · ' + ctx.tenant.defaultCurrency
        "
      />
      <div class="grid gap-4 md:grid-cols-2">
        <section class="card" aria-labelledby="tasks-title">
          <h2 id="tasks-title" class="font-semibold">As minhas tarefas</h2>
          <app-error-alert [error]="tasks.error()" />
          @if (tasks.loading()) {
            <p class="mt-2 text-sm text-slate-500">A carregar…</p>
          } @else if ((tasks.value() ?? []).length === 0) {
            <p class="mt-2 text-sm text-slate-600" data-testid="no-tasks">Sem tarefas pendentes.</p>
          } @else {
            <ul class="mt-2 divide-y divide-slate-100" data-testid="tasks">
              @for (t of tasks.value(); track t.subjectId + t.onBehalfOf) {
                <li class="py-2 text-sm">
                  <a class="btn-link" [routerLink]="link(t.subjectType, t.subjectId)">{{
                    t.title
                  }}</a>
                  <span class="block text-xs text-slate-500">
                    Etapa: {{ t.detail }}{{ t.onBehalfOf ? ' · por delegação' : '' }} · desde
                    {{ when(t.since) }}
                  </span>
                </li>
              }
            </ul>
          }
        </section>

        <section class="card" aria-labelledby="notif-title">
          <h2 id="notif-title" class="font-semibold">Notificações recentes</h2>
          <app-error-alert [error]="notifications.error()" />
          @if ((notifications.value() ?? []).length === 0 && !notifications.loading()) {
            <p class="mt-2 text-sm text-slate-600">Sem notificações.</p>
          }
          <ul class="mt-2 divide-y divide-slate-100">
            @for (n of notifications.value(); track n.id) {
              <li class="py-2 text-sm" [class.font-medium]="!n.readAt">
                {{ n.title }}
                <span class="block text-xs text-slate-500">{{ when(n.createdAt) }}</span>
              </li>
            }
          </ul>
          <a routerLink="/notificacoes" class="btn-link mt-2 inline-block">Ver todas</a>
        </section>

        <section class="card md:col-span-2" aria-labelledby="sub-title">
          <h2 id="sub-title" class="font-semibold">Subscrição</h2>
          <p class="mt-1 text-sm">
            Estado: <strong>{{ label(ctx.subscriptionStatus) }}</strong>
          </p>
          @if (ctx.features.length === 0) {
            <p class="mt-2 text-sm text-slate-600">
              Nenhuma funcionalidade activa. Contacte o administrador da plataforma.
            </p>
          } @else {
            <ul class="mt-2 flex flex-wrap gap-2 text-xs">
              @for (f of ctx.features; track f.code) {
                <li class="badge bg-slate-100 text-slate-700">
                  {{ f.code }}{{ f.limit !== null ? ' ≤ ' + f.limit : '' }}
                </li>
              }
            </ul>
          }
        </section>
      </div>
    }
  `,
})
export class Dashboard {
  protected readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  protected readonly label = statusLabel;
  protected readonly when = formatDateTime;
  protected readonly link = subjectLink;
  protected readonly tasks = new Loadable(() => this.api.get<Task[]>('me/tasks'));
  protected readonly notifications = new Loadable(() =>
    this.api.get<Notification[]>('me/notifications', { limit: 5 }),
  );

  constructor() {
    void this.tasks.load();
    void this.notifications.load();
  }
}
