import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { plain } from './rfq-model';
import {
  type Budget,
  BUDGET_CONTROL,
  type BudgetControl,
  type BudgetMovements,
  COMMITMENT_SOURCE,
  usedPercent,
} from './finance-model';

/**
 * Verba de compras por centro de custo e ano: comprometido (requisições aprovadas por encomendar e ordens emitidas
 * por facturar — a mesma verba nunca conta duas vezes), realizado (facturas − notas de crédito) e disponível. Com
 * bloqueio, a aprovação da requisição ou a emissão da ordem que passe a verba é recusada.
 */
@Component({
  selector: 'app-budgets',
  imports: [
    FormsModule,
    PageHeader,
    DataTable,
    CellDef,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Icon,
  ],
  template: `
    <app-page-header
      title="Orçamento de compras"
      subtitle="Verba por centro de custo e ano: comprometido em aberto, realizado e disponível, em moeda funcional (líquido de imposto)."
    />
    <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
      <label class="block w-36">
        <span class="label">Ano</span>
        <select
          class="input"
          name="year"
          data-testid="bg-year"
          [ngModel]="year()"
          (ngModelChange)="year.set(+$event); load()"
        >
          @for (y of years; track y) {
            <option [value]="y">{{ y }}</option>
          }
        </select>
      </label>
      @if (canManage()) {
        <button type="button" class="btn-primary" data-testid="bg-new" (click)="open(null)">
          <app-icon name="plus" [size]="16" />Nova verba
        </button>
      }
    </div>
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      <app-data-table
        label="Verbas de compras"
        tableId="proc-budgets"
        [columns]="columns"
        [rows]="rows()"
        [total]="rows().length"
        [limit]="1000"
        [loading]="loading()"
        emptyText="Sem verbas neste ano. Sem verba, o compromisso é registado mas nada é bloqueado."
      >
        <ng-template appCell="available" let-row>
          <span
            class="tabular-nums"
            [class.text-danger-text]="row.over"
            [attr.data-testid]="'bg-available-' + row.costCenter.code"
            >{{ m(row.available) }}</span
          >
          <div
            class="mt-1 h-1.5 w-24 rounded-full bg-surface-2"
            role="progressbar"
            [attr.aria-label]="'Usado da verba de ' + row.costCenter.code"
            [attr.aria-valuenow]="pct(row)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-1.5 rounded-full"
              [class.bg-primary]="!row.over"
              [class.bg-danger]="row.over"
              [style.width.%]="pct(row)"
            ></div>
          </div>
        </ng-template>
        <ng-template appCell="actions" let-row>
          <span class="flex gap-3">
            <button
              type="button"
              class="link"
              [attr.aria-label]="'Documentos de ' + row.costCenter.code"
              (click)="details(row)"
            >
              Documentos
            </button>
            @if (row.canManage) {
              <button
                type="button"
                class="link"
                [attr.aria-label]="'Editar verba de ' + row.costCenter.code"
                (click)="open(row)"
              >
                Editar
              </button>
            }
          </span>
        </ng-template>
      </app-data-table>
    }

    <app-modal
      [title]="form.id ? 'Editar verba' : 'Nova verba'"
      [open]="opened()"
      (closed)="opened.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Centro de custo" [required]="true" [error]="action.field('costCenterId')">
          <select
            appControl
            class="input"
            name="cc"
            data-testid="bg-cc"
            [disabled]="!!form.id"
            [(ngModel)]="form.costCenterId"
          >
            <option value="">Escolher…</option>
            @for (c of costCenters(); track c.id) {
              <option [value]="c.id">{{ c.legalEntity }} · {{ c.code }} — {{ c.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Ano" [required]="true" [error]="action.field('fiscalYear')">
          <input
            appControl
            class="input w-28"
            type="number"
            name="fy"
            data-testid="bg-fy"
            [disabled]="!!form.id"
            [(ngModel)]="form.fiscalYear"
          />
        </app-field>
        <app-field
          label="Verba (moeda funcional)"
          [required]="true"
          [error]="action.field('amount')"
        >
          <input
            appControl
            class="input w-48"
            inputmode="decimal"
            name="amount"
            data-testid="bg-amount"
            [(ngModel)]="form.amount"
          />
        </app-field>
        <app-field label="Excesso" [error]="action.field('control')">
          <select
            appControl
            class="input"
            name="control"
            data-testid="bg-control"
            [(ngModel)]="form.control"
          >
            @for (c of controls; track c[0]) {
              <option [value]="c[0]">{{ c[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Notas" [error]="action.field('notes')">
          <input appControl class="input" name="notes" [(ngModel)]="form.notes" />
        </app-field>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="bg-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </div>
    </app-modal>

    <app-modal
      [title]="'Documentos de ' + (movements()?.budget?.costCenter?.code ?? '')"
      [open]="movements() !== null"
      (closed)="movements.set(null)"
    >
      @if (movements(); as mv) {
        <ul class="space-y-1 text-sm" data-testid="bg-documents">
          @for (d of mv.documents; track d.sourceId + d.kind) {
            <li class="flex justify-between gap-3">
              <span
                >{{ d.kind === 'ACTUAL' ? 'Realizado' : 'Comprometido' }} ·
                {{ source(d.sourceType) }} {{ d.sourceRef ?? '' }}</span
              >
              <span class="tabular-nums">{{ m(d.amount) }}</span>
            </li>
          } @empty {
            <li class="text-muted">Sem documentos.</li>
          }
        </ul>
      }
    </app-modal>
  `,
})
export class Budgets {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly rows = signal<Budget[]>([]);
  protected readonly costCenters = signal<
    { id: string; code: string; name: string; legalEntity: string }[]
  >([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly movements = signal<BudgetMovements | null>(null);
  protected readonly action = new Action();
  protected readonly canManage = computed(() =>
    this.workspace.canAny('procurement.budgets.manage'),
  );
  private readonly thisYear = new Date().getFullYear();
  protected readonly years = [
    this.thisYear + 1,
    this.thisYear,
    this.thisYear - 1,
    this.thisYear - 2,
  ];
  protected readonly year = signal(this.thisYear);
  protected readonly controls = Object.entries(BUDGET_CONTROL) as [BudgetControl, string][];
  protected readonly m = (v: string) => money(v, null);
  protected readonly pct = usedPercent;
  protected readonly source = (k: BudgetMovements['documents'][number]['sourceType']) =>
    COMMITMENT_SOURCE[k];
  protected form = this.blank();
  protected readonly columns: Column<Budget>[] = [
    {
      key: 'costCenter',
      label: 'Centro de custo',
      required: true,
      value: (b) => `${b.costCenter.code} — ${b.costCenter.name}`,
    },
    { key: 'legalEntity', label: 'Entidade', hideOnMobile: true, value: (b) => b.legalEntity.code },
    { key: 'amount', label: 'Verba', align: 'end', value: (b) => this.m(b.amount) },
    {
      key: 'committedRequisitions',
      label: 'Requisições',
      align: 'end',
      hideOnMobile: true,
      value: (b) => this.m(b.committedRequisitions),
    },
    {
      key: 'committedOrders',
      label: 'Ordens',
      align: 'end',
      hideOnMobile: true,
      value: (b) => this.m(b.committedOrders),
    },
    {
      key: 'actual',
      label: 'Realizado',
      align: 'end',
      hideOnMobile: true,
      value: (b) => this.m(b.actual),
    },
    { key: 'available', label: 'Disponível', align: 'end', value: (b) => this.m(b.available) },
    {
      key: 'control',
      label: 'Excesso',
      hiddenByDefault: true,
      value: (b) => BUDGET_CONTROL[b.control as BudgetControl] ?? b.control,
    },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    void this.load();
    if (this.canManage())
      this.api
        .get<{ costCenters: { id: string; code: string; name: string; legalEntity: string }[] }>(
          'procurement/budgets/options',
        )
        .then(
          (o) => this.costCenters.set(o.costCenters),
          () => undefined,
        );
  }

  private blank() {
    return {
      id: '',
      version: 0,
      costCenterId: '',
      fiscalYear: this.year(),
      amount: '',
      control: 'BLOCK' as BudgetControl,
      notes: '',
    };
  }

  protected async load() {
    this.loadError.set(null);
    this.loading.set(true);
    try {
      this.rows.set(
        await this.api.get<Budget[]>('procurement/budgets', { fiscalYear: this.year() }),
      );
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected open(b: Budget | null) {
    this.action.error.set(null);
    this.form = b
      ? {
          id: b.id,
          version: b.version,
          costCenterId: b.costCenter.id,
          fiscalYear: b.fiscalYear,
          amount: plain(b.amount),
          control: b.control,
          notes: b.notes ?? '',
        }
      : this.blank();
    this.opened.set(true);
  }

  protected async details(b: Budget) {
    try {
      this.movements.set(await this.api.get<BudgetMovements>(`procurement/budgets/${b.id}`));
    } catch (e) {
      this.toasts.show(ApiError.from(e).message, 'error');
    }
  }

  protected async save() {
    const body = {
      amount: String(this.form.amount).trim().replace(',', '.'),
      control: this.form.control,
      notes: this.form.notes.trim() || null,
    };
    const r = await this.action.run(() =>
      this.form.id
        ? this.api.put<Budget>(`procurement/budgets/${this.form.id}`, {
            ...body,
            expectedVersion: this.form.version,
          })
        : this.api.post<Budget>('procurement/budgets', {
            ...body,
            costCenterId: this.form.costCenterId,
            fiscalYear: Number(this.form.fiscalYear),
          }),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show('Verba guardada.');
    if (r.fiscalYear !== this.year()) this.year.set(r.fiscalYear);
    await this.load();
  }
}
