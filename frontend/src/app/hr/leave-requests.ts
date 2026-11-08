import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  daysLabel,
  LEAVE_STATUS,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveSummary,
  leaveTone,
} from './leave-model';
import { LeaveRequestDialog } from './leave-request-dialog';

/**
 * Ausências: os pedidos que o membro pode ver (os seus, os da equipa que chefia e os do seu âmbito de RH), com vistas
 * "a aprovar" e "os meus"; pedir ausência; gerar o direito anual de férias (quem gere).
 */
@Component({
  selector: 'app-leave-requests',
  imports: [
    FormsModule,
    EntityListPage,
    FilterBar,
    DataTable,
    CellDef,
    Icon,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    LeaveRequestDialog,
  ],
  template: `
    <app-entity-list-page
      title="Férias e ausências"
      [subtitle]="
        mine()
          ? 'Saldo de ' +
            mine()!.balance.year +
            ': ' +
            days(mine()!.balance.available) +
            ' dia(s) disponíveis.'
          : 'Pedidos de férias e ausências no seu âmbito e da sua equipa.'
      "
      feature="hr"
    >
      <ng-container actions>
        @if (canManage()) {
          <button
            type="button"
            class="btn-secondary"
            data-testid="open-accrual"
            (click)="openAccrual()"
          >
            Gerar direitos do ano
          </button>
        }
        @if (canRequest()) {
          <button type="button" class="btn-primary" data-testid="new-leave" (click)="openRequest()">
            <app-icon name="plus" [size]="16" />Pedir ausência
          </button>
        }
      </ng-container>
      <app-filter-bar
        id="lv"
        label="ausências"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Pedidos de ausência"
        tableId="hr-leave"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters()
            ? 'Sem pedidos com estes filtros.'
            : 'Ainda não há pedidos de ausência.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ status(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>

    <app-leave-request-dialog
      [open]="requesting()"
      [employeeId]="canManage() ? null : (mine()?.employee?.id ?? null)"
      (closed)="requesting.set(false)"
      (created)="created($event)"
    />

    <app-modal
      title="Gerar direitos de férias"
      [open]="accrualOpen()"
      (closed)="accrualOpen.set(false)"
    >
      <app-error-alert [error]="accrual.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Calcula o direito do ano pela política em vigor para os colaboradores que gere e transporta
        o saldo do ano anterior. Pode repetir: só regista diferenças.
      </p>
      <app-field label="Ano" [required]="true" [error]="accrual.field('year')">
        <input
          appControl
          class="input"
          type="number"
          data-testid="accrual-year"
          [(ngModel)]="year"
          [ngModelOptions]="{ standalone: true }"
        />
      </app-field>
      @if (accrualResult(); as r) {
        <p class="mt-3 text-sm" role="status" data-testid="accrual-result">
          Criados {{ r.created }}, recalculados {{ r.adjusted }}, sem alteração {{ r.unchanged }}.
          @if (r.skipped.length) {
            Sem política: {{ skippedCodes(r) }}.
          }
        </p>
      }
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="accrualOpen.set(false)">Fechar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="accrual-confirm"
          [disabled]="accrual.busy()"
          (click)="runAccrual()"
        >
          Gerar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LeaveRequests {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  private readonly dialog = viewChild.required(LeaveRequestDialog);
  protected readonly mine = signal<LeaveSummary | null>(null);
  protected readonly canManage = computed(() => this.workspace.canAny('hr.leave.manage'));
  protected readonly canRequest = computed(() => this.canManage() || !!this.mine()?.access.request);
  protected readonly requesting = signal(false);
  protected readonly accrualOpen = signal(false);
  protected readonly accrual = new Action();
  protected readonly accrualResult = signal<{
    created: number;
    adjusted: number;
    unchanged: number;
    skipped: { code: string }[];
  } | null>(null);
  protected year = new Date().getFullYear();
  protected readonly days = daysLabel;
  protected readonly tone = leaveTone;
  protected readonly status = (s: LeaveStatus) => LEAVE_STATUS[s] ?? s;
  protected readonly skippedCodes = (r: { skipped: { code: string }[] }) =>
    r.skipped.map((s) => s.code).join(', ');
  protected readonly filters: FilterDef[] = [
    {
      key: 'view',
      label: 'Vista',
      options: [
        { value: 'toApprove', label: 'A aprovar por mim' },
        { value: 'mine', label: 'Os meus pedidos' },
      ],
    },
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(LEAVE_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<LeaveRequest>[] = [
    {
      key: 'employee',
      label: 'Colaborador',
      required: true,
      value: (r) => r.employee.fullName,
      link: (r) => ['/rh/ausencias', r.id],
    },
    { key: 'leaveType', label: 'Tipo', value: (r) => r.leaveType.name },
    { key: 'startDate', label: 'Início', value: (r) => formatDate(r.startDate) },
    { key: 'endDate', label: 'Fim', hideOnMobile: true, value: (r) => formatDate(r.endDate) },
    { key: 'days', label: 'Dias', align: 'end', value: (r) => daysLabel(r.days) },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<LeaveRequest>(this.api, {
    url: 'hr/leave/requests',
    filterKeys: ['view', 'status'],
    sortFields: [],
    limit: 25,
    transform: (q) => {
      const { view, ...rest } = q as Record<string, unknown>;
      return {
        ...rest,
        ...(view === 'mine' ? { mine: true } : view === 'toApprove' ? { toApprove: true } : {}),
      } as never;
    },
  });

  constructor() {
    void this.loadMine();
  }

  private async loadMine() {
    try {
      this.mine.set(await this.api.get<LeaveSummary>('hr/leave/me'));
    } catch {
      this.mine.set(null);
    }
  }

  protected async openRequest() {
    await this.dialog().prepare();
    this.requesting.set(true);
  }

  protected async created(r: LeaveRequest) {
    this.requesting.set(false);
    await this.router.navigate(['/rh/ausencias', r.id]);
  }

  protected openAccrual() {
    this.accrual.error.set(null);
    this.accrualResult.set(null);
    this.accrualOpen.set(true);
  }

  protected async runAccrual() {
    const result = await this.accrual.run(() =>
      this.api.post<{
        created: number;
        adjusted: number;
        unchanged: number;
        skipped: { code: string }[];
      }>('hr/leave/accruals', { year: Number(this.year) }),
    );
    if (!result) return;
    this.accrualResult.set(result);
    this.toasts.show('Direitos de férias gerados.');
    void this.loadMine();
  }
}
