import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  type DiscountLimit,
  LIST_TARGET,
  type ListTarget,
  percent,
  type PricingOptions,
  targetLabel,
} from './pricing-model';

/**
 * Limites do desconto manual sem aprovação: o do cliente, senão o do segmento, senão o geral (sem nenhum: 0 %). Só
 * quem aprova preços os define.
 */
@Component({
  selector: 'app-discount-limits',
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
    Autocomplete,
  ],
  template: `
    <app-page-header
      title="Limites de desconto"
      subtitle="Desconto manual máximo sem aprovação: do cliente, senão do segmento, senão geral; sem nenhum, qualquer desconto manual precisa de aprovação."
    />
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      @if (!opened() && action.error(); as err) {
        <app-error-alert class="mb-3 block" [error]="err" [showDetails]="true" />
      }
      @if (canEdit()) {
        <div class="mb-3 flex justify-end">
          <button type="button" class="btn-primary" data-testid="lm-new" (click)="openNew()">
            <app-icon name="plus" [size]="16" />Definir limite
          </button>
        </div>
      }
      <app-data-table
        label="Limites de desconto"
        [columns]="columns"
        [rows]="rows()"
        [total]="rows().length"
        [limit]="1000"
        emptyText="Sem limites: qualquer desconto manual precisa de aprovação."
      >
        <ng-template appCell="actions" let-row>
          @if (canEdit()) {
            <button
              type="button"
              class="link"
              [attr.aria-label]="'Alterar ' + target(row)"
              (click)="openEdit(row)"
            >
              Alterar
            </button>
            <button
              type="button"
              class="link ml-2"
              [attr.aria-label]="'Remover ' + target(row)"
              (click)="remove(row)"
            >
              Remover
            </button>
          }
        </ng-template>
      </app-data-table>
    }

    <app-modal title="Limite de desconto" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Para" [required]="true" [error]="action.field('targetType')">
          <select
            appControl
            class="input"
            name="target"
            data-testid="lm-target"
            [disabled]="editing"
            [(ngModel)]="form.targetType"
          >
            @for (t of targets; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        @if (form.targetType === 'SEGMENT') {
          <app-field label="Segmento" [required]="true" [error]="action.field('segmentId')">
            <select
              appControl
              class="input"
              name="segment"
              data-testid="lm-segment"
              [disabled]="editing"
              [(ngModel)]="form.segmentId"
            >
              <option value="">—</option>
              @for (s of opts()?.segments ?? []; track s.id) {
                <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
              }
            </select>
          </app-field>
        }
        @if (form.targetType === 'CUSTOMER') {
          <app-field #cf label="Cliente" [required]="true" [error]="action.field('customerId')">
            <app-autocomplete
              name="customer"
              [inputId]="cf.controlId"
              [describedBy]="cf.describedBy()"
              [search]="searchCustomers"
              [initialLabel]="form.customerLabel || null"
              [disabled]="editing"
              [(ngModel)]="form.customerId"
            />
          </app-field>
        }
        <app-field label="Desconto máximo (%)" [required]="true" [error]="action.field('maxPct')">
          <input
            appControl
            class="input w-28"
            inputmode="decimal"
            name="max"
            data-testid="lm-max"
            [(ngModel)]="form.maxPct"
          />
        </app-field>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="lm-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class DiscountLimits {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly rows = signal<DiscountLimit[]>([]);
  protected readonly canEdit = signal(false);
  protected readonly opts = signal<PricingOptions | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly targets = Object.entries(LIST_TARGET) as [ListTarget, string][];
  protected readonly target = targetLabel;
  protected editing = false;
  protected form = this.blank();
  protected readonly columns: Column<DiscountLimit>[] = [
    { key: 'target', label: 'Para', required: true, value: (l) => targetLabel(l) },
    { key: 'maxPct', label: 'Desconto máximo', align: 'end', value: (l) => percent(l.maxPct) },
    { key: 'actions', label: 'Acções', required: true },
  ];

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string }[]>(
        'sales/pricing/search/customers',
        { q },
      )
    ).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));

  constructor() {
    void this.load();
  }

  private blank() {
    return {
      targetType: 'GENERAL' as ListTarget,
      segmentId: '',
      customerId: '',
      customerLabel: '',
      maxPct: '',
    };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const r = await this.api.get<{ items: DiscountLimit[]; canEdit: boolean }>(
        'sales/discount-limits',
      );
      this.rows.set(r.items);
      this.canEdit.set(r.canEdit);
      if (r.canEdit && !this.opts())
        this.opts.set(await this.api.get<PricingOptions>('sales/pricing/options'));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected openNew() {
    this.action.error.set(null);
    this.editing = false;
    this.form = this.blank();
    this.opened.set(true);
  }
  protected openEdit(l: DiscountLimit) {
    this.action.error.set(null);
    this.editing = true;
    this.form = {
      targetType: l.targetType,
      segmentId: l.segment?.id ?? '',
      customerId: l.customer?.id ?? '',
      customerLabel: l.customer ? `${l.customer.code} — ${l.customer.name}` : '',
      maxPct: l.maxPct,
    };
    this.opened.set(true);
  }

  protected async save() {
    const f = this.form;
    const r = await this.action.run(() =>
      this.api.put<{ id: string }>('sales/discount-limits', {
        targetType: f.targetType,
        segmentId: f.targetType === 'SEGMENT' ? f.segmentId || null : null,
        customerId: f.targetType === 'CUSTOMER' ? f.customerId || null : null,
        maxPct: f.maxPct.trim(),
      }),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show('Limite guardado.');
    await this.load();
  }

  protected async remove(l: DiscountLimit) {
    const ok = await this.confirm.ask({
      title: 'Remover o limite',
      message: `Sem este limite vale o seguinte (${l.targetType === 'GENERAL' ? 'nenhum: 0 %' : 'segmento ou geral'}).`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    const done = await this.action.run(async () => {
      await this.api.delete(`sales/discount-limits/${l.id}`);
      return true;
    });
    if (!done) return;
    this.toasts.show('Limite removido.');
    await this.load();
  }
}
