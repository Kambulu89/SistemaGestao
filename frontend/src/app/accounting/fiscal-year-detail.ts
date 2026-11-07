import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import type { FiscalYear, Period } from './model';
import { accountingDeps } from './shared';

const KIND: Record<string, string> = {
  OPENING: 'Abertura',
  NORMAL: 'Mensal',
  CLOSING: 'Regularizações',
};

/** Períodos de um exercício com fecho (sem pendentes) e reabertura (com motivo), ambos auditados. */
@Component({
  selector: 'app-fiscal-year-detail',
  imports: [FormsModule, RouterLink, PageDetail, ErrorAlert, ErrorState, Skeleton, AuditHistory],
  template: `
    @if (year.error()) {
      <app-error-state [error]="year.error()" (retry)="year.load()" />
    } @else if (!year.value()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let y = year.value()!;
      <app-page-detail
        [title]="'Exercício ' + y.code"
        [subtitle]="date(y.startDate) + ' a ' + date(y.endDate)"
      >
        <ng-container actions
          ><a class="btn-secondary" routerLink="/contabilidade/exercicios">Voltar</a></ng-container
        >
        <app-error-alert [error]="action.error()" />
        <section class="card overflow-x-auto p-0">
          <table class="w-full text-sm">
            <caption class="sr-only">
              Períodos do exercício
            </caption>
            <thead>
              <tr class="border-b border-border text-left">
                <th scope="col" class="p-2">Período</th>
                <th scope="col" class="p-2">Tipo</th>
                <th scope="col" class="p-2">Datas</th>
                <th scope="col" class="p-2">Estado</th>
                <th scope="col" class="p-2"><span class="sr-only">Acções</span></th>
              </tr>
            </thead>
            <tbody>
              @for (p of periods(); track p.id) {
                <tr class="border-b border-border">
                  <td class="p-2 font-medium">{{ p.name }}</td>
                  <td class="p-2">{{ kind(p.kind) }}</td>
                  <td class="p-2">{{ date(p.startDate) }} – {{ date(p.endDate) }}</td>
                  <td class="p-2">
                    <span
                      class="badge"
                      [class]="
                        p.status === 'OPEN'
                          ? 'bg-success-soft text-success-text'
                          : 'bg-surface-2 text-fg'
                      "
                      >{{ p.status === 'OPEN' ? 'Aberto' : 'Fechado' }}</span
                    >
                  </td>
                  <td class="p-2 text-right">
                    @if (p.status === 'OPEN' && canClose()) {
                      <button
                        type="button"
                        class="btn-secondary"
                        [disabled]="action.busy()"
                        (click)="close(p)"
                      >
                        Fechar
                      </button>
                    } @else if (p.status === 'CLOSED' && canReopen()) {
                      <button
                        type="button"
                        class="btn-secondary"
                        [disabled]="action.busy()"
                        (click)="reopening.set(p)"
                      >
                        Reabrir
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
        @if (reopening(); as p) {
          <form
            class="card mt-4 flex flex-wrap items-end gap-2"
            (ngSubmit)="reopen(p)"
            aria-label="Reabrir período"
          >
            <div class="grow">
              <label class="label" for="reason">Motivo da reabertura de {{ p.name }}</label>
              <input id="reason" name="reason" class="input" [(ngModel)]="reason" />
            </div>
            <button
              type="submit"
              class="btn-primary"
              [disabled]="action.busy() || reason.trim().length < 5"
            >
              Reabrir
            </button>
            <button type="button" class="btn-secondary" (click)="reopening.set(null)">
              Cancelar
            </button>
          </form>
        }
        <div aside>
          <app-audit-history entityType="fiscal_year" [entityId]="y.id" [refreshKey]="refresh()" />
        </div>
      </app-page-detail>
    }
  `,
})
export class FiscalYearDetail {
  readonly id = input.required<string>();
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly date = formatDate;
  protected readonly kind = (k: string) => KIND[k] ?? k;
  protected readonly canClose = computed(() => this.deps.workspace.can('accounting.close'));
  protected readonly canReopen = computed(() => this.deps.workspace.can('accounting.reopen'));
  protected readonly periods = signal<Period[]>([]);
  protected readonly reopening = signal<Period | null>(null);
  protected readonly refresh = signal(0);
  protected readonly action = new Action();
  protected reason = '';
  protected readonly year = new Loadable(async () => {
    const y = await this.deps.api.get<FiscalYear>(`accounting/fiscal-years/${this.id()}`);
    this.periods.set(y.periods ?? []);
    this.breadcrumbs.setCurrent(y.code);
    return y;
  });

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.year.load());
    });
  }

  protected async close(p: Period) {
    const ok = await this.confirm.ask({
      title: `Fechar ${p.name}`,
      message: 'Deixa de ser possível submeter, aprovar ou contabilizar lançamentos neste período.',
      confirmLabel: 'Fechar período',
    });
    if (!ok) return;
    const result = await this.action.run(() =>
      this.deps.api.post<Period[]>(`accounting/periods/${p.id}/close`, {}),
    );
    if (!result) return;
    this.periods.set(result);
    this.refresh.update((n) => n + 1);
    this.toasts.show(`${p.name} fechado.`);
  }

  protected async reopen(p: Period) {
    const result = await this.action.run(() =>
      this.deps.api.post<Period[]>(`accounting/periods/${p.id}/reopen`, { reason: this.reason }),
    );
    if (!result) return;
    this.periods.set(result);
    this.reopening.set(null);
    this.reason = '';
    this.refresh.update((n) => n + 1);
    this.toasts.show(`${p.name} reaberto.`);
  }
}
