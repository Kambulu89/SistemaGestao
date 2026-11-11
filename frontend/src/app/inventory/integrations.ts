import { Component, computed, inject } from '@angular/core';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate, formatDateTime } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Action } from '../ui/load';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  ACCOUNTING_STATUS,
  type AccountingEvent,
  accountingTone,
  eventClasses,
  INTEGRATION_KIND,
  type IntegrationEvent,
  SOURCE_MODULE,
} from './integration-model';
import { money } from './valuation-model';

/**
 * Integrações e contabilização (8.10): o que o inventário enviou ao motor da contabilidade (lançado, ou falhado com o
 * motivo — repete-se depois de configurar a regra) e os pedidos de Compras/Vendas recebidos, com as referências.
 */
@Component({
  selector: 'app-integrations',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Integrações e contabilização"
      subtitle="Cada movimento com valor gera um evento para o motor de contabilização (origem INVENTORY). Sem regra, o evento fica falhado e o stock não é bloqueado."
      feature="inventory"
    >
      @if (canManage()) {
        <button
          actions
          type="button"
          class="btn-primary"
          data-testid="int-retry"
          [disabled]="retry.busy()"
          (click)="doRetry()"
        >
          Repetir falhados
        </button>
      }
      <h2 class="mb-2 font-semibold">Eventos contabilísticos</h2>
      <app-filter-bar
        id="acc"
        label="eventos contabilísticos"
        [searchable]="false"
        [state]="events"
        [filters]="eventFilters"
      />
      <app-data-table
        label="Eventos contabilísticos"
        tableId="inv-accounting-events"
        [columns]="eventColumns"
        [rows]="events.page.value()?.items ?? []"
        [total]="events.page.value()?.total ?? 0"
        [loading]="events.page.loading()"
        [error]="events.page.error()"
        [offset]="events.offset()"
        [limit]="events.limit"
        emptyText="Sem eventos contabilísticos."
        (offsetChange)="events.goTo($event)"
        (retry)="events.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="acc-status">{{
            statusLabel(row.status)
          }}</span>
          @if (row.error) {
            <span class="block text-xs text-danger-text" data-testid="acc-error">{{
              row.error
            }}</span>
          }
        </ng-template>
      </app-data-table>

      <h2 class="mb-2 mt-6 font-semibold">Pedidos de Compras e Vendas</h2>
      <app-filter-bar
        id="intg"
        label="pedidos"
        [searchable]="false"
        [state]="requests"
        [filters]="requestFilters"
      />
      <app-data-table
        label="Pedidos de integração"
        tableId="inv-integration-events"
        [columns]="requestColumns"
        [rows]="requests.page.value()?.items ?? []"
        [total]="requests.page.value()?.total ?? 0"
        [loading]="requests.page.loading()"
        [error]="requests.page.error()"
        [offset]="requests.offset()"
        [limit]="requests.limit"
        emptyText="Sem pedidos de Compras ou Vendas."
        (offsetChange)="requests.goTo($event)"
        (retry)="requests.reload()"
      />
    </app-entity-list-page>
  `,
})
export class Integrations {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly retry = new Action();
  protected readonly tone = accountingTone;
  protected readonly canManage = computed(() =>
    this.workspace.canAny('inventory.accounting.manage'),
  );
  protected readonly eventFilters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(ACCOUNTING_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly requestFilters: FilterDef[] = [
    {
      key: 'kind',
      label: 'Pedido',
      options: Object.entries(INTEGRATION_KIND).map(([value, label]) => ({ value, label })),
    },
    { key: 'orderRef', label: 'Encomenda', type: 'text', placeholder: 'Encomenda' },
  ];
  protected readonly eventColumns: Column<AccountingEvent>[] = [
    { key: 'occurredOn', label: 'Data', value: (e) => formatDate(e.occurredOn) },
    { key: 'event', label: 'Evento', required: true },
    { key: 'sourceRef', label: 'Referência', hideOnMobile: true },
    { key: 'le', label: 'Entidade', hideOnMobile: true, value: (e) => e.legalEntity.code },
    {
      key: 'classes',
      label: 'Classes',
      hideOnMobile: true,
      value: (e) => eventClasses(e.amounts).join(', ') || '—',
    },
    { key: 'total', label: 'Valor', align: 'end', value: (e) => money(e.total, e.currency) },
    {
      key: 'entry',
      label: 'Lançamento',
      hideOnMobile: true,
      value: (e) => e.entry?.number ?? '—',
      link: (e) => (e.entry ? ['/contabilidade/lancamentos', e.entry.id] : null),
    },
    { key: 'status', label: 'Estado', value: (e) => ACCOUNTING_STATUS[e.status] },
  ];
  protected readonly requestColumns: Column<IntegrationEvent>[] = [
    { key: 'createdAt', label: 'Recebido', value: (r) => formatDateTime(r.createdAt) },
    {
      key: 'kind',
      label: 'Pedido',
      required: true,
      value: (r) => INTEGRATION_KIND[r.kind] ?? r.kind,
    },
    { key: 'orderRef', label: 'Encomenda' },
    { key: 'documentRef', label: 'Documento', value: (r) => r.documentRef ?? '—' },
    { key: 'warehouse', label: 'Armazém', hideOnMobile: true, value: (r) => r.warehouse.code },
    {
      key: 'module',
      label: 'Origem',
      hideOnMobile: true,
      value: (r) => SOURCE_MODULE[r.sourceModule] ?? r.sourceModule,
    },
  ];
  protected readonly events = new ListState<AccountingEvent>(this.api, {
    url: 'inventory/accounting-events',
    filterKeys: ['status', 'legalEntityId', 'event'],
    sortFields: [],
    limit: 25,
  });
  protected readonly requests = new ListState<IntegrationEvent>(this.api, {
    url: 'inventory/integrations/events',
    filterKeys: ['kind', 'warehouseId', 'orderRef'],
    sortFields: [],
    limit: 25,
  });
  protected statusLabel(s: AccountingEvent['status']) {
    return ACCOUNTING_STATUS[s];
  }

  protected async doRetry() {
    const r = await this.retry.run(() =>
      this.api.post<{ posted: number; drafted: number; failed: number }>(
        'inventory/accounting-events/retry',
        {},
      ),
    );
    if (!r) {
      this.toasts.show(this.retry.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.toasts.show(
      `Repetidos: ${r.posted} lançado(s), ${r.drafted} em rascunho, ${r.failed} ainda falhado(s).`,
    );
    this.events.reload();
  }
}
