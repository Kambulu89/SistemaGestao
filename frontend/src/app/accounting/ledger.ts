import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { downloadText, toCsv } from '../ui/csv';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { formatMoney } from '../ui/money-input';
import { PageHeader } from '../ui/page-header';
import { type Account, type Chart, type Ledger } from './model';
import { accountingDeps, legalEntityOptions } from './shared';

/**
 * Razão de uma conta (com as subcontas, se for conta-mãe) entre duas datas do mesmo exercício, com saldo anterior e
 * acumulado; filtros por terceiro e centro de custo. Só lançamentos contabilizados.
 */
@Component({
  selector: 'app-ledger',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert],
  template: `
    <app-page-header
      title="Razão"
      subtitle="Movimentos contabilizados de uma conta, com saldo acumulado."
    />
    <form
      class="mb-4 flex flex-wrap items-end gap-2"
      (ngSubmit)="run()"
      aria-label="Parâmetros do razão"
    >
      <div>
        <label class="label" for="lg-le">Entidade legal</label>
        <select
          id="lg-le"
          name="le"
          class="input w-56"
          [(ngModel)]="legalEntityId"
          (ngModelChange)="entityChanged()"
        >
          <option [ngValue]="null">—</option>
          @for (e of entities(); track e.id) {
            <option [ngValue]="e.id">{{ e.label }}</option>
          }
        </select>
      </div>
      <div>
        <label class="label" for="lg-acc">Conta</label>
        <select id="lg-acc" name="acc" class="input w-64" [(ngModel)]="accountId">
          <option [ngValue]="null">—</option>
          @for (a of accounts(); track a.id) {
            <option [ngValue]="a.id">{{ a.code }} — {{ a.name }}</option>
          }
        </select>
      </div>
      <div>
        <label class="label" for="lg-from">De</label>
        <input id="lg-from" name="from" type="date" class="input" [(ngModel)]="from" />
      </div>
      <div>
        <label class="label" for="lg-to">Até</label>
        <input id="lg-to" name="to" type="date" class="input" [(ngModel)]="to" />
      </div>
      <div>
        <label class="label" for="lg-tp">Terceiro</label>
        <input id="lg-tp" name="tp" class="input w-40" [(ngModel)]="thirdPartyRef" />
      </div>
      <button
        type="submit"
        class="btn-primary"
        [disabled]="action.busy() || !legalEntityId || !accountId || !from || !to"
      >
        Consultar
      </button>
      @if (ledger()) {
        <button type="button" class="btn-secondary" (click)="export()">Exportar CSV</button>
      }
    </form>
    <app-error-alert [error]="action.error()" />
    @if (ledger(); as l) {
      <p class="mb-2 text-sm text-muted">
        {{ l.account.code }} — {{ l.account.name
        }}{{ l.account.includesSubaccounts ? ' (com subcontas)' : '' }} · exercício
        {{ l.fiscalYear.code }}
      </p>
      @if (l.truncated) {
        <p class="mb-2 text-sm text-warning-text" role="status">
          Mostram-se as primeiras 5000 linhas; os totais incluem todas.
        </p>
      }
      <div class="card overflow-x-auto p-0">
        <table class="w-full min-w-[52rem] text-sm">
          <caption class="sr-only">
            Razão da conta
            {{
              l.account.code
            }}
          </caption>
          <thead>
            <tr class="border-b border-border text-left">
              <th scope="col" class="p-2">Data</th>
              <th scope="col" class="p-2">Número</th>
              <th scope="col" class="p-2">Descrição</th>
              <th scope="col" class="p-2">Conta</th>
              <th scope="col" class="p-2">Terceiro</th>
              <th scope="col" class="p-2 text-right">Débito</th>
              <th scope="col" class="p-2 text-right">Crédito</th>
              <th scope="col" class="p-2 text-right">Saldo</th>
            </tr>
          </thead>
          <tbody>
            <tr class="border-b border-border text-muted">
              <td class="p-2" colspan="7">Saldo anterior</td>
              <td class="p-2 text-right" data-testid="ledger-opening">{{ money(l.opening) }}</td>
            </tr>
            @for (r of l.lines; track $index) {
              <tr class="border-b border-border">
                <td class="p-2">{{ date(r.date) }}</td>
                <td class="p-2">
                  <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', r.entryId]">{{
                    r.number
                  }}</a>
                </td>
                <td class="p-2">{{ r.description ?? r.entryDescription }}</td>
                <td class="p-2 font-mono">{{ r.accountCode }}</td>
                <td class="p-2">{{ r.thirdPartyRef ?? '' }}</td>
                <td class="p-2 text-right">{{ money(r.debit, true) }}</td>
                <td class="p-2 text-right">{{ money(r.credit, true) }}</td>
                <td class="p-2 text-right">{{ money(r.balance) }}</td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr class="font-semibold" data-testid="ledger-totals">
              <th scope="row" class="p-2 text-left" colspan="5">Totais do período</th>
              <td class="p-2 text-right">{{ money(l.debit) }}</td>
              <td class="p-2 text-right">{{ money(l.credit) }}</td>
              <td class="p-2 text-right" data-testid="ledger-closing">{{ money(l.closing) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    }
  `,
})
export class LedgerPage {
  private readonly deps = accountingDeps();
  private readonly route = inject(ActivatedRoute);
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly accounts = signal<Account[]>([]);
  protected readonly ledger = signal<Ledger | null>(null);
  protected readonly action = new Action();
  protected readonly date = formatDate;
  protected legalEntityId: string | null = null;
  protected accountId: string | null = null;
  protected from = `${new Date().getFullYear()}-01-01`;
  protected to = new Date().toISOString().slice(0, 10);
  protected thirdPartyRef = '';

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      this.legalEntityId =
        q.get('legalEntityId') ??
        this.deps.workspace.legalEntityId() ??
        this.entities()[0]?.id ??
        null;
      if (q.get('legalEntityId') && !this.entities().some((e) => e.id === this.legalEntityId))
        this.entities.update((l) => [
          ...l,
          { id: this.legalEntityId!, label: 'Entidade do balancete' },
        ]);
      await this.entityChanged(false);
      if (q.get('accountId')) {
        this.accountId = q.get('accountId');
        this.from = q.get('from') ?? this.from;
        this.to = q.get('to') ?? this.to;
        await this.run();
      }
    })();
  }

  protected money(v: string, blankZero = false) {
    if (!v || (blankZero && /^0(\.0+)?$/.test(v))) return '';
    const negative = v.startsWith('-');
    const abs = negative ? v.slice(1) : v;
    const text = formatMoney(abs, abs.includes('.') ? abs.split('.')[1].length : 0);
    return negative ? `-${text}` : text;
  }

  protected async entityChanged(reset = true) {
    if (reset) {
      this.accountId = null;
      this.ledger.set(null);
    }
    if (!this.legalEntityId) return this.accounts.set([]);
    const charts = await this.deps.api.page<Chart>('accounting/charts', {
      legalEntityId: this.legalEntityId,
      status: 'ACTIVE',
      limit: 1,
    });
    const chart = charts.items[0];
    this.accounts.set(
      chart
        ? (
            await this.deps.api.page<Account>('accounting/accounts', {
              chartId: chart.id,
              limit: 500,
            })
          ).items
        : [],
    );
  }

  protected async run() {
    const r = await this.action.run(() =>
      this.deps.api.get<Ledger>('accounting/ledger', {
        legalEntityId: this.legalEntityId,
        accountId: this.accountId,
        from: this.from,
        to: this.to,
        thirdPartyRef: this.thirdPartyRef.trim() || undefined,
      }),
    );
    this.ledger.set(r ?? null);
  }

  protected export() {
    const l = this.ledger()!;
    const rows: unknown[][] = [['', '', 'Saldo anterior', '', '', '', '', l.opening]];
    for (const r of l.lines)
      rows.push([
        r.date,
        r.number,
        r.description ?? r.entryDescription,
        r.accountCode,
        r.thirdPartyRef ?? '',
        r.debit,
        r.credit,
        r.balance,
      ]);
    rows.push(['', '', 'Totais', '', '', l.debit, l.credit, l.closing]);
    downloadText(
      `razao-${l.account.code}-${l.from}-${l.to}.csv`,
      toCsv(
        ['Data', 'Número', 'Descrição', 'Conta', 'Terceiro', 'Débito', 'Crédito', 'Saldo'],
        rows,
      ),
    );
  }
}
