import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import type { Workflow } from './types';

@Component({
  selector: 'app-workflows',
  imports: [RouterLink, EntityListPage, DataTable, CellDef, StatusBadge],
  template: `
    <app-entity-list-page
      title="Workflows de aprovação"
      subtitle="Etapas e aprovadores. Publicado, não se altera: retire e crie outro."
      permission="approvals.manage"
      feature="approvals"
    >
      <a actions routerLink="/aprovacoes/workflows/novo" class="btn-primary">Novo workflow</a>
      <app-data-table
        label="Workflows"
        tableId="approval-workflows"
        [columns]="columns"
        [rows]="list.value() ?? []"
        [total]="(list.value() ?? []).length"
        [limit]="1000"
        [loading]="list.loading()"
        [error]="list.error()"
        emptyText="Ainda não há workflows."
        (retry)="list.load()"
      >
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Workflows {
  private readonly api = inject(Api);
  protected readonly columns: Column<Workflow>[] = [
    { key: 'name', label: 'Nome', required: true, link: (w) => ['/aprovacoes/workflows', w.id] },
    { key: 'code', label: 'Código' },
    { key: 'steps', label: 'Etapas', align: 'end', value: (w) => w.steps.length },
    { key: 'status', label: 'Estado' },
    {
      key: 'publishedAt',
      label: 'Publicado',
      hideOnMobile: true,
      value: (w) => (w.publishedAt ? formatDateTime(w.publishedAt) : null),
    },
  ];
  protected readonly list = new Loadable(() => this.api.get<Workflow[]>('approvals/workflows'));

  constructor() {
    void this.list.load();
  }
}
