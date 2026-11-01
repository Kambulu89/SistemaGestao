import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import type { LineDto, Totals } from './orders.api';
import { formatDecimal, isPositiveQuantity, isRate, trimQuantity } from './orders-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'description', label: 'Artigo' },
  { key: 'quantity', label: 'Qtd.', align: 'end' },
  { key: 'shipped', label: 'Expedida', align: 'end' },
  { key: 'price', label: 'Preço', align: 'end' },
  { key: 'discount', label: 'Desc.', align: 'end' },
  { key: 'tax', label: 'IVA', align: 'end' },
  { key: 'total', label: 'Total', align: 'end' },
  { key: 'actions', label: '', align: 'end' },
];

export interface NewLineRequest {
  readonly sku: string;
  readonly quantity: string;
  readonly discountRate: string | null;
}

/**
 * Linhas de um documento comercial. Os preços, os impostos e os totais vêm do servidor (instantâneo): aqui só se pede
 * a variante, a quantidade e o desconto e se mostra o que o servidor calculou.
 */
@Component({
  selector: 'app-sales-lines',
  imports: [FormsModule, Button, Card, EmptyState, Input, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-card [flush]="true">
      @if (lines().length === 0) {
        <app-empty-state icon="tag" title="Sem linhas" />
      } @else {
        <app-table caption="Linhas" [columns]="columns()" [rows]="lines()" data-testid="lines">
          <ng-template let-row let-column="column">
            @switch (column.key) {
              @case ('description') {
                <span class="font-medium">{{ row.descriptionSnapshot }}</span>
                <span class="block text-xs text-fg-muted">
                  {{ row.priceOrigin.priceListName }} · a partir de
                  {{ trim(row.priceOrigin.minQuantity) }}
                </span>
              }
              @case ('quantity') {
                {{ trim(row.quantity) }}
              }
              @case ('shipped') {
                {{ row.shippedQty ? trim(row.shippedQty) : '—' }}
              }
              @case ('price') {
                {{ money(row.unitPrice) }}
              }
              @case ('discount') {
                {{ row.discountRate === '0.0000' ? '—' : row.discountRate }}
              }
              @case ('tax') {
                {{ row.taxRateSnapshot }} %
              }
              @case ('total') {
                <span class="font-medium">{{ money(row.total) }}</span>
              }
              @case ('actions') {
                @if (editable()) {
                  <app-button
                    size="sm"
                    variant="secondary"
                    [disabled]="busy()"
                    (click)="removed.emit(row.id)"
                    >Remover</app-button
                  >
                }
              }
            }
          </ng-template>
        </app-table>
        <dl class="grid gap-1 px-5 py-4 text-sm sm:ms-auto sm:w-80" data-testid="totals">
          <div class="flex justify-between">
            <dt class="text-fg-muted">Líquido</dt>
            <dd>{{ money(totals().net) }} {{ currency() }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-fg-muted">Imposto</dt>
            <dd>{{ money(totals().tax) }} {{ currency() }}</dd>
          </div>
          <div class="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd>{{ money(totals().total) }} {{ currency() }}</dd>
          </div>
        </dl>
      }
    </app-card>

    @if (editable()) {
      <app-card class="mt-4 block">
        <h4 class="mb-3 text-sm font-semibold">Nova linha</h4>
        @if (error(); as text) {
          <p class="mb-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="grid gap-4 sm:grid-cols-3">
          <app-input
            label="SKU da variante"
            [required]="true"
            [ngModel]="sku()"
            (ngModelChange)="sku.set($event ?? '')"
          />
          <app-input
            label="Quantidade"
            [required]="true"
            [ngModel]="quantity()"
            (ngModelChange)="quantity.set($event ?? '')"
          />
          <app-input
            label="Desconto (0 a 1)"
            hint="Vazio = sem desconto."
            [ngModel]="discount()"
            (ngModelChange)="discount.set($event ?? '')"
          />
        </div>
        <p class="mt-2 text-xs text-fg-muted">
          O preço e o imposto vêm do catálogo (tabela de preços e taxa válidas na data).
        </p>
        <app-button class="mt-4" [loading]="busy()" (click)="add()">Acrescentar linha</app-button>
      </app-card>
    }
  `,
})
export class SalesLines {
  readonly lines = input.required<readonly LineDto[]>();
  readonly totals = input.required<Totals>();
  readonly currency = input.required<string>();
  readonly editable = input(false);
  readonly busy = input(false);
  readonly added = output<NewLineRequest>();
  readonly removed = output<string>();

  // A coluna «Expedida» só existe nas encomendas (o servidor devolve `shippedQty` apenas aí).
  protected readonly columns = computed(() =>
    this.lines().some((l) => l.shippedQty !== undefined)
      ? COLUMNS
      : COLUMNS.filter((c) => c.key !== 'shipped'),
  );
  protected readonly sku = signal('');
  protected readonly quantity = signal('1');
  protected readonly discount = signal('');
  protected readonly error = signal<string | null>(null);

  protected money(value: string): string {
    return formatDecimal(value);
  }

  protected trim(value: string): string {
    return trimQuantity(value);
  }

  protected add(): void {
    this.error.set(null);
    if (!this.sku().trim()) return void this.error.set('Indique o SKU da variante.');
    if (!isPositiveQuantity(this.quantity())) {
      return void this.error.set('Quantidade: número positivo com até 6 casas.');
    }
    const discount = this.discount().trim();
    if (discount && !isRate(discount)) {
      return void this.error.set('Desconto: um valor entre 0 e 1 (ex.: 0.05).');
    }
    this.added.emit({
      sku: this.sku().trim(),
      quantity: this.quantity().trim(),
      discountRate: discount || null,
    });
    this.sku.set('');
    this.quantity.set('1');
    this.discount.set('');
  }
}
