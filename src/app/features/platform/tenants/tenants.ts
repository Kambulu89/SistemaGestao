import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { ApiError } from '../../../core/api/api-error.model';
import type { PageRequest } from '../../../core/api/pagination.model';
import { TENANT_STATUS_LABELS } from '../../../core/modules/module-labels';
import type { TenantStatus } from '../../../core/tenant-context/tenant.model';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Pagination } from '../../../shared/ui/pagination/pagination';
import { Table, type TableColumn, type TableSort } from '../../../shared/ui/table/table';
import { TenantsGateway } from './tenants.gateway';

const PAGE_SIZE = 8;

@Component({
  selector: 'app-tenants',
  imports: [Alert, Badge, Card, EmptyState, LoadingState, PageHeader, Pagination, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Tenants"
      description="Organizações clientes da plataforma (dados de demonstração)."
    />

    <app-card [flush]="true">
      @if (tenants.isLoading() && !tenants.hasValue()) {
        <app-loading-state label="A carregar tenants…" />
      } @else if (tenants.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os tenants">
            {{ errorMessage() }}
          </app-alert>
        </div>
      } @else if (tenants.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state title="Ainda não há tenants" icon="building" />
        } @else {
          <app-table
            caption="Lista de tenants"
            [columns]="columns"
            [rows]="page.items"
            [sort]="sort()"
            (sortChange)="onSort($event)"
          >
            <ng-template let-row let-column="column">
              @if (column.key === 'status') {
                <app-badge [tone]="status(row.status).tone">{{
                  status(row.status).label
                }}</app-badge>
              } @else {
                {{ row[column.key] }}
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
      }
    </app-card>
  `,
})
export class Tenants {
  private readonly gateway = inject(TenantsGateway);

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Nome', sortable: true },
    { key: 'slug', label: 'Identificador' },
    { key: 'planName', label: 'Plano', sortable: true },
    { key: 'status', label: 'Estado', sortable: true },
  ];

  protected readonly pageNumber = signal(1);
  protected readonly sort = signal<TableSort | undefined>(undefined);

  private readonly request = computed<PageRequest>(() => ({
    page: this.pageNumber(),
    pageSize: PAGE_SIZE,
    sort: this.sort(),
  }));

  protected readonly tenants = rxResource({
    params: () => this.request(),
    stream: ({ params }) => this.gateway.list(params),
  });

  protected readonly errorMessage = computed(
    () => (this.tenants.error() as unknown as ApiError | undefined)?.message ?? 'Tente novamente.',
  );

  protected onSort(sort: TableSort): void {
    this.sort.set(sort);
    this.pageNumber.set(1);
  }

  protected status(status: TenantStatus) {
    return TENANT_STATUS_LABELS[status];
  }
}
