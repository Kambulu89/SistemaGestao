import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { PlanLimit } from '../../../core/subscription/subscription.model';
import { Alert } from '../../../shared/ui/alert/alert';
import { Card } from '../../../shared/ui/card/card';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { BillingGateway } from '../billing/billing.gateway';

const formatLimit = (limit: PlanLimit | undefined): string =>
  !limit
    ? '—'
    : limit.limit === null
      ? 'Ilimitado'
      : `${limit.limit}${limit.unit ? ' ' + limit.unit : ''}`;

@Component({
  selector: 'app-plans',
  imports: [PageHeader, Card, Table, LoadingState, Alert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Planos"
      description="Módulos incluídos e limites de utilização de cada plano (dados de demonstração)."
    />
    <app-card [flush]="true">
      @if (plans.isLoading() && !plans.hasValue()) {
        <app-loading-state label="A carregar planos…" />
      } @else if (plans.error()) {
        <div class="p-5">
          <app-alert tone="danger">Não foi possível carregar os planos.</app-alert>
        </div>
      } @else {
        <app-table caption="Planos" [columns]="columns" [rows]="rows()" />
      }
    </app-card>
  `,
})
export class Plans {
  private readonly gateway = inject(BillingGateway);

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Plano' },
    { key: 'description', label: 'Descrição' },
    { key: 'modules', label: 'Módulos incluídos' },
    { key: 'users', label: 'Utilizadores' },
    { key: 'storage', label: 'Armazenamento' },
  ];

  protected readonly plans = rxResource({ stream: () => this.gateway.listPlans() });

  protected readonly rows = computed(() =>
    (this.plans.value() ?? []).map((plan) => ({
      name: plan.name,
      description: plan.description,
      modules: plan.moduleIds.length,
      users: formatLimit(plan.limits.find((l) => l.key === 'users')),
      storage: formatLimit(plan.limits.find((l) => l.key === 'storage')),
    })),
  );
}
