import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { exportList, withoutPaging } from '../ui/export';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { type Employee, EMPLOYEE_STATUS, type EmployeeStatus } from './model';

const LIMIT = 25;

interface OrgOption {
  id: string;
  code: string;
  name?: string;
  legalName?: string;
}

/**
 * Colaboradores (EntityListPage). A API só devolve os do âmbito do membro (empresa, entidade, filial, departamento ou
 * o próprio) e nunca dados pessoais nas listas. Filtros e ordenação na URL; a entidade da barra superior aplica-se.
 */
@Component({
  selector: 'app-employees',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Colaboradores"
      subtitle="Fichas dos colaboradores no seu âmbito. Os dados pessoais só aparecem na ficha, a quem os pode ver."
      permission="hr.read"
      feature="hr"
      [anyScope]="true"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/rh/colaboradores/novo"
          ><app-icon name="plus" [size]="16" />Novo colaborador</a
        >
      }
      <app-filter-bar
        id="emp"
        label="colaboradores"
        placeholder="Código, nome ou email profissional"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Colaboradores"
        tableId="hr-employees"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [sort]="list.sort()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [exportable]="true"
        [exporting]="exporting()"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem colaboradores com estes filtros.'
            : 'Ainda não há colaboradores no seu âmbito.'
        "
        (sortChange)="list.setSort($event)"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
        (export)="export($event)"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ statusLabel(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Employees {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly canManage = computed(() => this.workspace.canAny('hr.manage'));
  protected readonly exporting = signal(false);
  private readonly departments = signal<OrgOption[]>([]);
  protected readonly statusLabel = (s: EmployeeStatus) => EMPLOYEE_STATUS[s] ?? s;
  protected readonly tone = (s: EmployeeStatus) =>
    s === 'ACTIVE'
      ? 'bg-success-soft text-success-text'
      : s === 'SUSPENDED'
        ? 'bg-warning-soft text-warning-text'
        : 'bg-surface-2 text-muted';
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(EMPLOYEE_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'departmentId',
      label: 'Departamento',
      options: this.departments().map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
    },
  ]);
  protected readonly columns: Column<Employee>[] = [
    {
      key: 'code',
      label: 'Código',
      sortable: true,
      required: true,
      link: (e) => ['/rh/colaboradores', e.id],
    },
    { key: 'fullName', label: 'Nome', sortable: true },
    { key: 'legalEntity', label: 'Entidade', hideOnMobile: true, value: (e) => e.legalEntity.code },
    { key: 'departmentName', label: 'Departamento', hideOnMobile: true },
    { key: 'positionName', label: 'Cargo', hideOnMobile: true },
    {
      key: 'manager',
      label: 'Superior',
      hideOnMobile: true,
      hiddenByDefault: true,
      value: (e) => e.manager?.fullName ?? null,
    },
    { key: 'workEmail', label: 'Email profissional', hideOnMobile: true, hiddenByDefault: true },
    {
      key: 'hireDate',
      label: 'Admissão',
      sortable: true,
      hideOnMobile: true,
      value: (e) => formatDate(e.hireDate),
    },
    { key: 'status', label: 'Estado', sortable: true, value: (e) => this.statusLabel(e.status) },
  ];
  protected readonly list = new ListState<Employee>(this.api, {
    url: 'hr/employees',
    filterKeys: ['status', 'departmentId'],
    sortFields: ['code', 'fullName', 'hireDate', 'status'],
    limit: LIMIT,
    extra: () => ({ legalEntityId: this.workspace.legalEntityId() ?? undefined }),
  });

  constructor() {
    if (this.workspace.can('organization.read'))
      this.api.page<OrgOption>('organization/departments', { limit: 200 }).then(
        (p) => this.departments.set(p.items),
        () => undefined,
      );
    // Mudar a entidade legal na barra superior recarrega a lista.
    let first = true;
    effect(() => {
      this.workspace.legalEntityId();
      untracked(() => {
        if (!first) void this.list.reload();
        first = false;
      });
    });
  }

  protected async export(columns: Column<Employee>[]) {
    this.exporting.set(true);
    try {
      const n = await exportList(
        this.api,
        'hr/employees',
        withoutPaging(this.list.query()),
        columns,
        'colaboradores.csv',
      );
      this.toasts.show(`Exportados ${n} colaborador(es).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
