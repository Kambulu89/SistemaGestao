import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDate, formatDateTime } from '../ui/dates';
import { type Bar, BarChart } from '../ui/bar-chart';
import { ErrorState, Skeleton } from '../ui/states';
import { Icon } from '../ui/icon';
import { StatusBadge } from '../ui/status-badge';
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

interface Summary {
  subscriptionStatus: string;
  members: Record<string, number> | null;
  organization: Record<string, number> | null;
  approvals: {
    scope: 'TENANT' | 'MINE';
    tasks: number;
    myOpen: number;
    byStatus: Record<string, number>;
    weekly: { week: string; count: number }[];
  } | null;
  usage: Record<
    'members' | 'legalEntities' | 'storageMb',
    { used: number; limit: number | null; enabled: boolean }
  > | null;
  activity:
    | { id: string; occurredAt: string; action: string; entityType: string; actor: string | null }[]
    | null;
}

/**
 * Painel: indicadores reais da empresa, cada um só com a permissão e a funcionalidade do módulo dono (o servidor manda
 * `null` no que o membro não pode ver). Se a API falhar, os cartões dizem "indisponível" em vez de inventar números.
 */
@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, PageHeader, ErrorState, Skeleton, BarChart, Icon, StatusBadge],
  template: `
    @if (workspace.context(); as ctx) {
      <app-page-header
        [title]="ctx.tenant.name"
        [subtitle]="
          ctx.tenant.code + ' · ' + ctx.tenant.countryCode + ' · ' + ctx.tenant.defaultCurrency
        "
      />
      @if (summary.error()) {
        <app-error-state [error]="summary.error()" (retry)="summary.load()" />
      } @else if (summary.loading() && !summary.value()) {
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          @for (i of [1, 2, 3, 4]; track i) {
            <div class="card"><app-skeleton /></div>
          }
        </div>
      } @else if (summary.value(); as s) {
        <section aria-label="Indicadores" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <a
            routerLink="/aprovacoes"
            class="card focus-ring block hover:border-primary"
            [class.pointer-events-none]="!s.approvals"
          >
            <p class="text-sm text-muted">Aprovações para decidir</p>
            <p class="mt-1 text-3xl font-semibold" data-testid="kpi-tasks">
              {{ s.approvals ? s.approvals.tasks : '—' }}
            </p>
            <p class="text-xs text-muted">
              {{
                s.approvals
                  ? s.approvals.myOpen + ' pedido(s) meus em curso'
                  : 'Funcionalidade não contratada'
              }}
            </p>
          </a>
          <div class="card">
            <p class="text-sm text-muted">Membros activos</p>
            <p class="mt-1 text-3xl font-semibold">
              {{ s.members ? (s.members['ACTIVE'] ?? 0) : '—' }}
            </p>
            <p class="text-xs text-muted">
              {{
                s.members ? (s.members['INVITED'] ?? 0) + ' convite(s) pendente(s)' : 'Sem acesso'
              }}
            </p>
          </div>
          <div class="card">
            <p class="text-sm text-muted">Entidades legais activas</p>
            <p class="mt-1 text-3xl font-semibold">
              {{ s.organization ? s.organization['legalEntities'] : '—' }}
            </p>
            <p class="text-xs text-muted">
              {{
                s.organization
                  ? s.organization['branches'] +
                    ' filial(ais) · ' +
                    s.organization['departments'] +
                    ' departamento(s)'
                  : 'Sem acesso'
              }}
            </p>
          </div>
          <div class="card">
            <p class="text-sm text-muted">Subscrição</p>
            <p class="mt-2"><app-status-badge [status]="s.subscriptionStatus" /></p>
            <p class="mt-1 text-xs text-muted">
              {{ ctx.features.length }} funcionalidade(s) activa(s)
            </p>
          </div>
        </section>

        <div class="mt-4 grid gap-4 lg:grid-cols-3">
          <section class="card lg:col-span-2" aria-labelledby="chart-title">
            <h2 id="chart-title" class="font-semibold">Pedidos de aprovação</h2>
            @if (s.approvals; as a) {
              <p class="text-xs text-muted">
                {{ a.scope === 'TENANT' ? 'Toda a empresa' : 'Pedidos em que participo' }} · últimas
                8 semanas
              </p>
              <app-bar-chart title="Pedidos criados por semana" [bars]="weekly(a.weekly)" />
              <app-bar-chart title="Pedidos por estado" [bars]="byStatus(a.byStatus)" />
            } @else {
              <p class="mt-2 text-sm text-muted">
                Indisponível: a empresa não tem aprovações contratadas.
              </p>
            }
          </section>
          <section class="card" aria-labelledby="usage-title">
            <h2 id="usage-title" class="font-semibold">Utilização do plano</h2>
            @if (s.usage; as u) {
              @for (m of meters(u); track m.label) {
                <div class="mt-3">
                  <div class="flex justify-between text-sm">
                    <span>{{ m.label }}</span
                    ><span class="text-muted">{{ m.text }}</span>
                  </div>
                  @if (m.percent !== null) {
                    <div
                      class="mt-1 h-2 rounded bg-surface-2"
                      role="meter"
                      [attr.aria-label]="m.label"
                      aria-valuemin="0"
                      [attr.aria-valuemax]="m.limit"
                      [attr.aria-valuenow]="m.used"
                    >
                      <div
                        class="h-2 rounded"
                        [class.bg-primary]="m.percent < 90"
                        [class.bg-danger]="m.percent >= 90"
                        [style.width.%]="m.percent"
                      ></div>
                    </div>
                  }
                </div>
              }
            } @else {
              <p class="mt-2 text-sm text-muted">Sem acesso (subscription.read).</p>
            }
          </section>
        </div>

        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <section class="card" aria-labelledby="tasks-title">
            <h2 id="tasks-title" class="font-semibold">As minhas tarefas</h2>
            @if ((tasks.value() ?? []).length === 0 && !tasks.loading()) {
              <p class="mt-2 text-sm text-muted" data-testid="no-tasks">Sem tarefas pendentes.</p>
            }
            <ul class="mt-2 divide-y divide-border" data-testid="tasks">
              @for (t of tasks.value(); track t.subjectId + t.onBehalfOf) {
                <li class="py-2 text-sm">
                  <a class="btn-link" [routerLink]="link(t.subjectType, t.subjectId)">{{
                    t.title
                  }}</a>
                  <span class="block text-xs text-muted"
                    >Etapa: {{ t.detail }}{{ t.onBehalfOf ? ' · por delegação' : '' }} · desde
                    {{ when(t.since) }}</span
                  >
                </li>
              }
            </ul>
          </section>
          <section class="card" aria-labelledby="activity-title">
            <h2 id="activity-title" class="font-semibold">Actividade recente</h2>
            @if (s.activity; as items) {
              <ul class="mt-2 divide-y divide-border">
                @for (e of items; track e.id) {
                  <li class="flex items-start gap-2 py-2 text-sm">
                    <app-icon name="history" [size]="16" />
                    <span>
                      <span class="font-mono text-xs">{{ e.action }}</span>
                      <span class="block text-xs text-muted"
                        >{{ e.actor ?? 'Sistema' }} · {{ when(e.occurredAt) }}</span
                      >
                    </span>
                  </li>
                } @empty {
                  <li class="py-2 text-sm text-muted">Sem actividade.</li>
                }
              </ul>
              <a routerLink="/auditoria" class="btn-link mt-2 inline-block">Ver auditoria</a>
            } @else {
              <p class="mt-2 text-sm text-muted">Sem acesso à auditoria.</p>
            }
          </section>
        </div>
      }
    }
  `,
})
export class Dashboard {
  protected readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  protected readonly when = formatDateTime;
  protected readonly link = subjectLink;
  protected readonly summary = new Loadable(() => this.api.get<Summary>('dashboard'));
  protected readonly tasks = new Loadable(() => this.api.get<Task[]>('me/tasks'));

  constructor() {
    void this.summary.load();
    void this.tasks.load();
  }

  protected weekly(weeks: { week: string; count: number }[]): Bar[] {
    return weeks.map((w) => ({ label: formatDate(w.week).slice(0, 5), value: w.count }));
  }

  protected byStatus(counts: Record<string, number>): Bar[] {
    return ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => ({
      label: statusLabel(s),
      value: counts[s] ?? 0,
    }));
  }

  protected meters(u: NonNullable<Summary['usage']>) {
    const row = (
      label: string,
      m: { used: number; limit: number | null; enabled: boolean },
      unit = '',
    ) => ({
      label,
      used: m.used,
      limit: m.limit,
      percent: m.enabled && m.limit ? Math.min(100, Math.round((m.used / m.limit) * 100)) : null,
      text: !m.enabled
        ? 'Não contratado'
        : m.limit === null
          ? `${m.used}${unit} · sem limite`
          : `${m.used}${unit} de ${m.limit}${unit}`,
    });
    return [
      row('Membros', u.members),
      row('Entidades legais', u.legalEntities),
      row('Anexos', u.storageMb, ' MB'),
    ];
  }
}
