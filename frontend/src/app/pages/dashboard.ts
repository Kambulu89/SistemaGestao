import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDate, formatDateTime } from '../ui/dates';
import { type Bar, BarChart } from '../ui/bar-chart';
import { EmptyState, ErrorState, Skeleton } from '../ui/states';
import { Kpi } from '../ui/kpi';
import { Favorites, Recents } from '../core/personal';
import { ToastService } from '../ui/toasts';
import {
  type DashboardLayout,
  type WidgetState,
  arrange,
  move,
  toLayout,
} from './dashboard-layout';
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
 * Painel personalizável (blocos visíveis e ordem por membro, guardados no servidor): indicadores reais da empresa, cada um só com a permissão e a funcionalidade do módulo dono (o servidor manda
 * `null` no que o membro não pode ver). Se a API falhar, os cartões dizem "indisponível" em vez de inventar números.
 */
@Component({
  selector: 'app-dashboard',
  imports: [
    RouterLink,
    PageHeader,
    ErrorState,
    EmptyState,
    Skeleton,
    BarChart,
    Icon,
    StatusBadge,
    Kpi,
  ],
  template: `
    @if (workspace.context(); as ctx) {
      <app-page-header
        [title]="ctx.tenant.name"
        [subtitle]="
          ctx.tenant.code + ' · ' + ctx.tenant.countryCode + ' · ' + ctx.tenant.defaultCurrency
        "
      >
        @if (!editing()) {
          <button type="button" class="btn-secondary" data-testid="customize" (click)="edit()">
            <app-icon name="settings" [size]="16" /> Personalizar painel
          </button>
        }
      </app-page-header>

      @if (editing()) {
        <section class="card mb-4" aria-labelledby="customize-title" data-testid="customize-panel">
          <h2 id="customize-title" class="font-semibold">Personalizar painel</h2>
          <p class="text-sm text-muted">
            Escolha os blocos visíveis e a ordem. Fica guardado para si nesta empresa.
          </p>
          <ul class="mt-3 divide-y divide-border">
            @for (w of draft(); track w.id; let i = $index; let first = $first; let last = $last) {
              <li class="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  class="size-4"
                  [id]="'w-' + w.id"
                  [checked]="w.visible"
                  (change)="setVisible(i, $any($event.target).checked)"
                />
                <label [for]="'w-' + w.id" class="flex-1 text-sm">{{ w.title }}</label>
                <button
                  type="button"
                  class="btn-ghost px-2"
                  [disabled]="first"
                  [attr.aria-label]="'Subir ' + w.title"
                  (click)="shift(i, -1)"
                >
                  <app-icon name="arrowUp" [size]="16" />
                </button>
                <button
                  type="button"
                  class="btn-ghost px-2"
                  [disabled]="last"
                  [attr.aria-label]="'Descer ' + w.title"
                  (click)="shift(i, 1)"
                >
                  <app-icon name="arrowDown" [size]="16" />
                </button>
              </li>
            }
          </ul>
          <div class="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" class="btn-ghost" (click)="reset()">Repor predefinição</button>
            <button type="button" class="btn-secondary" (click)="editing.set(false)">
              Cancelar
            </button>
            <button
              type="button"
              class="btn-primary"
              data-testid="save-layout"
              [disabled]="saving()"
              (click)="saveLayout()"
            >
              {{ saving() ? 'A guardar…' : 'Guardar' }}
            </button>
          </div>
        </section>
      }

      @if (summary.error()) {
        <app-error-state [error]="summary.error()" (retry)="summary.load()" />
      } @else if (summary.loading() && !summary.value()) {
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          @for (i of [1, 2, 3, 4]; track i) {
            <div class="card"><app-skeleton /></div>
          }
        </div>
      } @else if (summary.value(); as s) {
        <div class="grid gap-4 lg:grid-cols-3" data-testid="widgets">
          @for (w of visible(); track w.id) {
            @switch (w.id) {
              @case ('kpis') {
                <section
                  aria-label="Indicadores"
                  class="grid gap-4 sm:grid-cols-2 lg:col-span-3 lg:grid-cols-4"
                  data-widget="kpis"
                >
                  <app-kpi
                    label="Aprovações para decidir"
                    icon="approvals"
                    testId="kpi-tasks"
                    [link]="s.approvals ? '/aprovacoes' : null"
                    [value]="s.approvals ? s.approvals.tasks : null"
                    [tone]="s.approvals && s.approvals.tasks > 0 ? 'warning' : 'neutral'"
                    [detail]="
                      s.approvals
                        ? s.approvals.myOpen + ' pedido(s) meus em curso'
                        : 'Funcionalidade não contratada'
                    "
                  />
                  <app-kpi
                    label="Membros activos"
                    icon="users"
                    [value]="s.members ? (s.members['ACTIVE'] ?? 0) : null"
                    [detail]="
                      s.members
                        ? (s.members['INVITED'] ?? 0) + ' convite(s) pendente(s)'
                        : 'Sem acesso'
                    "
                  />
                  <app-kpi
                    label="Entidades legais activas"
                    icon="building"
                    [value]="s.organization ? s.organization['legalEntities'] : null"
                    [detail]="
                      s.organization
                        ? s.organization['branches'] +
                          ' filial(ais) · ' +
                          s.organization['departments'] +
                          ' departamento(s)'
                        : 'Sem acesso'
                    "
                  />
                  <app-kpi
                    label="Subscrição"
                    icon="card"
                    value=""
                    [tone]="s.subscriptionStatus === 'ACTIVE' ? 'success' : 'warning'"
                    [detail]="ctx.features.length + ' funcionalidade(s) activa(s)'"
                    ><app-status-badge [status]="s.subscriptionStatus"
                  /></app-kpi>
                </section>
              }
              @case ('approvals-chart') {
                <section
                  class="card lg:col-span-2"
                  aria-labelledby="chart-title"
                  data-widget="approvals-chart"
                >
                  <h2 id="chart-title" class="font-semibold">Pedidos de aprovação</h2>
                  @if (s.approvals; as a) {
                    <p class="text-xs text-muted">
                      {{ a.scope === 'TENANT' ? 'Toda a empresa' : 'Pedidos em que participo' }} ·
                      últimas 8 semanas
                    </p>
                    <app-bar-chart title="Pedidos criados por semana" [bars]="weekly(a.weekly)" />
                    <app-bar-chart title="Pedidos por estado" [bars]="byStatus(a.byStatus)" />
                  } @else {
                    <p class="mt-2 text-sm text-muted">
                      Indisponível: a empresa não tem aprovações contratadas.
                    </p>
                  }
                </section>
              }
              @case ('usage') {
                <section class="card" aria-labelledby="usage-title" data-widget="usage">
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
                              [class.bg-primary]="m.percent < 75"
                              [class.bg-warning]="m.percent >= 75 && m.percent < 90"
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
              }
              @case ('tasks') {
                <section class="card" aria-labelledby="tasks-title" data-widget="tasks">
                  <h2 id="tasks-title" class="font-semibold">As minhas tarefas</h2>
                  @if ((tasks.value() ?? []).length === 0 && !tasks.loading()) {
                    <p class="mt-2 text-sm text-muted" data-testid="no-tasks">
                      Sem tarefas pendentes.
                    </p>
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
              }
              @case ('activity') {
                <section class="card" aria-labelledby="activity-title" data-widget="activity">
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
              }
              @case ('shortcuts') {
                <section class="card" aria-labelledby="shortcuts-title" data-widget="shortcuts">
                  <h2 id="shortcuts-title" class="font-semibold">Favoritos e recentes</h2>
                  @if (favorites.list().length === 0 && recentOnly().length === 0) {
                    <p class="mt-2 text-sm text-muted">
                      Marque páginas com a estrela junto ao trilho; as visitadas aparecem aqui.
                    </p>
                  }
                  <ul class="mt-2 space-y-1 text-sm">
                    @for (f of favorites.list(); track f.path) {
                      <li class="flex items-center gap-2">
                        <app-icon name="star" [size]="14" />
                        <a class="btn-link font-normal" [routerLink]="f.path">{{ f.title }}</a>
                      </li>
                    }
                    @for (r of recentOnly(); track r.path) {
                      <li class="flex items-center gap-2">
                        <app-icon name="clock" [size]="14" />
                        <a class="btn-link font-normal" [routerLink]="r.path">{{ r.title }}</a>
                      </li>
                    }
                  </ul>
                </section>
              }
            }
          } @empty {
            <app-empty-state
              class="lg:col-span-3"
              title="Painel vazio"
              description="Todos os blocos estão escondidos. Use Personalizar painel para os mostrar."
            />
          }
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

  protected readonly favorites = inject(Favorites);
  protected readonly recents = inject(Recents);
  private readonly toasts = inject(ToastService);
  /** Disposição guardada no servidor (`/me/preferences/dashboard`); sem ela, a predefinição. */
  private readonly layout = signal<DashboardLayout | null>(null);
  protected readonly visible = computed(() => arrange(this.layout()).filter((w) => w.visible));
  /** Recentes que não estão já nos favoritos. */
  protected readonly recentOnly = computed(() =>
    this.recents.list().filter((r) => !this.favorites.has(r.path)),
  );
  protected readonly editing = signal(false);
  protected readonly draft = signal<WidgetState[]>([]);
  protected readonly saving = signal(false);

  constructor() {
    void this.summary.load();
    void this.tasks.load();
    this.api
      .get<DashboardLayout | null>('me/preferences/dashboard')
      .then((v) => this.layout.set(v))
      .catch(() => this.layout.set(null));
  }

  protected edit() {
    this.draft.set(arrange(this.layout()));
    this.editing.set(true);
  }

  protected setVisible(index: number, visible: boolean) {
    this.draft.set(this.draft().map((w, i) => (i === index ? { ...w, visible } : w)));
  }

  protected shift(index: number, delta: -1 | 1) {
    this.draft.set(move(this.draft(), index, delta));
  }

  protected reset() {
    this.draft.set(arrange(null));
  }

  protected async saveLayout() {
    this.saving.set(true);
    try {
      const saved = await this.api.put<DashboardLayout>('me/preferences/dashboard', {
        value: toLayout(this.draft()),
      });
      this.layout.set(saved);
      this.editing.set(false);
      this.toasts.show('Painel guardado.');
    } catch {
      this.toasts.show('Não foi possível guardar o painel.', 'error');
    } finally {
      this.saving.set(false);
    }
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
