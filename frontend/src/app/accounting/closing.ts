import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../core/api';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import {
  type Account,
  type Chart,
  checklistSummary,
  type CloseTask,
  type FiscalYear,
  type Period,
  type PeriodChecklist,
  type YearClosing,
} from './model';
import {
  accountingDeps,
  closeWithWarnings,
  entityReferences,
  legalEntityOptions,
  moneyText,
} from './shared';

/**
 * Fecho contabilístico: checklist de cada período (verificações automáticas e tarefas manuais), fecho/reabertura de
 * períodos e encerramento/reabertura do exercício (apuramento de resultados e transporte de saldos).
 */
@Component({
  selector: 'app-closing',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert],
  template: `
    <app-page-header
      title="Fecho"
      subtitle="Checklist de cada período, fecho mensal e encerramento do exercício. Tudo fica na auditoria."
    />
    <div class="mb-4 flex flex-wrap items-end gap-2">
      <div>
        <label class="label" for="cl-year">Exercício</label>
        <select
          id="cl-year"
          name="year"
          class="input w-72"
          [(ngModel)]="fiscalYearId"
          (ngModelChange)="load()"
        >
          <option [ngValue]="null">—</option>
          @for (y of years(); track y.id) {
            <option [ngValue]="y.id">
              {{ y.code }} — {{ names().get(y.legalEntityId) ?? 'entidade' }}
            </option>
          }
        </select>
      </div>
    </div>
    <app-error-alert [error]="action.error()" [showDetails]="true" />

    @if (fiscalYearId && periods().length) {
      <div class="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <section class="card p-0" aria-labelledby="cl-periods">
          <h2 id="cl-periods" class="p-3 font-semibold">Períodos</h2>
          <ul class="divide-y divide-border text-sm">
            @for (p of periods(); track p.id) {
              <li>
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2"
                  [class.bg-surface-2]="selected()?.period?.id === p.id"
                  [attr.aria-pressed]="selected()?.period?.id === p.id"
                  (click)="select(p)"
                >
                  <span>{{ p.name }}</span>
                  <span
                    class="badge"
                    [class]="
                      p.status === 'CLOSED'
                        ? 'bg-surface-2 text-fg'
                        : 'bg-success-soft text-success-text'
                    "
                    >{{ p.status === 'CLOSED' ? 'Fechado' : 'Aberto' }}</span
                  >
                </button>
              </li>
            }
          </ul>
        </section>

        <div class="space-y-4">
          @if (selected(); as c) {
            <section class="card" aria-labelledby="cl-check">
              <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 id="cl-check" class="font-semibold">Checklist — {{ c.period.name }}</h2>
                <span class="text-sm" data-testid="cl-summary">{{ summary().text }}</span>
              </div>
              <ul class="mb-3 space-y-1 text-sm" data-testid="cl-items">
                @for (i of c.items; track i.code) {
                  <li class="flex gap-2">
                    <span
                      class="badge shrink-0"
                      [class]="
                        i.status === 'OK'
                          ? 'bg-success-soft text-success-text'
                          : i.status === 'WARNING'
                            ? 'bg-warning-soft text-warning-text'
                            : 'bg-danger-soft text-danger-text'
                      "
                      >{{
                        i.status === 'OK' ? 'OK' : i.status === 'WARNING' ? 'Aviso' : 'Bloqueio'
                      }}</span
                    >
                    <span
                      ><strong>{{ i.label }}</strong> — {{ i.message }}</span
                    >
                  </li>
                }
              </ul>
              <h3 class="mb-1 font-semibold">Tarefas</h3>
              @if (c.tasks.length === 0) {
                <p class="text-sm text-muted">Sem tarefas manuais neste período.</p>
              }
              <ul class="mb-2 divide-y divide-border text-sm" data-testid="cl-tasks">
                @for (t of c.tasks; track t.id) {
                  <li class="flex items-center justify-between gap-2 py-1">
                    <label class="flex items-center gap-2">
                      <input
                        type="checkbox"
                        [checked]="t.done"
                        [disabled]="
                          !canClose() || c.period.status === 'CLOSED' || taskAction.busy()
                        "
                        (change)="toggle(t)"
                      />
                      <span [class.line-through]="t.done">{{ t.title }}</span>
                      @if (t.doneAt) {
                        <span class="text-xs text-muted">({{ day(t.doneAt) }})</span>
                      }
                    </label>
                    @if (canClose() && c.period.status === 'OPEN') {
                      <button
                        type="button"
                        class="btn-ghost px-2"
                        [attr.aria-label]="'Apagar tarefa ' + t.title"
                        (click)="deleteTask(t)"
                      >
                        ✕
                      </button>
                    }
                  </li>
                }
              </ul>
              @if (canClose() && c.period.status === 'OPEN') {
                <form
                  class="flex flex-wrap items-end gap-2"
                  (ngSubmit)="addTask()"
                  aria-label="Nova tarefa"
                >
                  <div class="min-w-56 flex-1">
                    <label class="label" for="cl-task">Nova tarefa</label>
                    <input
                      id="cl-task"
                      name="task"
                      class="input"
                      [(ngModel)]="taskTitle"
                      placeholder="P. ex. Conciliar a conta bancária"
                    />
                  </div>
                  <button
                    type="submit"
                    class="btn-secondary"
                    [disabled]="taskAction.busy() || taskTitle.trim().length < 3"
                  >
                    Acrescentar
                  </button>
                  <button
                    type="button"
                    class="btn-ghost"
                    [disabled]="taskAction.busy()"
                    (click)="copyTasks()"
                  >
                    Copiar do período anterior
                  </button>
                </form>
              }
              <app-error-alert [error]="taskAction.error()" />
              <div class="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                @if (c.period.status === 'OPEN' && canClose()) {
                  <button
                    type="button"
                    class="btn-primary"
                    [disabled]="action.busy() || summary().blocking > 0"
                    (click)="closePeriod()"
                  >
                    Fechar {{ c.period.name }}
                  </button>
                }
                @if (
                  c.period.status === 'CLOSED' &&
                  canReopen() &&
                  year()?.fiscalYear?.status === 'OPEN'
                ) {
                  <form
                    class="flex flex-wrap items-end gap-2"
                    (ngSubmit)="reopenPeriod()"
                    aria-label="Reabrir período"
                  >
                    <div>
                      <label class="label" for="cl-reason">Motivo da reabertura</label>
                      <input
                        id="cl-reason"
                        name="reason"
                        class="input w-72"
                        [(ngModel)]="periodReason"
                      />
                    </div>
                    <button
                      type="submit"
                      class="btn-secondary"
                      [disabled]="action.busy() || periodReason.trim().length < 5"
                    >
                      Reabrir
                    </button>
                  </form>
                }
              </div>
            </section>
          }

          @if (year(); as y) {
            <section class="card" aria-labelledby="cl-year-close">
              <h2 id="cl-year-close" class="mb-2 font-semibold">
                Exercício {{ y.fiscalYear.code }} —
                <span data-testid="cl-year-status">{{
                  y.fiscalYear.status === 'CLOSED' ? 'Encerrado' : 'Aberto'
                }}</span>
              </h2>
              <p class="mb-2 text-sm">
                Resultado líquido a apurar:
                <strong data-testid="cl-net">{{ money(y.netResult) }}</strong> ({{
                  y.profitAndLoss.length
                }}
                saldo(s) de resultados).
              </p>
              @if (y.fiscalYear.status === 'OPEN') {
                @if (y.openPeriods.length) {
                  <p class="mb-2 text-sm text-warning-text">
                    Para encerrar, feche primeiro: {{ y.openPeriods.join(', ') }}.
                  </p>
                }
                @if (canClose()) {
                  <form
                    class="flex flex-wrap items-end gap-2"
                    (ngSubmit)="closeYear()"
                    aria-label="Encerrar exercício"
                  >
                    <div>
                      <label class="label" for="cl-result"
                        >Conta de resultado (capital próprio)</label
                      >
                      <select
                        id="cl-result"
                        name="result"
                        class="input w-64"
                        [(ngModel)]="resultAccountId"
                      >
                        <option [ngValue]="null">—</option>
                        @for (a of equityAccounts(); track a.id) {
                          <option [ngValue]="a.id">{{ a.code }} — {{ a.name }}</option>
                        }
                      </select>
                    </div>
                    <div>
                      <label class="label" for="cl-journal">Diário</label>
                      <select
                        id="cl-journal"
                        name="journal"
                        class="input w-48"
                        [(ngModel)]="journalId"
                      >
                        <option [ngValue]="null">—</option>
                        @for (j of journals(); track j.id) {
                          <option [ngValue]="j.id">{{ j.label }}</option>
                        }
                      </select>
                    </div>
                    <div>
                      <label class="label" for="cl-next">Transportar saldos para</label>
                      <select
                        id="cl-next"
                        name="next"
                        class="input w-48"
                        [(ngModel)]="nextFiscalYearId"
                      >
                        <option [ngValue]="null">Não transportar</option>
                        @for (n of y.nextFiscalYears; track n.id) {
                          <option [ngValue]="n.id">{{ n.code }}</option>
                        }
                      </select>
                    </div>
                    <button
                      type="submit"
                      class="btn-primary"
                      [disabled]="
                        action.busy() || !resultAccountId || !journalId || y.openPeriods.length > 0
                      "
                    >
                      Encerrar exercício
                    </button>
                  </form>
                }
              }
              @if (y.history.length) {
                <h3 class="mt-3 mb-1 font-semibold">Histórico</h3>
                <ul class="divide-y divide-border text-sm" data-testid="cl-history">
                  @for (h of y.history; track h.id) {
                    <li class="py-1">
                      {{ h.status === 'ACTIVE' ? 'Encerrado' : 'Reaberto' }} · resultado
                      {{ money(h.netResult) }}
                      @if (h.closingEntryId) {
                        · apuramento
                        <a
                          class="btn-link"
                          [routerLink]="['/contabilidade/lancamentos', h.closingEntryId]"
                          >{{ h.closingEntryNumber }}</a
                        >
                      }
                      @if (h.openingEntryId) {
                        · transporte
                        <a
                          class="btn-link"
                          [routerLink]="['/contabilidade/lancamentos', h.openingEntryId]"
                          >{{ h.openingEntryNumber }}</a
                        >
                      }
                      @if (h.reopenReason) {
                        <span class="text-muted"> — {{ h.reopenReason }}</span>
                      }
                    </li>
                  }
                </ul>
              }
              @if (y.fiscalYear.status === 'CLOSED' && canReopen()) {
                <form
                  class="mt-3 flex flex-wrap items-end gap-2"
                  (ngSubmit)="reopenYear()"
                  aria-label="Reabrir exercício"
                >
                  <div>
                    <label class="label" for="cl-year-reason"
                      >Motivo da reabertura do exercício</label
                    >
                    <input
                      id="cl-year-reason"
                      name="yearReason"
                      class="input w-80"
                      [(ngModel)]="yearReason"
                    />
                  </div>
                  <button
                    type="submit"
                    class="btn-danger"
                    [disabled]="action.busy() || yearReason.trim().length < 5"
                  >
                    Reabrir exercício
                  </button>
                </form>
              }
            </section>
          }
        </div>
      </div>
    }
  `,
})
export class ClosingPage {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly canClose = computed(() => this.deps.workspace.can('accounting.close'));
  protected readonly canReopen = computed(() => this.deps.workspace.can('accounting.reopen'));
  protected readonly years = signal<FiscalYear[]>([]);
  protected readonly periods = signal<Period[]>([]);
  protected readonly selected = signal<PeriodChecklist | null>(null);
  protected readonly year = signal<YearClosing | null>(null);
  protected readonly equityAccounts = signal<Account[]>([]);
  protected readonly journals = signal<{ id: string; label: string }[]>([]);
  private readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly summary = computed(() => checklistSummary(this.selected()?.items ?? []));
  protected readonly action = new Action();
  protected readonly taskAction = new Action();
  protected fiscalYearId: string | null = null;
  protected taskTitle = '';
  protected periodReason = '';
  protected yearReason = '';
  protected resultAccountId: string | null = null;
  protected journalId: string | null = null;
  protected nextFiscalYearId: string | null = null;

  constructor() {
    this.deps.api.page<FiscalYear>('accounting/fiscal-years', { limit: 100 }).then(
      (p) => this.years.set(p.items),
      () => undefined,
    );
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (e) => this.entities.set(e),
      () => undefined,
    );
  }

  protected money(v: string) {
    return moneyText(v);
  }
  protected day(v: string) {
    return formatDate(v.slice(0, 10));
  }

  protected async load() {
    this.selected.set(null);
    this.year.set(null);
    this.periods.set([]);
    this.resultAccountId = null;
    this.journalId = null;
    this.nextFiscalYearId = null;
    const id = this.fiscalYearId;
    if (!id) return;
    const y = await this.deps.api.get<FiscalYear>(`accounting/fiscal-years/${id}`);
    if (id !== this.fiscalYearId) return;
    this.periods.set(y.periods ?? []);
    await this.loadYear();
    const [refs, charts] = await Promise.all([
      entityReferences(this.deps.api, this.deps.workspace, y.legalEntityId),
      this.deps.api.page<Chart>('accounting/charts', {
        legalEntityId: y.legalEntityId,
        status: 'ACTIVE',
        limit: 1,
      }),
    ]);
    this.journals.set(refs.journals);
    if (refs.journals.length === 1) this.journalId = refs.journals[0].id;
    const chart = charts.items[0];
    this.equityAccounts.set(
      chart
        ? (
            await this.deps.api.page<Account>('accounting/accounts', {
              chartId: chart.id,
              nature: 'EQUITY',
              postable: 'true',
              limit: 200,
            })
          ).items.filter((a) => a.status === 'ACTIVE')
        : [],
    );
  }

  private async loadYear() {
    if (!this.fiscalYearId) return;
    this.year.set(
      await this.deps.api.get<YearClosing>(`accounting/fiscal-years/${this.fiscalYearId}/closing`),
    );
  }

  private async refreshPeriods() {
    const y = await this.deps.api.get<FiscalYear>(`accounting/fiscal-years/${this.fiscalYearId}`);
    this.periods.set(y.periods ?? []);
  }

  protected async select(p: Period) {
    const c = await this.action.run(() =>
      this.deps.api.get<PeriodChecklist>(`accounting/periods/${p.id}/checklist`),
    );
    if (c) this.selected.set(c);
    this.periodReason = '';
  }

  private async reloadSelected() {
    const p = this.selected()?.period;
    if (p)
      this.selected.set(
        await this.deps.api.get<PeriodChecklist>(`accounting/periods/${p.id}/checklist`),
      );
  }

  protected async addTask() {
    const p = this.selected()!.period;
    const r = await this.taskAction.run(() =>
      this.deps.api.post<CloseTask[]>(`accounting/periods/${p.id}/tasks`, {
        title: this.taskTitle.trim(),
      }),
    );
    if (!r) return;
    this.taskTitle = '';
    await this.reloadSelected();
  }

  protected async copyTasks() {
    const p = this.selected()!.period;
    const r = await this.taskAction.run(() =>
      this.deps.api.post<CloseTask[]>(`accounting/periods/${p.id}/tasks/copy`, {}),
    );
    if (!r) return;
    this.toasts.show(r.length ? `${r.length} tarefa(s) no período.` : 'Não há tarefas a copiar.');
    await this.reloadSelected();
  }

  protected async toggle(t: CloseTask) {
    const r = await this.taskAction.run(() =>
      this.deps.api.patch<CloseTask[]>(`accounting/close-tasks/${t.id}`, {
        expectedVersion: t.version,
        done: !t.done,
      }),
    );
    if (r) await this.reloadSelected();
  }

  protected async deleteTask(t: CloseTask) {
    const done = await this.taskAction.run(async () => {
      await this.deps.api.delete(`accounting/close-tasks/${t.id}`);
      return true;
    });
    if (done) await this.reloadSelected();
  }

  protected async closePeriod() {
    const p = this.selected()!.period;
    const ok = await this.confirm.ask({
      title: `Fechar ${p.name}`,
      message: 'Deixa de ser possível submeter, aprovar ou contabilizar lançamentos neste período.',
      confirmLabel: 'Fechar período',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      closeWithWarnings<Period[]>(this.deps.api, this.confirm, p.id, p.name),
    );
    if (!r) return;
    this.periods.set(r);
    this.toasts.show(`${p.name} fechado.`);
    await Promise.all([this.reloadSelected(), this.loadYear()]);
  }

  protected async reopenPeriod() {
    const p = this.selected()!.period;
    const r = await this.action.run(() =>
      this.deps.api.post<Period[]>(`accounting/periods/${p.id}/reopen`, {
        reason: this.periodReason,
      }),
    );
    if (!r) return;
    this.periods.set(r);
    this.periodReason = '';
    this.toasts.show(`${p.name} reaberto.`);
    await Promise.all([this.reloadSelected(), this.loadYear()]);
  }

  protected async closeYear() {
    const y = this.year()!;
    const ok = await this.confirm.ask({
      title: `Encerrar ${y.fiscalYear.code}`,
      message: `Apurar o resultado (${this.money(y.netResult)})${this.nextFiscalYearId ? ', transportar os saldos para o exercício seguinte' : ''} e fechar o exercício? Os lançamentos ficam contabilizados; para corrigir, reabre-se o exercício.`,
      confirmLabel: 'Encerrar',
    });
    if (!ok) return;
    const body = {
      resultAccountId: this.resultAccountId,
      journalId: this.journalId,
      nextFiscalYearId: this.nextFiscalYearId ?? undefined,
    };
    const r = await this.action.run(async () => {
      try {
        return await this.deps.api.post(`accounting/fiscal-years/${y.fiscalYear.id}/close`, body);
      } catch (e) {
        const err = ApiError.from(e);
        if (err.code !== 'CLOSE_WARNINGS') throw err;
        const go = await this.confirm.ask({
          title: 'Encerrar com avisos',
          message: err.details.map((d) => d.message).join(' '),
          confirmLabel: 'Encerrar mesmo assim',
        });
        if (!go) return undefined;
        return this.deps.api.post(`accounting/fiscal-years/${y.fiscalYear.id}/close`, {
          ...body,
          acknowledgeWarnings: true,
        });
      }
    });
    if (!r) return;
    this.toasts.show(`Exercício ${y.fiscalYear.code} encerrado.`);
    await Promise.all([this.loadYear(), this.refreshPeriods()]);
  }

  protected async reopenYear() {
    const y = this.year()!;
    const ok = await this.confirm.ask({
      title: `Reabrir ${y.fiscalYear.code}`,
      message:
        'O apuramento e o transporte de saldos são estornados; o período de regularizações volta a abrir.',
      confirmLabel: 'Reabrir exercício',
      danger: true,
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.deps.api.post(`accounting/fiscal-years/${y.fiscalYear.id}/reopen`, {
        reason: this.yearReason,
      }),
    );
    if (!r) return;
    this.yearReason = '';
    this.toasts.show(`Exercício ${y.fiscalYear.code} reaberto.`);
    await Promise.all([this.loadYear(), this.refreshPeriods()]);
  }
}
