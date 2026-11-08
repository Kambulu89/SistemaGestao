import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { downloadText, toCsv } from '../ui/csv';
import { Action } from '../ui/load';
import { formatMoney } from '../ui/money-input';
import { ReportPage } from '../ui/templates';
import {
  type FiscalYear,
  type Period,
  splitBalance,
  type TrialBalance,
  type TrialBalanceRow,
} from './model';
import { accountingDeps, legalEntityOptions } from './shared';

/**
 * Balancete (só lançamentos contabilizados, moeda funcional). Analítico mostra todas as contas; sintético agrega até
 * ao nível escolhido. As contas-mãe são somas e não entram nos totais.
 */
@Component({
  selector: 'app-trial-balance',
  imports: [FormsModule, ReportPage],
  template: `
    <app-report-page
      title="Balancete"
      subtitle="Só lançamentos contabilizados, na moeda funcional da entidade."
      [busy]="action.busy()"
      [error]="action.error()"
      [canRun]="!!fiscalYearId"
      [hasResult]="!!tb()"
      [summary]="summary()"
      [generatedAt]="generatedAt()"
      (run)="run()"
      (exported)="export()"
    >
      <div params>
        <label class="label" for="tb-year">Exercício</label>
        <select
          id="tb-year"
          name="year"
          class="input w-56"
          [(ngModel)]="fiscalYearId"
          (ngModelChange)="yearChanged()"
        >
          <option [ngValue]="null">—</option>
          @for (y of years(); track y.id) {
            <option [ngValue]="y.id">{{ yearLabel(y) }}</option>
          }
        </select>
      </div>
      <div params>
        <label class="label" for="tb-from">De</label>
        <select id="tb-from" name="from" class="input w-40" [(ngModel)]="fromPeriod">
          @for (p of periods(); track p.id) {
            <option [ngValue]="p.number">{{ p.name }}</option>
          }
        </select>
      </div>
      <div params>
        <label class="label" for="tb-to">Até</label>
        <select id="tb-to" name="to" class="input w-40" [(ngModel)]="toPeriod">
          @for (p of periods(); track p.id) {
            <option [ngValue]="p.number">{{ p.name }}</option>
          }
        </select>
      </div>
      <div params>
        <label class="label" for="tb-mode">Tipo</label>
        <select id="tb-mode" name="mode" class="input w-44" [(ngModel)]="mode">
          <option value="analytic">Analítico</option>
          <option value="synthetic">Sintético</option>
        </select>
      </div>
      @if (mode === 'synthetic') {
        <div params>
          <label class="label" for="tb-depth">Até ao nível</label>
          <select id="tb-depth" name="depth" class="input w-32" [(ngModel)]="maxDepth">
            <option [ngValue]="1">Classes</option>
            <option [ngValue]="2">Contas</option>
            <option [ngValue]="3">3.º nível</option>
          </select>
        </div>
      }
      <label params class="flex items-center gap-2 py-2 text-sm"
        ><input type="checkbox" name="zero" [(ngModel)]="includeZero" /> Contas sem
        movimentos</label
      >
      @if (tb(); as t) {
        <p class="mb-2 text-sm" role="status" data-testid="tb-status">
          @if (t.balanced) {
            <span class="text-success-text">Equilibrado: débitos = créditos.</span>
          } @else {
            <span class="text-danger-text">Desequilibrado — verifique os lançamentos.</span>
          }
        </p>
        <div class="card overflow-x-auto p-0">
          <table class="w-full min-w-[52rem] text-sm">
            <caption class="sr-only">
              Balancete do exercício
              {{
                t.fiscalYear.code
              }}
            </caption>
            <thead>
              <tr class="border-b border-border text-left">
                <th scope="col" class="p-2">Conta</th>
                <th scope="col" class="p-2 text-right">Saldo anterior</th>
                <th scope="col" class="p-2 text-right">Débito</th>
                <th scope="col" class="p-2 text-right">Crédito</th>
                <th scope="col" class="p-2 text-right">Saldo devedor</th>
                <th scope="col" class="p-2 text-right">Saldo credor</th>
              </tr>
            </thead>
            <tbody>
              @for (r of t.rows; track r.accountId) {
                <tr class="border-b border-border" [class.font-semibold]="!r.postable">
                  <td class="p-2" [style.padding-left.rem]="0.5 + (r.depth - 1) * 1.25">
                    <button type="button" class="btn-link text-left" (click)="openLedger(r)">
                      <span class="font-mono">{{ r.code }}</span> {{ r.name }}
                    </button>
                  </td>
                  <td class="p-2 text-right">{{ money(r.opening) }}</td>
                  <td class="p-2 text-right">{{ money(r.debit) }}</td>
                  <td class="p-2 text-right">{{ money(r.credit) }}</td>
                  <td class="p-2 text-right">{{ money(split(r.closing).debit) }}</td>
                  <td class="p-2 text-right">{{ money(split(r.closing).credit) }}</td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr class="font-semibold" data-testid="tb-totals">
                <th scope="row" class="p-2 text-left">Totais (contas movimentáveis)</th>
                <td class="p-2 text-right">{{ money(t.totals.opening) }}</td>
                <td class="p-2 text-right">{{ money(t.totals.debit) }}</td>
                <td class="p-2 text-right">{{ money(t.totals.credit) }}</td>
                <td class="p-2 text-right">{{ money(t.totals.closingDebit) }}</td>
                <td class="p-2 text-right">{{ money(t.totals.closingCredit) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      }
    </app-report-page>
  `,
})
export class TrialBalancePage {
  private readonly deps = accountingDeps();
  private readonly router = inject(Router);
  protected readonly years = signal<FiscalYear[]>([]);
  private readonly entityNames = signal<Map<string, string>>(new Map());
  /** Exercício identificado pela entidade (há um "2026" por entidade legal). */
  protected yearLabel(y: FiscalYear) {
    return `${y.code} — ${this.entityNames().get(y.legalEntityId) ?? 'entidade'}`;
  }
  protected readonly periods = signal<Period[]>([]);
  protected readonly tb = signal<TrialBalance | null>(null);
  protected readonly action = new Action();
  protected readonly split = splitBalance;
  protected readonly generatedAt = signal(new Date().toISOString());
  /** Parâmetros do resultado actual, para o ecrã e a impressão. */
  protected readonly summary = computed(() => {
    const t = this.tb();
    if (!t) return null;
    const name = (n: number) => this.periods().find((p) => p.number === n)?.name ?? String(n);
    return `Exercício ${t.fiscalYear.code} · ${name(t.fromPeriod)} a ${name(t.toPeriod)} · ${
      t.mode === 'synthetic' ? 'sintético' : 'analítico'
    }`;
  });
  protected fiscalYearId: string | null = null;
  protected fromPeriod = 0;
  protected toPeriod = 13;
  protected mode: 'analytic' | 'synthetic' = 'analytic';
  protected maxDepth = 1;
  protected includeZero = false;

  constructor() {
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (list) => this.entityNames.set(new Map(list.map((e) => [e.id, e.label]))),
      () => undefined,
    );
    this.deps.api.page<FiscalYear>('accounting/fiscal-years', { limit: 100 }).then(
      (p) => {
        this.years.set(p.items);
        const le = this.deps.workspace.legalEntityId();
        const first = p.items.find((y) => !le || y.legalEntityId === le);
        if (first) {
          this.fiscalYearId = first.id;
          void this.yearChanged();
        }
      },
      () => undefined,
    );
  }

  protected money(v: string) {
    if (!v) return '';
    const negative = v.startsWith('-');
    const abs = negative ? v.slice(1) : v;
    const text = formatMoney(abs, abs.includes('.') ? abs.split('.')[1].length : 0);
    return negative ? `-${text}` : text;
  }

  protected async yearChanged() {
    this.tb.set(null);
    if (!this.fiscalYearId) return this.periods.set([]);
    const y = await this.deps.api.get<FiscalYear>(`accounting/fiscal-years/${this.fiscalYearId}`);
    const periods = y.periods ?? [];
    this.periods.set(periods);
    this.fromPeriod = periods[0]?.number ?? 0;
    this.toPeriod = periods[periods.length - 1]?.number ?? 0;
  }

  protected async run() {
    const r = await this.action.run(() =>
      this.deps.api.get<TrialBalance>('accounting/trial-balance', {
        fiscalYearId: this.fiscalYearId,
        fromPeriod: this.fromPeriod,
        toPeriod: this.toPeriod,
        mode: this.mode,
        maxDepth: this.mode === 'synthetic' ? this.maxDepth : undefined,
        includeZero: this.includeZero || undefined,
      }),
    );
    this.tb.set(r ?? null);
    this.generatedAt.set(new Date().toISOString());
  }

  protected openLedger(r: TrialBalanceRow) {
    const t = this.tb()!;
    const from = this.periods().find((p) => p.number === t.fromPeriod)?.startDate;
    const to = this.periods().find((p) => p.number === t.toPeriod)?.endDate;
    void this.router.navigate(['/contabilidade/razao'], {
      queryParams: { legalEntityId: t.fiscalYear.legalEntityId, accountId: r.accountId, from, to },
    });
  }

  protected export() {
    const t = this.tb()!;
    const rows = t.rows.map((r) => [
      r.code,
      r.name,
      r.opening,
      r.debit,
      r.credit,
      splitBalance(r.closing).debit,
      splitBalance(r.closing).credit,
    ]);
    rows.push([
      '',
      'Totais',
      t.totals.opening,
      t.totals.debit,
      t.totals.credit,
      t.totals.closingDebit,
      t.totals.closingCredit,
    ]);
    downloadText(
      `balancete-${t.fiscalYear.code}-${t.fromPeriod}-${t.toPeriod}.csv`,
      toCsv(
        ['Conta', 'Nome', 'Saldo anterior', 'Débito', 'Crédito', 'Saldo devedor', 'Saldo credor'],
        rows,
      ),
    );
  }
}
