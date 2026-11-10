import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { BarChart } from '../ui/bar-chart';
import { downloadText, toCsv } from '../ui/csv';
import { formatDate } from '../ui/dates';
import { Kpi } from '../ui/kpi';
import { Action } from '../ui/load';
import { Tabs, type TabItem } from '../ui/tabs';
import { ReportPage } from '../ui/templates/report-page';
import { daysLabel } from './leave-model';
import { RUN_KIND, type RunKind } from './payroll-model';
import {
  contractTypeLabel,
  type Headcount,
  initiativeLabel,
  type LeaveReport,
  money,
  payrollCsvRows,
  type PayrollReport,
  pctLabel,
  reasonLabel,
  shortMonth,
  topBars,
  type Turnover,
} from './portal-model';

/**
 * Relatórios de RH: efectivos, rotatividade e férias (`hr.reports.read`, no âmbito) e folha salarial com IRT, INSS e
 * custos (`hr.payroll.read`, só lotes fechados). Todos os números vêm do servidor; a entidade legal da barra superior
 * filtra os relatórios.
 */
@Component({
  selector: 'app-hr-reports',
  imports: [FormsModule, ReportPage, Tabs, Kpi, BarChart],
  template: `
    <app-tabs label="Relatórios de RH" [tabs]="tabs()" [(active)]="tab" />

    @if (tab() === 'headcount') {
      <div role="tabpanel" id="panel-headcount" aria-labelledby="tab-headcount" class="mt-4">
        <app-report-page
          title="Efectivos"
          subtitle="Pessoas em funções numa data, pela colocação nessa data."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!hc()"
          [summary]="hc() ? 'Em ' + date(hc()!.date) : null"
          (run)="runHeadcount()"
          (exported)="exportHeadcount()"
        >
          <div params>
            <label class="label" for="hc-date">Data</label>
            <input id="hc-date" name="date" type="date" class="input w-44" [(ngModel)]="hcDate" />
          </div>
          @if (hc(); as h) {
            <div class="mb-4 grid gap-3 sm:grid-cols-3">
              <app-kpi label="Efectivos" [value]="h.total" testId="rep-total" />
              <app-kpi label="Admissões no ano" [value]="h.hiresYearToDate" />
              <app-kpi label="Saídas no ano" [value]="h.exitsYearToDate" />
            </div>
            <div class="grid gap-4 lg:grid-cols-2">
              <section class="card min-w-0" aria-label="Por departamento">
                <app-bar-chart title="Por departamento" [bars]="bars(h.byDepartment)" />
              </section>
              <section class="card min-w-0" aria-label="Por tipo de contrato">
                <app-bar-chart title="Por tipo de contrato" [bars]="contractBars(h)" />
              </section>
              <section class="card min-w-0" aria-labelledby="hc-pos">
                <h3 id="hc-pos" class="mb-2 text-sm font-medium">Por cargo</h3>
                <table class="w-full text-sm">
                  <tbody>
                    @for (g of h.byPosition; track g.key) {
                      <tr class="border-t border-border">
                        <td class="py-1">{{ g.label }}</td>
                        <td class="py-1 text-right tabular-nums">{{ g.count }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
              <section class="card min-w-0" aria-labelledby="hc-le">
                <h3 id="hc-le" class="mb-2 text-sm font-medium">Por entidade legal</h3>
                <table class="w-full text-sm">
                  <tbody>
                    @for (g of h.byLegalEntity; track g.key) {
                      <tr class="border-t border-border">
                        <td class="py-1">{{ g.label }}</td>
                        <td class="py-1 text-right tabular-nums">{{ g.count }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'turnover') {
      <div role="tabpanel" id="panel-turnover" aria-labelledby="tab-turnover" class="mt-4">
        <app-report-page
          title="Rotatividade"
          subtitle="Saídas (cessações aprovadas, pelo último dia) sobre a média dos efectivos."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!tv()"
          [summary]="tv() ? 'Ano ' + tv()!.year : null"
          (run)="runTurnover()"
          (exported)="exportTurnover()"
        >
          <div params>
            <label class="label" for="tv-year">Ano</label>
            <input id="tv-year" name="year" type="number" class="input w-28" [(ngModel)]="year" />
          </div>
          @if (tv(); as v) {
            <div class="mb-4 grid gap-3 sm:grid-cols-4">
              <app-kpi label="Taxa anual" [value]="pct(v.rate)" testId="rep-rate" />
              <app-kpi
                label="Média de efectivos"
                [value]="v.averageHeadcount?.replace('.', ',') ?? '—'"
              />
              <app-kpi label="Admissões" [value]="v.hires" />
              <app-kpi label="Saídas" [value]="v.exits" />
            </div>
            <section class="card min-w-0" aria-label="Saídas por mês">
              <app-bar-chart title="Saídas por mês" [bars]="exitBars(v)" />
              <div class="mt-3 overflow-x-auto">
                <table class="w-full text-sm" data-testid="rep-months">
                  <thead>
                    <tr class="text-left text-muted">
                      <th class="py-1">Mês</th>
                      <th class="py-1 text-right">Início</th>
                      <th class="py-1 text-right">Fim</th>
                      <th class="py-1 text-right">Admissões</th>
                      <th class="py-1 text-right">Saídas</th>
                      <th class="py-1 text-right">Taxa</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of v.months; track m.month) {
                      <tr class="border-t border-border tabular-nums">
                        <td class="py-1">{{ month(m.month) }}</td>
                        <td class="py-1 text-right">{{ m.start }}</td>
                        <td class="py-1 text-right">{{ m.end }}</td>
                        <td class="py-1 text-right">{{ m.hires }}</td>
                        <td class="py-1 text-right">{{ m.exits }}</td>
                        <td class="py-1 text-right">{{ pct(m.rate) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <section class="card min-w-0" aria-labelledby="tv-reason">
                <h3 id="tv-reason" class="mb-2 text-sm font-medium">Saídas por motivo</h3>
                <ul class="text-sm">
                  @for (g of v.byReason; track g.key) {
                    <li class="flex justify-between py-1">
                      <span>{{ reason(g.key) }}</span
                      ><span>{{ g.count }}</span>
                    </li>
                  } @empty {
                    <li class="text-muted">Sem saídas.</li>
                  }
                </ul>
              </section>
              <section class="card min-w-0" aria-labelledby="tv-init">
                <h3 id="tv-init" class="mb-2 text-sm font-medium">Saídas por iniciativa</h3>
                <ul class="text-sm">
                  @for (g of v.byInitiative; track g.key) {
                    <li class="flex justify-between py-1">
                      <span>{{ initiative(g.key) }}</span
                      ><span>{{ g.count }}</span>
                    </li>
                  } @empty {
                    <li class="text-muted">Sem saídas.</li>
                  }
                </ul>
              </section>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'leave') {
      <div role="tabpanel" id="panel-leave" aria-labelledby="tab-leave" class="mt-4">
        <app-report-page
          title="Férias"
          subtitle="Direito, gozadas, pendentes e saldo do ano por colaborador."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!lv()"
          [summary]="lv() ? 'Ano ' + lv()!.year : null"
          (run)="runLeave()"
          (exported)="exportLeave()"
        >
          <div params>
            <label class="label" for="lv-year">Ano</label>
            <input id="lv-year" name="year" type="number" class="input w-28" [(ngModel)]="year" />
          </div>
          @if (lv(); as l) {
            <div class="mb-4 grid gap-3 sm:grid-cols-4">
              <app-kpi label="Colaboradores" [value]="l.totals.employees" />
              <app-kpi label="Dias de direito" [value]="days(l.totals.entitled)" />
              <app-kpi label="Dias gozados" [value]="days(l.totals.taken)" />
              <app-kpi label="Saldo" [value]="days(l.totals.balance)" testId="rep-leave-balance" />
            </div>
            <section class="card overflow-x-auto" aria-label="Férias por colaborador">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="py-1">Colaborador</th>
                    <th class="py-1">Departamento</th>
                    <th class="py-1 text-right">Direito</th>
                    <th class="py-1 text-right">Gozadas</th>
                    <th class="py-1 text-right">Pendentes</th>
                    <th class="py-1 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of l.rows; track r.employee.id) {
                    <tr class="border-t border-border tabular-nums">
                      <td class="py-1">{{ r.employee.code }} — {{ r.employee.fullName }}</td>
                      <td class="py-1">{{ r.departmentName ?? '—' }}</td>
                      <td class="py-1 text-right">{{ days(r.entitled) }}</td>
                      <td class="py-1 text-right">{{ days(r.taken) }}</td>
                      <td class="py-1 text-right">{{ days(r.pending) }}</td>
                      <td class="py-1 text-right">{{ days(r.balance) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'payroll') {
      <div role="tabpanel" id="panel-payroll" aria-labelledby="tab-payroll" class="mt-4">
        <app-report-page
          title="Folha salarial, IRT, INSS e custos"
          subtitle="Só lotes fechados, nas entidades legais em que tem acesso ao processamento."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!pr()"
          [summary]="pr() ? 'Ano ' + pr()!.year : null"
          (run)="runPayroll()"
          (exported)="exportPayroll()"
        >
          <div params>
            <label class="label" for="pr-year">Ano</label>
            <input id="pr-year" name="year" type="number" class="input w-28" [(ngModel)]="year" />
          </div>
          @if (pr(); as p) {
            @for (t of p.totals; track t.currency) {
              <div
                class="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6"
                data-testid="rep-payroll-totals"
              >
                <app-kpi [label]="'Bruto (' + t.currency + ')'" [value]="money(t.gross)" />
                <app-kpi label="IRT" [value]="money(t.irt)" />
                <app-kpi label="INSS trabalhador" [value]="money(t.inssEmployee)" />
                <app-kpi label="INSS empresa" [value]="money(t.inssEmployer)" />
                <app-kpi label="Líquido" [value]="money(t.net)" />
                <app-kpi label="Custo empresa" [value]="money(t.employerCost)" />
              </div>
            } @empty {
              <p class="card text-sm text-muted">Sem lotes fechados neste ano.</p>
            }
            @if (p.months.length) {
              <section class="card overflow-x-auto" aria-label="Por mês">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-muted">
                      <th class="py-1">Mês</th>
                      <th class="py-1 text-right">Pessoas</th>
                      <th class="py-1 text-right">Bruto</th>
                      <th class="py-1 text-right">IRT</th>
                      <th class="py-1 text-right">INSS trab.</th>
                      <th class="py-1 text-right">INSS emp.</th>
                      <th class="py-1 text-right">Líquido</th>
                      <th class="py-1 text-right">Custo</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of p.months; track m.month + m.currency) {
                      <tr class="border-t border-border tabular-nums">
                        <td class="py-1">{{ month(m.month) }} ({{ m.currency }})</td>
                        <td class="py-1 text-right">{{ m.employees }}</td>
                        <td class="py-1 text-right">{{ money(m.gross) }}</td>
                        <td class="py-1 text-right">{{ money(m.irt) }}</td>
                        <td class="py-1 text-right">{{ money(m.inssEmployee) }}</td>
                        <td class="py-1 text-right">{{ money(m.inssEmployer) }}</td>
                        <td class="py-1 text-right">{{ money(m.net) }}</td>
                        <td class="py-1 text-right">{{ money(m.employerCost) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
              <div class="mt-4 grid gap-4 lg:grid-cols-2">
                <section class="card min-w-0" aria-labelledby="pr-dept">
                  <h3 id="pr-dept" class="mb-2 text-sm font-medium">Custo por departamento</h3>
                  <ul class="text-sm">
                    @for (d of p.byDepartment; track d.departmentName + d.currency) {
                      <li class="flex justify-between gap-2 py-1">
                        <span>{{ d.departmentName }} ({{ d.employees }})</span>
                        <span class="tabular-nums"
                          >{{ money(d.employerCost) }} {{ d.currency }}</span
                        >
                      </li>
                    }
                  </ul>
                </section>
                <section class="card min-w-0" aria-labelledby="pr-kind">
                  <h3 id="pr-kind" class="mb-2 text-sm font-medium">Por tipo de lote</h3>
                  <ul class="text-sm">
                    @for (k of p.byKind; track k.kind + k.currency) {
                      <li class="flex justify-between gap-2 py-1">
                        <span>{{ kind(k.kind) }}</span>
                        <span class="tabular-nums">{{ money(k.gross) }} {{ k.currency }}</span>
                      </li>
                    }
                  </ul>
                </section>
              </div>
            }
          }
        </app-report-page>
      </div>
    }
  `,
})
export class HrReportsPage {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly action = new Action();
  protected readonly tabs = computed<TabItem[]>(() => [
    ...(this.workspace.canAny('hr.reports.read')
      ? [
          { id: 'headcount', label: 'Efectivos' },
          { id: 'turnover', label: 'Rotatividade' },
          { id: 'leave', label: 'Férias' },
        ]
      : []),
    ...(this.workspace.canAny('hr.payroll.read')
      ? [{ id: 'payroll', label: 'Folha salarial' }]
      : []),
  ]);
  protected readonly tab = signal(
    this.workspace.canAny('hr.reports.read') ? 'headcount' : 'payroll',
  );
  protected hcDate = new Date().toISOString().slice(0, 10);
  protected year = new Date().getFullYear();
  protected readonly hc = signal<Headcount | null>(null);
  protected readonly tv = signal<Turnover | null>(null);
  protected readonly lv = signal<LeaveReport | null>(null);
  protected readonly pr = signal<PayrollReport | null>(null);
  protected readonly date = formatDate;
  protected readonly month = shortMonth;
  protected readonly pct = pctLabel;
  protected readonly days = daysLabel;
  protected readonly money = money;
  protected readonly reason = reasonLabel;
  protected readonly initiative = initiativeLabel;
  protected readonly kind = (k: string) => RUN_KIND[k as RunKind] ?? k;
  protected readonly bars = (g: { label: string; count: number }[]) => topBars(g);
  protected readonly contractBars = (h: Headcount) =>
    topBars(h.byContractType.map((x) => ({ label: contractTypeLabel(x.key), count: x.count })));
  protected readonly exitBars = (v: Turnover) =>
    v.months.map((m) => ({ label: shortMonth(m.month).slice(0, 3), value: m.exits }));

  private params(extra: Record<string, unknown>) {
    const le = this.workspace.legalEntityId();
    return { ...extra, ...(le ? { legalEntityId: le } : {}) };
  }

  protected async runHeadcount() {
    const r = await this.action.run(() =>
      this.api.get<Headcount>('hr/reports/headcount', this.params({ date: this.hcDate })),
    );
    if (r) this.hc.set(r);
  }

  protected async runTurnover() {
    const r = await this.action.run(() =>
      this.api.get<Turnover>('hr/reports/turnover', this.params({ year: this.year })),
    );
    if (r) this.tv.set(r);
  }

  protected async runLeave() {
    const r = await this.action.run(() =>
      this.api.get<LeaveReport>('hr/reports/leave', this.params({ year: this.year })),
    );
    if (r) this.lv.set(r);
  }

  protected async runPayroll() {
    const r = await this.action.run(() =>
      this.api.get<PayrollReport>('hr/reports/payroll', this.params({ year: this.year })),
    );
    if (r) this.pr.set(r);
  }

  protected exportHeadcount() {
    const h = this.hc()!;
    const rows = [
      ...h.byDepartment.map((g) => ['Departamento', g.label, g.count]),
      ...h.byPosition.map((g) => ['Cargo', g.label, g.count]),
      ...h.byContractType.map((g) => ['Tipo de contrato', contractTypeLabel(g.key), g.count]),
      ['Total', '', h.total],
    ];
    downloadText(`efectivos-${h.date}.csv`, toCsv(['Agrupamento', 'Valor', 'Efectivos'], rows));
  }

  protected exportTurnover() {
    const v = this.tv()!;
    downloadText(
      `rotatividade-${v.year}.csv`,
      toCsv(
        ['Mês', 'Início', 'Fim', 'Admissões', 'Saídas', 'Taxa (%)'],
        [
          ...v.months.map((m) => [m.month, m.start, m.end, m.hires, m.exits, m.rate ?? '']),
          ['Ano', '', '', v.hires, v.exits, v.rate ?? ''],
        ],
      ),
    );
  }

  protected exportLeave() {
    const l = this.lv()!;
    downloadText(
      `ferias-${l.year}.csv`,
      toCsv(
        ['Código', 'Colaborador', 'Departamento', 'Direito', 'Gozadas', 'Pendentes', 'Saldo'],
        l.rows.map((r) => [
          r.employee.code,
          r.employee.fullName,
          r.departmentName ?? '',
          r.entitled,
          r.taken,
          r.pending,
          r.balance,
        ]),
      ),
    );
  }

  protected exportPayroll() {
    const p = this.pr()!;
    const { headers, rows } = payrollCsvRows(p);
    downloadText(`folha-${p.year}.csv`, toCsv(headers, rows));
  }
}
