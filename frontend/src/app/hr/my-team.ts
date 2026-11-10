import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { Kpi } from '../ui/kpi';
import { PageHeader } from '../ui/page-header';
import { EmptyState, ErrorState, Skeleton } from '../ui/states';
import { daysLabel } from './leave-model';
import type { Team, TeamMember } from './portal-model';

/**
 * A minha equipa (chefia): quem chefio directa e indirectamente, ausências (tipos confidenciais mascarados), alertas de
 * fim de contrato, período experimental e certificados, e os pedidos pendentes com os que posso decidir. Nunca
 * salários nem dados pessoais (a API não os envia).
 */
@Component({
  selector: 'app-my-team',
  imports: [RouterLink, PageHeader, DataTable, CellDef, Kpi, EmptyState, ErrorState, Skeleton],
  template: `
    <app-page-header
      title="A minha equipa"
      subtitle="Quem chefia, ausências, alertas e pedidos que pode decidir."
    />
    @if (notLinked()) {
      <app-empty-state
        icon="users"
        title="Sem ficha de colaborador"
        description="A sua conta não está ligada a uma ficha de colaborador."
      />
    } @else if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else if (!team()) {
      <div class="card"><app-skeleton /></div>
    } @else if (!team()!.members.length) {
      <app-empty-state
        icon="users"
        title="Sem equipa"
        description="Ninguém tem a sua ficha como chefia directa."
      />
    } @else {
      @let t = team()!;
      <div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <app-kpi
          label="Equipa"
          [value]="t.summary.size"
          [detail]="t.summary.direct + ' directos'"
          testId="mt-size"
        />
        <app-kpi label="Ausentes hoje" [value]="t.summary.absentToday" testId="mt-absent" />
        <app-kpi
          label="Pedidos que pode decidir"
          [value]="t.summary.toDecide"
          [tone]="t.summary.toDecide ? 'warning' : 'neutral'"
          link="/rh/ausencias"
          testId="mt-decide"
        />
        <app-kpi
          label="Alertas (60 dias)"
          [value]="t.summary.alerts"
          [tone]="t.summary.alerts ? 'warning' : 'neutral'"
          testId="mt-alerts"
        />
      </div>

      <section class="card" aria-labelledby="mt-members">
        <h2 id="mt-members" class="mb-3 font-semibold">Pessoas</h2>
        <app-data-table
          label="A minha equipa"
          tableId="hr-team"
          [columns]="columns"
          [rows]="t.members"
          [total]="t.members.length"
          [limit]="500"
          emptyText="Sem pessoas."
        >
          <ng-template appCell="fullName" let-row>
            <span [class.pl-4]="row.depth > 1">{{ row.fullName }}</span>
            @if (row.depth > 1) {
              <span class="block pl-4 text-xs text-muted">via {{ row.managerName }}</span>
            }
          </ng-template>
          <ng-template appCell="today" let-row>
            @if (row.absentToday) {
              <span class="badge bg-warning-soft text-warning-text"
                >Ausente · {{ row.absentToday.leaveType.name }}</span
              >
            } @else {
              <span class="badge bg-success-soft text-success-text">Presente</span>
            }
          </ng-template>
          <ng-template appCell="alerts" let-row>
            @for (a of row.alerts; track a.kind + a.date) {
              <span class="block text-xs text-warning-text"
                >{{ a.label }} · {{ date(a.date) }}</span
              >
            } @empty {
              <span class="text-xs text-muted">—</span>
            }
          </ng-template>
        </app-data-table>
      </section>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <section class="card" aria-labelledby="mt-pending" data-testid="mt-pending">
          <h2 id="mt-pending" class="mb-3 font-semibold">Pedidos pendentes</h2>
          <ul class="divide-y divide-border text-sm">
            @for (p of t.pending; track p.id) {
              <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                <span
                  >{{ p.employee.fullName }} · {{ p.leaveType.name }} · {{ date(p.startDate) }} –
                  {{ date(p.endDate) }} ({{ days(p.days) }})</span
                >
                @if (p.canDecide) {
                  <a class="link" [routerLink]="['/rh/ausencias', p.id]">Decidir</a>
                } @else {
                  <span class="text-xs text-muted">Decide outra chefia</span>
                }
              </li>
            } @empty {
              <li class="py-2 text-muted">Sem pedidos pendentes.</li>
            }
          </ul>
        </section>
        <section class="card" aria-labelledby="mt-absences" data-testid="mt-absences">
          <h2 id="mt-absences" class="mb-3 font-semibold">Ausências até {{ date(t.horizon) }}</h2>
          <ul class="divide-y divide-border text-sm">
            @for (a of t.absences; track a.id) {
              <li class="py-2">
                {{ a.employee.fullName }} · {{ a.leaveType.name }} · {{ date(a.startDate) }} –
                {{ date(a.endDate) }}
              </li>
            } @empty {
              <li class="py-2 text-muted">Sem ausências aprovadas.</li>
            }
          </ul>
        </section>
      </div>
    }
  `,
})
export class MyTeamPage {
  private readonly api = inject(Api);
  protected readonly team = signal<Team | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly notLinked = signal(false);
  protected readonly date = (d: string) => formatDate(d);
  protected readonly days = daysLabel;
  protected readonly columns: Column<TeamMember>[] = [
    { key: 'fullName', label: 'Nome', required: true, value: (m) => m.fullName },
    { key: 'positionName', label: 'Cargo', hideOnMobile: true },
    { key: 'departmentName', label: 'Departamento', hideOnMobile: true },
    { key: 'today', label: 'Hoje', value: (m) => (m.absentToday ? 'Ausente' : 'Presente') },
    {
      key: 'nextAbsence',
      label: 'Próxima ausência',
      hideOnMobile: true,
      value: (m) => (m.nextAbsence ? formatDate(m.nextAbsence.startDate) : '—'),
    },
    { key: 'pendingRequests', label: 'Pendentes', value: (m) => String(m.pendingRequests) },
    { key: 'alerts', label: 'Alertas', value: (m) => m.alerts.map((a) => a.label).join('; ') },
  ];

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.team.set(await this.api.get<Team>('hr/team'));
    } catch (error) {
      const e = ApiError.from(error);
      if (e.code === 'NOT_LINKED') this.notLinked.set(true);
      else this.loadError.set(e);
    }
  }
}
