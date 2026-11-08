import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { downloadText, toCsv } from '../ui/csv';
import { Action } from '../ui/load';
import { formatMoney } from '../ui/money-input';
import { ReportPage } from '../ui/templates';
import {
  type AnalyticReport,
  type Dimension,
  type FiscalYear,
  NATURES,
  type Period,
} from './model';
import { accountingDeps, legalEntityOptions } from './shared';

/**
 * Relatório analítico: movimentos contabilizados repartidos por centro de custo ou por valor de uma dimensão. Os
 * totais conferem com o razão (cada linha é repartida exactamente; o que não tem destino aparece à parte).
 */
@Component({
  selector: 'app-analytics-report',
  imports: [FormsModule, ReportPage],
  template: `
    <app-report-page
      title="Analítica"
      subtitle="Repartição dos movimentos contabilizados por centro de custo ou dimensão."
      [busy]="action.busy()"
      [error]="action.error()"
      [canRun]="!!fiscalYearId"
      [hasResult]="!!report()"
      [summary]="summary()"
      [generatedAt]="generatedAt()"
      (run)="run()"
      (exported)="export()"
    >
      <div params>
        <label class="label" for="an-year">Exercício</label>
        <select
          id="an-year"
          name="year"
          class="input w-64"
          [(ngModel)]="fiscalYearId"
          (ngModelChange)="yearChanged()"
        >
          <option [ngValue]="null">—</option>
          @for (y of years(); track y.id) {
            <option [ngValue]="y.id">
              {{ y.code }} — {{ names().get(y.legalEntityId) ?? 'entidade' }}
            </option>
          }
        </select>
      </div>
      <div params>
        <label class="label" for="an-from">De</label>
        <select id="an-from" name="from" class="input w-40" [(ngModel)]="fromPeriod">
          @for (p of periods(); track p.id) {
            <option [ngValue]="p.number">{{ p.name }}</option>
          }
        </select>
      </div>
      <div params>
        <label class="label" for="an-to">Até</label>
        <select id="an-to" name="to" class="input w-40" [(ngModel)]="toPeriod">
          @for (p of periods(); track p.id) {
            <option [ngValue]="p.number">{{ p.name }}</option>
          }
        </select>
      </div>
      <div params>
        <label class="label" for="an-group">Por</label>
        <select id="an-group" name="group" class="input w-56" [(ngModel)]="group">
          <option value="costCenter">Centro de custo</option>
          @for (d of dimensions(); track d.id) {
            <option [value]="d.id">{{ d.name }}</option>
          }
        </select>
      </div>
      <fieldset params class="flex flex-wrap items-center gap-3 py-2 text-sm">
        <legend class="sr-only">Naturezas</legend>
        @for (n of natures; track n.value) {
          <label class="flex items-center gap-1"
            ><input type="checkbox" [name]="'n' + n.value" [(ngModel)]="selected[n.value]" />
            {{ n.label }}</label
          >
        }
      </fieldset>
      @if (report(); as r) {
        <p class="mb-2 text-sm" role="status" data-testid="an-status">
          @if (r.consistent) {
            <span class="text-success-text"
              >Confere com o razão: débitos {{ money(r.ledger.debit) }}, créditos
              {{ money(r.ledger.credit) }}.</span
            >
          } @else {
            <span class="text-danger-text">Não confere com o razão — contacte o suporte.</span>
          }
        </p>
        <div class="card overflow-x-auto p-0">
          <table class="w-full min-w-[36rem] text-sm">
            <caption class="sr-only">
              Relatório analítico
            </caption>
            <thead>
              <tr class="border-b border-border text-left">
                <th scope="col" class="p-2">
                  {{ r.groupBy === 'costCenter' ? 'Centro de custo' : 'Valor' }}
                </th>
                <th scope="col" class="p-2 text-right">Débito</th>
                <th scope="col" class="p-2 text-right">Crédito</th>
                <th scope="col" class="p-2 text-right">Líquido</th>
              </tr>
            </thead>
            <tbody>
              @for (row of r.rows; track row.key) {
                <tr class="border-b border-border" [class.text-muted]="row.key === null">
                  <td class="p-2">{{ row.label }}</td>
                  <td class="p-2 text-right">{{ money(row.debit) }}</td>
                  <td class="p-2 text-right">{{ money(row.credit) }}</td>
                  <td class="p-2 text-right">{{ money(row.net) }}</td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr class="font-semibold" data-testid="an-totals">
                <th scope="row" class="p-2 text-left">Totais</th>
                <td class="p-2 text-right">{{ money(r.totals.debit) }}</td>
                <td class="p-2 text-right">{{ money(r.totals.credit) }}</td>
                <td class="p-2 text-right">{{ money(r.totals.net) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      }
    </app-report-page>
  `,
})
export class AnalyticsReportPage {
  private readonly deps = accountingDeps();
  protected readonly natures = NATURES;
  protected readonly years = signal<FiscalYear[]>([]);
  protected readonly periods = signal<Period[]>([]);
  protected readonly dimensions = signal<Dimension[]>([]);
  protected readonly report = signal<AnalyticReport | null>(null);
  private readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly action = new Action();
  protected readonly generatedAt = signal(new Date().toISOString());
  protected readonly summary = computed(() => {
    const r = this.report();
    if (!r) return null;
    const name = (n: number) => this.periods().find((p) => p.number === n)?.name ?? String(n);
    const by =
      this.group === 'costCenter'
        ? 'por centro de custo'
        : `por ${this.dimensions().find((d) => d.id === this.group)?.name ?? 'dimensão'}`;
    return `${name(this.fromPeriod)} a ${name(this.toPeriod)} · ${by}`;
  });
  protected fiscalYearId: string | null = null;
  protected fromPeriod = 0;
  protected toPeriod = 13;
  protected group = 'costCenter';
  protected selected: Record<string, boolean> = { EXPENSE: true, REVENUE: true };

  constructor() {
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (e) => this.entities.set(e),
      () => undefined,
    );
    this.deps.api.page<FiscalYear>('accounting/fiscal-years', { limit: 100 }).then(
      (p) => this.years.set(p.items),
      () => undefined,
    );
    this.deps.api.page<Dimension>('accounting/dimensions', { limit: 200 }).then(
      (p) => this.dimensions.set(p.items),
      () => undefined,
    );
  }

  protected money(v: string) {
    const negative = v.startsWith('-');
    const abs = negative ? v.slice(1) : v;
    const text = formatMoney(abs, abs.includes('.') ? abs.split('.')[1].length : 0);
    return negative ? `-${text}` : text;
  }

  protected async yearChanged() {
    this.report.set(null);
    if (!this.fiscalYearId) return this.periods.set([]);
    const y = await this.deps.api.get<FiscalYear>(`accounting/fiscal-years/${this.fiscalYearId}`);
    this.periods.set(y.periods ?? []);
    this.fromPeriod = y.periods?.[0]?.number ?? 0;
    this.toPeriod = y.periods?.[y.periods.length - 1]?.number ?? 0;
  }

  protected async run() {
    const natures = Object.entries(this.selected)
      .filter(([, on]) => on)
      .map(([n]) => n);
    const r = await this.action.run(() =>
      this.deps.api.get<AnalyticReport>('accounting/analytics', {
        fiscalYearId: this.fiscalYearId,
        fromPeriod: this.fromPeriod,
        toPeriod: this.toPeriod,
        groupBy: this.group === 'costCenter' ? 'costCenter' : 'dimension',
        dimensionId: this.group === 'costCenter' ? undefined : this.group,
        natures: natures.length ? natures.join(',') : undefined,
      }),
    );
    this.report.set(r ?? null);
    this.generatedAt.set(new Date().toISOString());
  }

  protected export() {
    const r = this.report()!;
    const rows: unknown[][] = r.rows.map((x) => [x.label, x.debit, x.credit, x.net]);
    rows.push(['Totais', r.totals.debit, r.totals.credit, r.totals.net]);
    downloadText(
      'analitica.csv',
      toCsv(
        [r.groupBy === 'costCenter' ? 'Centro de custo' : 'Valor', 'Débito', 'Crédito', 'Líquido'],
        rows,
      ),
    );
  }
}
