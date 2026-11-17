import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  SUPPLIER_STATUS,
  SUPPLIER_TYPE,
  type SupplierRow,
  type SupplierStatus,
  supplierTone,
} from './supplier-model';

/** Fornecedores: pesquisa por código, nome ou NIF; filtros de estado e tipo na URL; homologação válida por linha. */
@Component({
  selector: 'app-suppliers',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Fornecedores"
      subtitle="Terceiros a quem a empresa compra: condições comerciais, documentos com validade, dados bancários protegidos e homologação."
      feature="procurement"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/compras/fornecedores/novo" data-testid="sup-new"
          ><app-icon name="plus" [size]="16" />Novo fornecedor</a
        >
      }
      <app-filter-bar
        id="sup"
        label="fornecedores"
        placeholder="Código, nome ou NIF"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Fornecedores"
        tableId="proc-suppliers"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [sort]="list.sort()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem fornecedores com estes filtros.'
            : 'Ainda não há fornecedores.'
        "
        (sortChange)="list.setSort($event)"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="sup-status">{{
            status(row.status)
          }}</span>
        </ng-template>
        <ng-template appCell="qualification" let-row>
          @if (row.qualificationValid) {
            <span class="text-success-text">Em dia</span>
          } @else {
            <span class="text-danger-text">Documentos em falta ou caducados</span>
          }
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Suppliers {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.can('procurement.suppliers.manage'));
  protected readonly tone = supplierTone;
  protected readonly status = (s: SupplierStatus) => SUPPLIER_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(SUPPLIER_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'supplierType',
      label: 'Tipo',
      options: Object.entries(SUPPLIER_TYPE).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<SupplierRow>[] = [
    {
      key: 'code',
      label: 'Código',
      sortable: true,
      required: true,
      value: (s) => s.partner.code,
      link: (s) => ['/compras/fornecedores', s.id],
    },
    { key: 'name', label: 'Nome', sortable: true, value: (s) => s.partner.name },
    { key: 'taxId', label: 'NIF', hideOnMobile: true, value: (s) => s.partner.taxId },
    {
      key: 'supplierType',
      label: 'Tipo',
      hideOnMobile: true,
      value: (s) => SUPPLIER_TYPE[s.supplierType],
    },
    { key: 'currency', label: 'Moeda', hideOnMobile: true, hiddenByDefault: true },
    {
      key: 'terms',
      label: 'Prazo',
      hideOnMobile: true,
      hiddenByDefault: true,
      value: (s) => `${s.paymentTermsDays} dias`,
    },
    {
      key: 'qualification',
      label: 'Documentos',
      hideOnMobile: true,
      value: (s) => (s.qualificationValid ? 'Em dia' : 'Em falta ou caducados'),
    },
    {
      key: 'approvedAt',
      label: 'Homologado em',
      hideOnMobile: true,
      hiddenByDefault: true,
      value: (s) => (s.approvedAt ? formatDate(s.approvedAt) : null),
    },
    { key: 'status', label: 'Estado', sortable: true, value: (s) => this.status(s.status) },
  ];
  protected readonly list = new ListState<SupplierRow>(this.api, {
    url: 'procurement/suppliers',
    filterKeys: ['status', 'supplierType'],
    sortFields: ['code', 'name', 'status', 'createdAt'],
    limit: 25,
  });
}
