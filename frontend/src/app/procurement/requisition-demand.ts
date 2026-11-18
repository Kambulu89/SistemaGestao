import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { formatDate } from '../ui/dates';
import { ErrorState } from '../ui/states';
import { PageHeader } from '../ui/page-header';
import { money } from '../inventory/valuation-model';
import { qty } from '../inventory/stock-model';
import { type DemandGroup, PRIORITY } from './requisition-model';

/**
 * Necessidades consolidadas (compradores): o que as requisições aprovadas ainda têm em aberto, junto por entidade,
 * produto e unidade (as linhas de descrição livre ficam à parte), com a necessidade mais cedo e as requisições de origem.
 */
@Component({
  selector: 'app-requisition-demand',
  imports: [FormsModule, RouterLink, PageHeader, ErrorState],
  template: `
    <app-page-header
      title="Necessidades consolidadas"
      subtitle="Quantidades em aberto das requisições aprovadas, prontas para cotar e encomendar."
    />
    <form
      class="card mb-4 flex flex-wrap items-end gap-3"
      (submit)="$event.preventDefault(); load()"
    >
      <div>
        <label class="label" for="dm-q">Produto ou descrição</label>
        <input id="dm-q" name="q" class="input w-64" data-testid="dm-q" [(ngModel)]="q" />
      </div>
      <button type="submit" class="btn-primary">Filtrar</button>
    </form>
    @if (error()) {
      <app-error-state [error]="error()" (retry)="load()" />
    } @else {
      <div class="card overflow-x-auto">
        <table class="w-full text-sm" data-testid="dm-table">
          <caption class="sr-only">
            Necessidades consolidadas
          </caption>
          <thead>
            <tr class="text-left text-muted">
              <th class="px-2 py-1">Produto</th>
              <th class="px-2 py-1">Entidade</th>
              <th class="whitespace-nowrap px-2 py-1 text-right">Em aberto</th>
              <th class="whitespace-nowrap px-2 py-1 text-right">Valor estimado</th>
              <th class="px-2 py-1">Necessário a</th>
              <th class="px-2 py-1">Prioridade</th>
              <th class="px-2 py-1">Requisições</th>
            </tr>
          </thead>
          <tbody>
            @for (g of rows(); track g.key) {
              <tr class="border-t border-border">
                <td class="px-2 py-1">
                  {{ g.product ? g.product.sku + ' — ' : '' }}{{ g.description }}
                </td>
                <td class="px-2 py-1">{{ g.legalEntity.code }}</td>
                <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                  {{ q2(g.open) }} {{ g.uom ?? '' }}
                </td>
                <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                  {{ money(g.estimatedValue, g.currency) }}
                </td>
                <td class="px-2 py-1">{{ date(g.neededBy) }}</td>
                <td class="px-2 py-1">{{ prio(g.priority) }}</td>
                <td class="px-2 py-1">
                  @for (l of g.lines; track l.lineId) {
                    <a class="link mr-2" [routerLink]="['/compras/requisicoes', l.requisitionId]"
                      >{{ l.number }} ({{ q2(l.open) }})</a
                    >
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="px-2 py-3 text-muted">
                  {{ loading() ? 'A carregar…' : 'Nada em aberto.' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class RequisitionDemand {
  private readonly api = inject(Api);
  protected readonly rows = signal<DemandGroup[]>([]);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly loading = signal(true);
  protected q = '';
  protected readonly money = money;
  protected readonly q2 = qty;
  protected readonly date = formatDate;
  protected readonly prio = (p: DemandGroup['priority']) => PRIORITY[p];

  constructor() {
    void this.load();
  }

  protected async load() {
    this.error.set(null);
    this.loading.set(true);
    try {
      this.rows.set(
        await this.api.get<DemandGroup[]>(
          'procurement/requisitions/demand',
          this.q.trim() ? { q: this.q.trim() } : {},
        ),
      );
    } catch (e) {
      this.error.set(ApiError.from(e));
    } finally {
      this.loading.set(false);
    }
  }
}
