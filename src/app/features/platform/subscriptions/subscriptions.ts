import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { errorMessage } from '../../../core/api/error-message';
import type { PageRequest } from '../../../core/api/pagination.model';
import { SUBSCRIPTION_LABELS } from '../../../core/modules/module-labels';
import type { SubscriptionStatus } from '../../../core/subscription/subscription.model';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Pagination } from '../../../shared/ui/pagination/pagination';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { BillingGateway } from '../billing/billing.gateway';

const PAGE_SIZE = 8;

@Component({
  selector: 'app-subscriptions',
  imports: [PageHeader, Card, Table, Pagination, Badge, LoadingState, Alert, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Subscrições"
      description="Contratos dos tenants: plano, estado, módulos e renovação (dados de demonstração)."
    />
    <app-card [flush]="true">
      @if (subscriptions.isLoading() && !subscriptions.hasValue()) {
        <app-loading-state label="A carregar subscrições…" />
      } @else if (subscriptions.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as subscrições">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (subscriptions.value(); as page) {
        <app-table caption="Subscrições" [columns]="columns" [rows]="page.items">
          <ng-template let-row let-column="column">
            @switch (column.key) {
              @case ('status') {
                <app-badge [tone]="status(row.status).tone">{{
                  status(row.status).label
                }}</app-badge>
              }
              @case ('moduleIds') {
                {{ row.moduleIds.length }}
              }
              @case ('renewsAt') {
                {{ row.renewsAt ? (row.renewsAt | date: 'mediumDate') : '—' }}
              }
              @default {
                {{ row[column.key] }}
              }
            }
          </ng-template>
        </app-table>
        <app-pagination
          class="border-t border-line"
          [page]="page.page"
          [pageSize]="page.pageSize"
          [total]="page.total"
          (pageChange)="pageNumber.set($event)"
        />
      }
    </app-card>
  `,
})
export class Subscriptions {
  private readonly gateway = inject(BillingGateway);

  protected readonly columns: readonly TableColumn[] = [
    { key: 'tenantName', label: 'Tenant' },
    { key: 'planCode', label: 'Plano' },
    { key: 'status', label: 'Estado' },
    { key: 'moduleIds', label: 'Módulos' },
    { key: 'renewsAt', label: 'Renovação' },
  ];

  protected readonly pageNumber = signal(1);
  private readonly request = computed<PageRequest>(() => ({
    page: this.pageNumber(),
    pageSize: PAGE_SIZE,
  }));

  protected readonly subscriptions = rxResource({
    params: () => this.request(),
    stream: ({ params }) => this.gateway.listSubscriptions(params),
  });

  protected readonly loadError = computed(() => errorMessage(this.subscriptions.error()));

  protected status(status: SubscriptionStatus) {
    return SUBSCRIPTION_LABELS[status];
  }
}
