import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { money } from '../inventory/valuation-model';
import {
  LIMIT_SOURCE,
  percent,
  price,
  PRICE_SOURCE,
  type PriceSnapshot,
  type PricingOptions,
  qty,
  REASON,
  type ResolvedLine,
} from './pricing-model';

interface CheckLine {
  key: number;
  productId: string;
  quantity: string;
  manualDiscountPct: string;
  manualUnitPrice: string;
}

/**
 * Consulta de preços: o mesmo motor que os documentos de venda usam (tabela, regra, limite e aprovação), sem gravar
 * nada. Mostra de onde vem cada valor e a impressão digital do snapshot.
 */
@Component({
  selector: 'app-price-check',
  imports: [
    FormsModule,
    PageHeader,
    FormSection,
    FormField,
    FieldControl,
    Autocomplete,
    DataTable,
    ErrorAlert,
    Icon,
  ],
  template: `
    <app-page-header
      title="Consulta de preços"
      subtitle="Calcula o preço que um documento de venda usaria, sem gravar nada."
    />
    <div class="space-y-4">
      <app-form-section title="Pedido" [columns]="2">
        <app-field #cf label="Cliente" [required]="true" [error]="act.field('customerId')">
          <app-autocomplete
            name="customer"
            data-testid="pc-customer"
            [inputId]="cf.controlId"
            [describedBy]="cf.describedBy()"
            [search]="searchCustomers"
            [(ngModel)]="customerId"
          />
        </app-field>
        <app-field label="Moeda" [required]="true" [error]="act.field('currency')">
          <input
            appControl
            class="input w-24 uppercase"
            name="currency"
            maxlength="3"
            data-testid="pc-currency"
            [(ngModel)]="currency"
          />
        </app-field>
        <app-field label="Data" [required]="true" [error]="act.field('date')">
          <input
            appControl
            class="input"
            type="date"
            name="date"
            data-testid="pc-date"
            [(ngModel)]="date"
          />
        </app-field>
        <app-field
          label="Entidade legal"
          hint="Vazio: só tabelas de todas as entidades."
          [error]="act.field('legalEntityId')"
        >
          <select appControl class="input" name="le" [(ngModel)]="legalEntityId">
            <option value="">—</option>
            @for (e of opts()?.legalEntities ?? []; track e.id) {
              <option [value]="e.id">{{ e.code }} — {{ e.name }}</option>
            }
          </select>
        </app-field>
      </app-form-section>

      <section class="card space-y-3" aria-labelledby="pc-lines-title">
        <h2 id="pc-lines-title" class="font-semibold">Linhas</h2>
        @for (l of lines; track l.key; let i = $index) {
          <div class="grid gap-3 border-b border-border pb-3 md:grid-cols-5" data-testid="pc-line">
            <div class="md:col-span-2">
              <app-field
                #pf
                label="Produto"
                [required]="true"
                [error]="act.field('lines.' + i + '.productId')"
              >
                <app-autocomplete
                  [name]="'product-' + l.key"
                  data-testid="pc-product"
                  [inputId]="pf.controlId"
                  [describedBy]="pf.describedBy()"
                  [search]="searchProducts"
                  [(ngModel)]="l.productId"
                />
              </app-field>
            </div>
            <app-field
              label="Quantidade"
              [required]="true"
              [error]="act.field('lines.' + i + '.quantity')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'qty-' + l.key"
                data-testid="pc-qty"
                [(ngModel)]="l.quantity"
              />
            </app-field>
            <app-field
              label="Desconto manual (%)"
              [error]="act.field('lines.' + i + '.manualDiscountPct')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'disc-' + l.key"
                data-testid="pc-disc"
                [(ngModel)]="l.manualDiscountPct"
              />
            </app-field>
            <app-field label="Preço manual" [error]="act.field('lines.' + i + '.manualUnitPrice')">
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'mp-' + l.key"
                [(ngModel)]="l.manualUnitPrice"
              />
            </app-field>
            @if (lines.length > 1) {
              <div class="md:col-span-5">
                <button
                  type="button"
                  class="link text-sm"
                  [attr.aria-label]="'Remover a linha ' + (i + 1)"
                  (click)="removeLine(i)"
                >
                  Remover linha
                </button>
              </div>
            }
          </div>
        }
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn-secondary" (click)="addLine()">
            <app-icon name="plus" [size]="16" />Linha
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="pc-run"
            [disabled]="act.busy()"
            (click)="run()"
          >
            Calcular
          </button>
        </div>
        <app-error-alert [error]="act.error()" [showDetails]="true" />
      </section>

      @if (result(); as r) {
        <section class="card space-y-3" aria-labelledby="pc-res-title" data-testid="pc-result">
          <h2 id="pc-res-title" class="font-semibold">Resultado</h2>
          <div class="flex flex-wrap gap-2 text-sm">
            <span
              >{{ r.customer.code }} — {{ r.customer.name }} · {{ r.currency }} · {{ r.date }}</span
            >
            @if (r.requiresApproval) {
              <span class="badge bg-warning-soft text-warning-text" data-testid="pc-approval"
                >Precisa de aprovação</span
              >
            }
            @if (r.missingPrices) {
              <span class="badge bg-danger-soft text-danger-text">Linhas sem preço</span>
            }
            @if (r.customer.status !== 'ACTIVE') {
              <span class="badge bg-danger-soft text-danger-text"
                >Cliente {{ r.customer.status === 'BLOCKED' ? 'bloqueado' : 'inactivo' }}</span
              >
            }
          </div>
          <app-data-table
            label="Preços calculados"
            [columns]="columns"
            [rows]="r.lines"
            [total]="r.lines.length"
            [limit]="1000"
            emptyText="Sem linhas."
          />
          <p class="break-all text-xs text-muted">Impressão digital do snapshot: {{ r.hash }}</p>
        </section>
      }
    </div>
  `,
})
export class PriceCheck {
  private readonly api = inject(Api);
  protected readonly opts = signal<PricingOptions | null>(null);
  protected readonly result = signal<PriceSnapshot | null>(null);
  protected readonly act = new Action();
  protected customerId = '';
  protected currency = 'AOA';
  protected date = new Date().toISOString().slice(0, 10);
  protected legalEntityId = '';
  private seq = 0;
  protected lines: CheckLine[] = [this.line()];
  protected readonly columns: Column<ResolvedLine>[] = [
    { key: 'sku', label: 'Produto', required: true, value: (l) => `${l.sku} — ${l.name}` },
    { key: 'quantity', label: 'Qtd.', align: 'end', value: (l) => qty(l.quantity) },
    {
      key: 'source',
      label: 'Origem',
      value: (l) =>
        PRICE_SOURCE[l.source] +
        (l.priceListCode ? ` ${l.priceListCode}` : '') +
        (l.tierMinQuantity && l.tierMinQuantity !== '1.000000'
          ? ` (≥ ${qty(l.tierMinQuantity)})`
          : ''),
    },
    { key: 'basePrice', label: 'Preço base', align: 'end', value: (l) => price(l.basePrice) },
    {
      key: 'rule',
      label: 'Regra',
      hideOnMobile: true,
      value: (l) => (l.ruleCode ? `${l.ruleCode} · ${percent(l.rulePct)}` : '—'),
    },
    {
      key: 'manual',
      label: 'Desconto manual',
      align: 'end',
      value: (l) => percent(l.manualDiscountPct),
    },
    {
      key: 'limit',
      label: 'Limite',
      hideOnMobile: true,
      value: (l) => `${percent(l.limitPct)} ${LIMIT_SOURCE[l.limitSource]}`,
    },
    { key: 'net', label: 'Preço líquido', align: 'end', value: (l) => price(l.netUnitPrice) },
    { key: 'amount', label: 'Valor', align: 'end', value: (l) => money(l.netAmount) },
    {
      key: 'approval',
      label: 'Aprovação',
      value: (l) => (l.reasons.length ? l.reasons.map((x) => REASON[x] ?? x).join('; ') : 'Não'),
    },
  ];

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string }[]>(
        'sales/pricing/search/customers',
        { q },
      )
    ).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));
  protected readonly searchProducts = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; sku: string; name: string }[]>(
        'sales/pricing/search/products',
        { q },
      )
    ).map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}` }));

  constructor() {
    this.api.get<PricingOptions>('sales/pricing/options').then(
      (o) => this.opts.set(o),
      () => undefined,
    );
  }

  private line(): CheckLine {
    return {
      key: ++this.seq,
      productId: '',
      quantity: '1',
      manualDiscountPct: '',
      manualUnitPrice: '',
    };
  }
  protected addLine() {
    this.lines = [...this.lines, this.line()];
  }
  protected removeLine(i: number) {
    const gone = this.lines[i];
    this.lines = this.lines.filter((l) => l !== gone);
  }

  protected async run() {
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    const r = await this.act.run(() =>
      this.api.post<PriceSnapshot>('sales/pricing/resolve', {
        customerId: this.customerId,
        currency: this.currency.trim().toUpperCase(),
        date: this.date,
        legalEntityId: nz(this.legalEntityId),
        lines: this.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity.trim(),
          manualDiscountPct: nz(l.manualDiscountPct),
          manualUnitPrice: nz(l.manualUnitPrice),
        })),
      }),
    );
    this.result.set(r ?? null);
  }
}
