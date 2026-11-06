import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConfirmService } from '../ui/confirm';
import { downloadText, toCsv } from '../ui/csv';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import {
  ASSET_STATUS,
  currentMonth,
  type DepreciationMap,
  type DepreciationPreview,
  type FiscalYear,
} from './model';
import { accountingDeps, legalEntityOptions, moneyText } from './shared';

/**
 * Depreciações: simular e processar até um mês (um lançamento por mês e diário), anular o último mês e o mapa de
 * depreciação por exercício (contabilizado e previsto), com exportação CSV.
 */
@Component({
  selector: 'app-depreciation',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert],
  template: `
    <app-page-header
      title="Depreciações"
      subtitle="Processamento mensal dos activos em uso e mapa de depreciação por exercício."
    />
    <section class="card mb-4" aria-labelledby="dep-run">
      <h2 id="dep-run" class="mb-3 font-semibold">Processar</h2>
      <form
        class="flex flex-wrap items-end gap-2"
        (ngSubmit)="preview()"
        aria-label="Processar depreciações"
      >
        <div>
          <label class="label" for="dep-le">Entidade legal</label>
          <select
            id="dep-le"
            name="le"
            class="input w-64"
            [(ngModel)]="legalEntityId"
            (ngModelChange)="reset()"
          >
            @for (e of entities(); track e.id) {
              <option [ngValue]="e.id">{{ e.label }}</option>
            }
          </select>
        </div>
        <div>
          <label class="label" for="dep-upto">Até ao mês</label>
          <input
            id="dep-upto"
            name="upTo"
            type="month"
            class="input w-44"
            [(ngModel)]="upTo"
            (ngModelChange)="reset()"
          />
        </div>
        <button type="submit" class="btn-secondary" [disabled]="action.busy() || !legalEntityId">
          Simular
        </button>
        @if (canPost() && pending()?.rows?.length && !pending()?.entries) {
          <button type="button" class="btn-primary" [disabled]="action.busy()" (click)="run()">
            Processar {{ pending()!.months.length }} mês(es)
          </button>
        }
      </form>
      <app-error-alert [error]="action.error()" [showDetails]="true" />
      @if (pending(); as p) {
        @if (p.rows.length === 0) {
          <p class="mt-3 text-sm text-muted" role="status">
            Não há depreciações por fazer até {{ upTo }}.
          </p>
        } @else {
          <p class="mt-3 text-sm" role="status" data-testid="dep-status">
            @if (p.entries) {
              Processado: {{ p.entries.length }} lançamento(s) —
              @for (e of p.entries; track e.id; let last = $last) {
                <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', e.id]">{{
                  e.number
                }}</a>
                ({{ e.month }}, {{ money(e.total) }}){{ last ? '.' : ', ' }}
              }
            } @else {
              Por depreciar: {{ p.rows.length }} quota(s), total {{ money(p.total) }}.
            }
          </p>
          <div class="mt-2 overflow-x-auto">
            <table class="w-full min-w-[30rem] text-sm">
              <caption class="sr-only">
                Depreciações por mês
              </caption>
              <thead>
                <tr class="border-b border-border text-left">
                  <th scope="col" class="p-2">Mês</th>
                  <th scope="col" class="p-2 text-right">Activos</th>
                  <th scope="col" class="p-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                @for (m of p.months; track m.month) {
                  <tr class="border-b border-border">
                    <td class="p-2">{{ m.month }}</td>
                    <td class="p-2 text-right">{{ m.assets }}</td>
                    <td class="p-2 text-right">{{ money(m.total) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </section>

    @if (canPost()) {
      <section class="card mb-4" aria-labelledby="dep-undo">
        <h2 id="dep-undo" class="mb-1 font-semibold">Anular um mês</h2>
        <p class="mb-3 text-sm text-muted">
          Estorna os lançamentos de depreciação do mês (na data indicada). Só o último mês
          depreciado de cada activo.
        </p>
        <form
          class="flex flex-wrap items-end gap-2"
          (ngSubmit)="undo()"
          aria-label="Anular depreciações"
        >
          <div>
            <label class="label" for="undo-month">Mês</label>
            <input
              id="undo-month"
              name="month"
              type="month"
              class="input w-44"
              [(ngModel)]="undoMonth"
            />
          </div>
          <div>
            <label class="label" for="undo-date">Data do estorno</label>
            <input
              id="undo-date"
              name="date"
              type="date"
              class="input w-44"
              [(ngModel)]="undoDate"
            />
          </div>
          <button
            type="submit"
            class="btn-secondary"
            [disabled]="undoAction.busy() || !undoMonth || !undoDate"
          >
            Anular
          </button>
        </form>
        <app-error-alert [error]="undoAction.error()" [showDetails]="true" />
      </section>
    }

    <section class="card" aria-labelledby="dep-map">
      <h2 id="dep-map" class="mb-3 font-semibold">Mapa de depreciação</h2>
      <form
        class="mb-3 flex flex-wrap items-end gap-2"
        (ngSubmit)="loadMap()"
        aria-label="Mapa de depreciação"
      >
        <div>
          <label class="label" for="map-year">Exercício</label>
          <select id="map-year" name="year" class="input w-64" [(ngModel)]="fiscalYearId">
            <option [ngValue]="null">—</option>
            @for (y of years(); track y.id) {
              <option [ngValue]="y.id">
                {{ y.code }} — {{ names().get(y.legalEntityId) ?? 'entidade' }}
              </option>
            }
          </select>
        </div>
        <button type="submit" class="btn-secondary" [disabled]="mapAction.busy() || !fiscalYearId">
          Ver mapa
        </button>
        @if (map()) {
          <button type="button" class="btn-secondary" (click)="exportMap()">Exportar CSV</button>
        }
      </form>
      <app-error-alert [error]="mapAction.error()" />
      @if (map(); as m) {
        @if (m.rows.length === 0) {
          <p class="text-sm text-muted">Sem activos contabilizados neste exercício.</p>
        } @else {
          <div class="overflow-x-auto">
            <table class="w-full min-w-[56rem] text-sm">
              <caption class="sr-only">
                Mapa de depreciação
                {{
                  m.fiscalYear
                }}
              </caption>
              <thead>
                <tr class="border-b border-border text-left">
                  <th scope="col" class="p-2">Activo</th>
                  <th scope="col" class="p-2">Classe</th>
                  <th scope="col" class="p-2">Estado</th>
                  <th scope="col" class="p-2 text-right">Custo</th>
                  <th scope="col" class="p-2 text-right">Acumulado inicial</th>
                  <th scope="col" class="p-2 text-right">Do exercício</th>
                  <th scope="col" class="p-2 text-right">Acumulado final</th>
                  <th scope="col" class="p-2 text-right">Valor líquido</th>
                  <th scope="col" class="p-2 text-right">Previsto no exercício</th>
                </tr>
              </thead>
              <tbody>
                @for (r of m.rows; track r.assetId) {
                  <tr class="border-b border-border">
                    <td class="p-2">
                      <a class="btn-link" [routerLink]="['/contabilidade/activos', r.assetId]">{{
                        r.number
                      }}</a>
                      {{ r.name }}
                    </td>
                    <td class="p-2">{{ r.classCode }}</td>
                    <td class="p-2">{{ statusText(r.status) }}</td>
                    <td class="p-2 text-right">{{ money(r.cost) }}</td>
                    <td class="p-2 text-right">{{ money(r.opening) }}</td>
                    <td class="p-2 text-right">{{ money(r.period) }}</td>
                    <td class="p-2 text-right">{{ money(r.closing) }}</td>
                    <td class="p-2 text-right">{{ money(r.bookValue) }}</td>
                    <td class="p-2 text-right">{{ money(r.forecast) }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                @for (c of m.classes; track c.classId) {
                  <tr class="border-b border-border text-muted">
                    <th scope="row" colspan="3" class="p-2 text-left font-normal">
                      Classe {{ c.code }} — {{ c.name }}
                    </th>
                    <td class="p-2 text-right">{{ money(c['cost']) }}</td>
                    <td class="p-2 text-right">{{ money(c['opening']) }}</td>
                    <td class="p-2 text-right">{{ money(c['period']) }}</td>
                    <td class="p-2 text-right">{{ money(c['closing']) }}</td>
                    <td class="p-2 text-right">{{ money(c['bookValue']) }}</td>
                    <td class="p-2 text-right">{{ money(c['forecast']) }}</td>
                  </tr>
                }
                <tr class="font-semibold" data-testid="map-totals">
                  <th scope="row" colspan="3" class="p-2 text-left">Totais</th>
                  <td class="p-2 text-right">{{ money(m.totals['cost']) }}</td>
                  <td class="p-2 text-right">{{ money(m.totals['opening']) }}</td>
                  <td class="p-2 text-right">{{ money(m.totals['period']) }}</td>
                  <td class="p-2 text-right">{{ money(m.totals['closing']) }}</td>
                  <td class="p-2 text-right">{{ money(m.totals['bookValue']) }}</td>
                  <td class="p-2 text-right">{{ money(m.totals['forecast']) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        }
      }
    </section>
  `,
})
export class DepreciationPage {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly canPost = computed(() => this.deps.workspace.can('fixed_assets.post'));
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly years = signal<FiscalYear[]>([]);
  protected readonly pending = signal<DepreciationPreview | null>(null);
  protected readonly map = signal<DepreciationMap | null>(null);
  protected readonly action = new Action();
  protected readonly undoAction = new Action();
  protected readonly mapAction = new Action();
  protected legalEntityId: string | null = null;
  protected upTo = currentMonth();
  protected undoMonth = '';
  protected undoDate = new Date().toISOString().slice(0, 10);
  protected fiscalYearId: string | null = null;

  constructor() {
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      this.legalEntityId = this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
    })();
    this.deps.api.page<FiscalYear>('accounting/fiscal-years', { limit: 100 }).then(
      (p) => this.years.set(p.items),
      () => undefined,
    );
  }

  protected money(v: string | undefined) {
    return moneyText(v);
  }
  protected statusText(s: keyof typeof ASSET_STATUS) {
    return ASSET_STATUS[s] ?? s;
  }

  protected reset() {
    this.pending.set(null);
  }

  protected async preview() {
    const r = await this.action.run(() =>
      this.deps.api.get<DepreciationPreview>('accounting/fixed-assets/depreciation/preview', {
        legalEntityId: this.legalEntityId,
        upTo: this.upTo,
      }),
    );
    this.pending.set(r ?? null);
  }

  protected async run() {
    const p = this.pending()!;
    const ok = await this.confirm.ask({
      title: 'Processar depreciações',
      message: `Contabilizar ${p.rows.length} quota(s) (${this.money(p.total)}) até ${this.upTo}? Os lançamentos ficam contabilizados; para corrigir, anula-se o mês.`,
      confirmLabel: 'Processar',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.deps.api.post<DepreciationPreview>('accounting/fixed-assets/depreciation/run', {
        legalEntityId: this.legalEntityId,
        upTo: this.upTo,
      }),
    );
    if (!r) return;
    this.pending.set(r);
    this.toasts.show(`Depreciações processadas: ${r.entries?.length ?? 0} lançamento(s).`);
    if (this.map()) await this.loadMap();
  }

  protected async undo() {
    const ok = await this.confirm.ask({
      title: 'Anular depreciações',
      message: `Estornar as depreciações de ${this.undoMonth} em ${this.undoDate}?`,
      confirmLabel: 'Anular',
      danger: true,
    });
    if (!ok) return;
    const r = await this.undoAction.run(() =>
      this.deps.api.post<{ assets: number; reversals: { number: string }[] }>(
        'accounting/fixed-assets/depreciation/undo',
        { legalEntityId: this.legalEntityId, month: this.undoMonth, date: this.undoDate },
      ),
    );
    if (!r) return;
    this.toasts.show(
      `Anuladas ${r.assets} quota(s): estorno ${r.reversals.map((x) => x.number).join(', ')}.`,
    );
    this.pending.set(null);
    if (this.map()) await this.loadMap();
  }

  protected async loadMap() {
    const r = await this.mapAction.run(() =>
      this.deps.api.get<DepreciationMap>('accounting/fixed-assets/depreciation-map', {
        fiscalYearId: this.fiscalYearId,
      }),
    );
    this.map.set(r ?? null);
  }

  protected exportMap() {
    const m = this.map()!;
    const cols = ['cost', 'opening', 'period', 'closing', 'bookValue', 'forecast'];
    const rows: unknown[][] = m.rows.map((r) => [
      r.number,
      r.name,
      r.classCode,
      ASSET_STATUS[r.status],
      r.acquisitionDate,
      r.disposalDate ?? '',
      ...cols.map((c) => r[c as keyof typeof r]),
    ]);
    rows.push(['Totais', '', '', '', '', '', ...cols.map((c) => m.totals[c])]);
    downloadText(
      `mapa-depreciacao-${m.fiscalYear}.csv`,
      toCsv(
        [
          'N.º',
          'Designação',
          'Classe',
          'Estado',
          'Aquisição',
          'Abate',
          'Custo',
          'Acumulado inicial',
          'Do exercício',
          'Acumulado final',
          'Valor líquido',
          'Previsto no exercício',
        ],
        rows,
      ),
    );
  }
}
