import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { Action } from '../ui/load';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { FREQUENCY, RECURRING_STATUS, type RecurringRow, recurringTone } from './recurring-model';

/** Contratos de facturação recorrente: geram rascunhos de factura por período, nunca emitem. */
@Component({
  selector: 'app-recurring-list',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon, ErrorAlert],
  template: `
    <app-entity-list-page
      title="Facturação recorrente"
      subtitle="Contratos com versões de preço aprovadas. A geração cria rascunhos; a emissão é sempre de uma pessoa."
      feature="sales"
    >
      @if (canManage()) {
        <div actions class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn-secondary"
            data-testid="rl-generate"
            [disabled]="act.busy()"
            (click)="generate()"
          >
            Gerar rascunhos vencidos
          </button>
          <a class="btn-primary" routerLink="/vendas/recorrentes/novo" data-testid="rl-new"
            ><app-icon name="plus" [size]="16" />Novo contrato</a
          >
        </div>
      }
      @if (act.error(); as err) {
        <app-error-alert class="mb-3 block" [error]="err" [showDetails]="false" />
      }
      <app-filter-bar
        id="rl"
        label="contratos"
        placeholder="Referência, descrição ou cliente"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Contratos recorrentes"
        tableId="sales-recurring"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem contratos com estes filtros.'
            : 'Ainda não há contratos recorrentes.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="rl-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class RecurringList {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly act = new Action();
  protected readonly canManage = computed(() => this.workspace.canAny('sales.recurring.manage'));
  protected readonly tone = recurringTone;
  protected readonly status = (s: string) => RECURRING_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(RECURRING_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<RecurringRow>[] = [
    {
      key: 'reference',
      label: 'Contrato',
      required: true,
      link: (r) => ['/vendas/recorrentes', r.id],
      value: (r) => `${r.reference} — ${r.description}`,
    },
    { key: 'customer', label: 'Cliente', value: (r) => `${r.customer.code} — ${r.customer.name}` },
    {
      key: 'frequency',
      label: 'Periodicidade',
      hideOnMobile: true,
      value: (r) => FREQUENCY[r.frequency],
    },
    {
      key: 'next',
      label: 'Próxima factura',
      hideOnMobile: true,
      value: (r) => r.nextInvoiceDate ?? '—',
    },
    {
      key: 'periods',
      label: 'Períodos gerados',
      align: 'end',
      hiddenByDefault: true,
      value: (r) => String(r.periodsGenerated),
    },
    { key: 'status', label: 'Estado', value: (r) => RECURRING_STATUS[r.status] },
  ];
  protected readonly list = new ListState<RecurringRow>(this.api, {
    url: 'sales/recurring',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });

  protected async generate() {
    const r = await this.act.run(() =>
      this.api.post<{ contracts: number; generated: number; failed: number }>(
        'sales/recurring/generate',
        {},
      ),
    );
    if (!r) return;
    this.toasts.show(
      `${r.generated} rascunho(s) gerado(s)${r.failed ? `, ${r.failed} período(s) com falha` : ''}. Nada foi emitido.`,
    );
    this.list.reload();
  }
}
