import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  monthName,
  type PayrollRun,
  RUN_KIND,
  RUN_STATUS,
  type RunKind,
  type RunStatus,
  runTitle,
  runTone,
} from './payroll-model';

interface Entity {
  id: string;
  code: string;
  legalName: string;
}

/** Processamentos salariais (lotes) no âmbito do membro, com o diálogo para preparar um novo. */
@Component({
  selector: 'app-payroll-runs',
  imports: [
    FormsModule,
    RouterLink,
    EntityListPage,
    FilterBar,
    DataTable,
    CellDef,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    Icon,
  ],
  template: `
    <app-entity-list-page
      title="Processamento salarial"
      subtitle="Lotes por entidade legal e mês: calcular (simulação), aprovar por outra pessoa e fechar."
      permission="hr.payroll.read"
      feature="hr"
      [anyScope]="true"
    >
      @if (canManage()) {
        <button actions type="button" class="btn-primary" data-testid="new-run" (click)="open()">
          <app-icon name="plus" [size]="16" />Novo processamento
        </button>
      }
      @if (canSettings()) {
        <a actions class="btn-secondary" routerLink="/rh/processamento/regras">Regras</a>
      }
      <app-filter-bar
        id="ps"
        label="processamentos"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Processamentos salariais"
        tableId="hr-payroll"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters()
            ? 'Sem processamentos com estes filtros.'
            : 'Ainda não há processamentos.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ status(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>

    <app-modal title="Novo processamento" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            data-testid="run-entity"
            [(ngModel)]="form.legalEntityId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (e of entities(); track e.id) {
              <option [ngValue]="e.id">{{ e.code }} — {{ e.legalName }}</option>
            }
          </select>
        </app-field>
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
            <select
              appControl
              class="input"
              data-testid="run-kind"
              [(ngModel)]="form.kind"
              [ngModelOptions]="{ standalone: true }"
            >
              <option value="REGULAR">Regular (salários do mês)</option>
              <option value="EXTRA">Extra (pagamentos pontuais)</option>
              <option value="RETRO">Retroactivo (rectifica um mês fechado)</option>
            </select>
          </app-field>
          <app-field label="Mês" [required]="true" [error]="action.field('period')">
            <input
              appControl
              class="input"
              type="month"
              data-testid="run-period"
              [(ngModel)]="form.period"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        </div>
        @if (form.kind === 'RETRO') {
          <app-field
            label="Mês a rectificar"
            [required]="true"
            hint="Um mês anterior já fechado; as diferenças pagam-se no mês acima."
            [error]="action.field('targetPeriod')"
          >
            <input
              appControl
              class="input"
              type="month"
              data-testid="run-target"
              [(ngModel)]="form.targetPeriod"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        <app-field label="Descrição" [error]="action.field('description')">
          <input
            appControl
            class="input"
            data-testid="run-description"
            [(ngModel)]="form.description"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="run-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Criar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class PayrollRuns {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly entities = signal<Entity[]>([]);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly canManage = computed(() => this.workspace.canAny('hr.payroll.manage'));
  protected readonly canSettings = computed(() => this.workspace.can('hr.payroll.settings'));
  protected form = {
    legalEntityId: null as string | null,
    kind: 'REGULAR' as RunKind,
    period: '',
    targetPeriod: '',
    description: '',
  };
  protected readonly tone = runTone;
  protected readonly status = (s: RunStatus) => RUN_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(RUN_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'kind',
      label: 'Tipo',
      options: Object.entries(RUN_KIND).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<PayrollRun>[] = [
    { key: 'code', label: 'Código', required: true, link: (r) => ['/rh/processamento', r.id] },
    { key: 'title', label: 'Processamento', value: (r) => runTitle(r) },
    {
      key: 'entity',
      label: 'Entidade legal',
      hideOnMobile: true,
      value: (r) => r.legalEntity.code,
    },
    {
      key: 'employees',
      label: 'Colaboradores',
      align: 'end',
      hideOnMobile: true,
      value: (r) => r.employeesCount,
    },
    {
      key: 'net',
      label: 'Líquido',
      align: 'end',
      value: (r) => (r.employeesCount ? formatMoney(r.totals.net) : '—'),
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<PayrollRun>(this.api, {
    url: 'hr/payroll/runs',
    filterKeys: ['status', 'kind'],
    sortFields: [],
    limit: 25,
  });
  protected readonly month = monthName;

  protected async open() {
    this.action.error.set(null);
    try {
      const page = await this.api.page<Entity>('organization/legal-entities', { limit: 200 });
      this.entities.set(page.items);
    } catch {
      this.entities.set([]);
    }
    this.form = {
      legalEntityId: this.entities().length === 1 ? this.entities()[0].id : null,
      kind: 'REGULAR',
      period: new Date().toISOString().slice(0, 7),
      targetPeriod: '',
      description: '',
    };
    this.opened.set(true);
  }

  protected async save() {
    const result = await this.action.run(() =>
      this.api.post<PayrollRun>('hr/payroll/runs', {
        legalEntityId: this.form.legalEntityId,
        kind: this.form.kind,
        period: this.form.period || null,
        ...(this.form.kind === 'RETRO' ? { targetPeriod: this.form.targetPeriod || null } : {}),
        description: this.form.description.trim() || undefined,
      }),
    );
    if (!result) return;
    this.opened.set(false);
    this.toasts.show('Processamento criado.');
    await this.router.navigate(['/rh/processamento', result.id]);
  }
}
