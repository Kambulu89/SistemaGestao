import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDate } from '../ui/dates';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { qty } from '../inventory/stock-model';
import {
  DELIVERY_STATE,
  type DeliveryState,
  deliveryTone,
  type ExpectedDelivery,
} from './receipt-model';

/** Entregas previstas: o que falta receber das ordens emitidas, pela data prevista, com as atrasadas à vista. */
@Component({
  selector: 'app-expected-deliveries',
  imports: [FormsModule, RouterLink, PageHeader, ErrorState],
  template: `
    <app-page-header
      title="Entregas previstas"
      subtitle="Linhas de ordens emitidas com quantidade por receber, pela data de entrega prevista."
    />
    <form
      class="card mb-4 flex flex-wrap items-end gap-3"
      (submit)="$event.preventDefault(); load()"
    >
      <div>
        <label class="label" for="ex-state">Situação</label>
        <select
          id="ex-state"
          name="state"
          class="input w-48"
          data-testid="ex-state"
          [(ngModel)]="state"
        >
          <option value="">Todas</option>
          @for (s of states; track s[0]) {
            <option [value]="s[0]">{{ s[1] }}</option>
          }
        </select>
      </div>
      <button type="submit" class="btn-primary">Filtrar</button>
    </form>
    @if (error()) {
      <app-error-state [error]="error()" (retry)="load()" />
    } @else {
      <div class="card overflow-x-auto">
        <table class="w-full text-sm" data-testid="ex-table">
          <caption class="sr-only">
            Entregas previstas
          </caption>
          <thead>
            <tr class="text-left text-muted">
              <th class="px-2 py-1">Ordem</th>
              <th class="px-2 py-1">Fornecedor</th>
              <th class="px-2 py-1">Linha</th>
              <th class="whitespace-nowrap px-2 py-1 text-right">Em falta</th>
              <th class="px-2 py-1">Prevista</th>
              <th class="px-2 py-1">Situação</th>
              @if (canReceive()) {
                <th class="px-2 py-1"><span class="sr-only">Acções</span></th>
              }
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.lineId) {
              <tr class="border-t border-border">
                <td class="px-2 py-1">
                  <a class="link" [routerLink]="['/compras/ordens', r.order.id]">{{
                    r.order.number
                  }}</a>
                </td>
                <td class="px-2 py-1">{{ r.supplier.code }} — {{ r.supplier.name }}</td>
                <td class="px-2 py-1">{{ r.lineNo }} · {{ r.description }}</td>
                <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                  {{ q(r.open) }} {{ r.uom ?? '' }}
                </td>
                <td class="px-2 py-1">{{ date(r.expectedDate) }}</td>
                <td class="px-2 py-1">
                  <span class="badge" [class]="tone(r.state)">{{ label(r.state) }}</span>
                </td>
                @if (canReceive()) {
                  <td class="px-2 py-1">
                    <a
                      class="link"
                      data-testid="ex-receive"
                      routerLink="/compras/recepcoes/nova"
                      [queryParams]="{ orderId: r.order.id }"
                      >Receber</a
                    >
                  </td>
                }
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="px-2 py-3 text-muted">
                  {{ loading() ? 'A carregar…' : 'Nada por receber.' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class ExpectedDeliveries {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly rows = signal<ExpectedDelivery[]>([]);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly loading = signal(true);
  protected readonly canReceive = computed(() =>
    this.workspace.canAny('procurement.receipts.manage'),
  );
  protected readonly states = Object.entries(DELIVERY_STATE).filter(([k]) => k !== 'DONE');
  protected state = '';
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly tone = deliveryTone;
  protected readonly label = (s: DeliveryState) => DELIVERY_STATE[s];

  constructor() {
    void this.load();
  }

  protected async load() {
    this.error.set(null);
    this.loading.set(true);
    try {
      this.rows.set(
        await this.api.get<ExpectedDelivery[]>(
          'procurement/receipts/expected',
          this.state ? { state: this.state } : {},
        ),
      );
    } catch (e) {
      this.error.set(ApiError.from(e));
    } finally {
      this.loading.set(false);
    }
  }
}
