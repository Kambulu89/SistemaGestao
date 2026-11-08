import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import type { Plan } from './types';

@Component({
  selector: 'app-platform-plans',
  imports: [EntityListPage, RouterLink, DataTable, CellDef, StatusBadge],
  template: `
    <app-entity-list-page
      title="Planos"
      subtitle="Publicado, um plano não se altera: crie outro e mude as subscrições."
    >
      <a actions routerLink="/plataforma/planos/novo" class="btn-primary">Novo plano</a>
      <app-data-table
        label="Planos"
        tableId="platform-plans"
        [columns]="columns"
        [rows]="plans.value() ?? []"
        [total]="(plans.value() ?? []).length"
        [limit]="1000"
        [loading]="plans.loading()"
        [error]="plans.error()"
        emptyText="Ainda não há planos."
        (retry)="plans.load()"
      >
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class PlatformPlans {
  private readonly api = inject(Api);
  protected readonly columns: Column<Plan>[] = [
    { key: 'code', label: 'Código', required: true, link: (p) => ['/plataforma/planos', p.id] },
    { key: 'name', label: 'Nome' },
    { key: 'features', label: 'Funcionalidades', align: 'end', value: (p) => p.features.length },
    { key: 'trialDays', label: 'Experimental', value: (p) => `${p.trialDays} dias` },
    { key: 'status', label: 'Estado' },
    {
      key: 'publishedAt',
      label: 'Publicado',
      hideOnMobile: true,
      value: (p) => (p.publishedAt ? formatDateTime(p.publishedAt) : null),
    },
  ];
  protected readonly plans = new Loadable(() => this.api.get<Plan[]>('platform/plans'));

  constructor() {
    void this.plans.load();
  }
}
