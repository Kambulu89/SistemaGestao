import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { money } from '../inventory/valuation-model';
import {
  ratePct,
  ROUNDING,
  SIMULATION_NOTICE,
  TAX_KIND,
  type TaxCodeRow,
  type TaxSimulation,
} from './fiscal-model';

interface SimLine {
  key: number;
  netAmount: string;
  codes: Record<string, boolean>;
  exemptionCode: string;
}

/** Simulação do cálculo fiscal de um documento com os valores confirmados em vigor na data (não grava nada). */
@Component({
  selector: 'app-tax-simulator',
  imports: [
    FormsModule,
    PageHeader,
    FormSection,
    FormField,
    FieldControl,
    DataTable,
    ErrorAlert,
    Icon,
  ],
  template: `
    <app-page-header
      title="Simulação fiscal"
      subtitle="O mesmo cálculo que os documentos de venda usam, sem gravar nada."
    />
    <p
      class="mb-3 rounded-card border border-warning bg-warning-soft p-3 text-sm text-warning-text"
      role="note"
    >
      {{ notice }}
    </p>
    <div class="space-y-4">
      <app-form-section title="Documento" [columns]="2">
        <app-field label="Entidade legal" [required]="true" [error]="act.field('legalEntityId')">
          <select
            appControl
            class="input"
            name="le"
            data-testid="ts-le"
            [(ngModel)]="legalEntityId"
          >
            <option value="">—</option>
            @for (e of entities(); track e.legalEntityId) {
              <option [value]="e.legalEntityId">{{ e.code }} — {{ e.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data" [required]="true" [error]="act.field('date')">
          <input
            appControl
            class="input"
            type="date"
            name="date"
            data-testid="ts-date"
            [(ngModel)]="date"
          />
        </app-field>
      </app-form-section>

      <section class="card space-y-3" aria-labelledby="ts-lines">
        <h2 id="ts-lines" class="font-semibold">Linhas</h2>
        @for (l of lines; track l.key; let i = $index) {
          <div class="grid gap-3 border-b border-border pb-3 md:grid-cols-3" data-testid="ts-line">
            <app-field
              label="Base (líquido)"
              [required]="true"
              [error]="act.field('lines.' + i + '.netAmount')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'net' + l.key"
                data-testid="ts-net"
                [(ngModel)]="l.netAmount"
              />
            </app-field>
            <fieldset class="text-sm">
              <legend class="label">Impostos e retenções</legend>
              @for (c of codes(); track c.id) {
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    [name]="'c' + l.key + c.id"
                    [attr.data-testid]="'ts-code-' + c.code"
                    [(ngModel)]="l.codes[c.id]"
                  />
                  {{ c.code }} — {{ c.name }} ({{ kind(c.kind) }})
                </label>
              }
              @if (act.field('lines.' + i + '.taxCodeIds'); as e) {
                <p class="field-error">{{ e }}</p>
              }
            </fieldset>
            <app-field
              label="Motivo de isenção"
              hint="Só para taxas a 0 %."
              [error]="act.field('lines.' + i + '.exemptionCode')"
            >
              <input
                appControl
                class="input uppercase"
                [name]="'ex' + l.key"
                data-testid="ts-exempt"
                [(ngModel)]="l.exemptionCode"
              />
            </app-field>
          </div>
        }
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn-secondary" (click)="addLine()">
            <app-icon name="plus" [size]="16" />Linha
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="ts-run"
            [disabled]="act.busy()"
            (click)="run()"
          >
            Calcular
          </button>
        </div>
        <app-error-alert [error]="act.error()" [showDetails]="true" />
      </section>

      @if (result(); as r) {
        <section class="card space-y-3" aria-labelledby="ts-res" data-testid="ts-result">
          <h2 id="ts-res" class="font-semibold">
            Resultado (arredondamento {{ rounding(r.rounding) }})
          </h2>
          <app-data-table
            label="Resumo por imposto"
            [columns]="columns"
            [rows]="r.summary"
            [total]="r.summary.length"
            [limit]="1000"
            emptyText="Sem impostos."
          />
          <dl class="ml-auto grid max-w-sm grid-cols-2 gap-1 text-sm" data-testid="ts-totals">
            <dt class="text-muted">Líquido</dt>
            <dd class="text-right">{{ money(r.totals.net) }}</dd>
            <dt class="text-muted">Imposto</dt>
            <dd class="text-right">{{ money(r.totals.tax) }}</dd>
            <dt class="text-muted">Total</dt>
            <dd class="text-right">{{ money(r.totals.gross) }}</dd>
            <dt class="text-muted">Retenção</dt>
            <dd class="text-right">{{ money(r.totals.withholding) }}</dd>
            <dt class="font-semibold">A pagar</dt>
            <dd class="text-right font-semibold">{{ money(r.totals.payable) }}</dd>
          </dl>
          <ul class="text-xs text-muted">
            @for (u of r.ratesUsed; track u.codeId) {
              <li>{{ u.code }}: {{ pct(u.rate) }} — {{ u.legalSource }}</li>
            }
          </ul>
        </section>
      }
    </div>
  `,
})
export class TaxSimulator {
  private readonly api = inject(Api);
  protected readonly entities = signal<{ legalEntityId: string; code: string; name: string }[]>([]);
  protected readonly codes = signal<TaxCodeRow[]>([]);
  protected readonly result = signal<TaxSimulation | null>(null);
  protected readonly act = new Action();
  protected readonly notice = SIMULATION_NOTICE;
  protected readonly money = money;
  protected readonly pct = ratePct;
  protected readonly kind = (k: string) => TAX_KIND[k] ?? k;
  protected readonly rounding = (k: string) => (ROUNDING[k] ?? k).toLowerCase();
  protected legalEntityId = '';
  protected date = new Date().toISOString().slice(0, 10);
  private seq = 0;
  protected lines: SimLine[] = [this.line()];
  protected readonly columns: Column<TaxSimulation['summary'][number]>[] = [
    {
      key: 'code',
      label: 'Imposto',
      required: true,
      value: (s) => `${s.code}${s.exemptionCode ? ' · isento ' + s.exemptionCode : ''}`,
    },
    { key: 'kind', label: 'Natureza', value: (s) => TAX_KIND[s.kind] },
    { key: 'rate', label: 'Taxa', align: 'end', value: (s) => ratePct(s.rate) },
    { key: 'base', label: 'Base', align: 'end', value: (s) => money(s.base) },
    {
      key: 'amount',
      label: 'Valor',
      align: 'end',
      value: (s) => (s.applied ? money(s.amount) : 'Abaixo da base mínima'),
    },
  ];

  constructor() {
    void Promise.all([
      this.api.get<{ items: { legalEntityId: string; code: string; name: string }[] }>(
        'sales/fiscal/settings',
      ),
      this.api.get<{ items: TaxCodeRow[] }>('sales/fiscal/tax-codes'),
    ]).then(
      ([s, c]) => {
        this.entities.set(s.items);
        if (s.items.length === 1) this.legalEntityId = s.items[0].legalEntityId;
        this.codes.set(c.items.filter((x) => x.status === 'ACTIVE'));
      },
      () => undefined,
    );
  }

  private line(): SimLine {
    return { key: ++this.seq, netAmount: '', codes: {}, exemptionCode: '' };
  }
  protected addLine() {
    this.lines = [...this.lines, this.line()];
  }

  protected async run() {
    const r = await this.act.run(() =>
      this.api.post<TaxSimulation>('sales/fiscal/simulate', {
        legalEntityId: this.legalEntityId,
        date: this.date,
        lines: this.lines.map((l) => ({
          netAmount: l.netAmount.trim().replace(',', '.'),
          taxCodeIds: Object.entries(l.codes)
            .filter(([, on]) => on)
            .map(([id]) => id),
          exemptionCode: l.exemptionCode.trim() || null,
        })),
      }),
    );
    this.result.set(r ?? null);
  }
}
