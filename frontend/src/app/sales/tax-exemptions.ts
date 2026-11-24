import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
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
import { FISCAL_STATUS, fiscalTone, type TaxExemption } from './fiscal-model';

/** Motivos de isenção (código e descrição como na fonte oficial), confirmados por outra pessoa. */
@Component({
  selector: 'app-tax-exemptions',
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
      title="Motivos de isenção"
      subtitle="Uma linha a 0 % só se emite com um motivo confirmado. Introduza o código e a descrição exactamente como na fonte oficial."
    />
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      @if (!opened() && action.error(); as err) {
        <app-error-alert class="mb-3 block" [error]="err" [showDetails]="true" />
      }
      @if (canManage()) {
        <div class="mb-3 flex justify-end">
          <button type="button" class="btn-primary" data-testid="ex-new" (click)="open(null)">
            <app-icon name="plus" [size]="16" />Novo motivo
          </button>
        </div>
      }
      <app-data-table
        label="Motivos de isenção"
        [columns]="columns"
        [rows]="rows()"
        [total]="rows().length"
        [limit]="1000"
        emptyText="Sem motivos de isenção."
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="ex-status">{{
            status(row.status)
          }}</span>
        </ng-template>
        <ng-template appCell="actions" let-row>
          @if (row.can.edit) {
            <button
              type="button"
              class="link"
              [attr.aria-label]="'Editar ' + row.code"
              (click)="open(row)"
            >
              Editar
            </button>
          }
          @if (row.can.confirm) {
            <button
              type="button"
              class="link ml-2"
              data-testid="ex-confirm"
              (click)="decide(row, 'confirm')"
            >
              Confirmar
            </button>
          }
          @if (row.can.retire) {
            <button type="button" class="link ml-2" (click)="decide(row, 'retire')">Retirar</button>
          }
        </ng-template>
      </app-data-table>
    }

    <app-modal
      [title]="form.id ? 'Editar motivo' : retiring ? 'Retirar motivo' : 'Novo motivo'"
      [open]="opened()"
      (closed)="opened.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        @if (retiring) {
          <app-field label="Motivo da retirada" [required]="true" [error]="action.field('reason')">
            <textarea
              appControl
              class="input min-h-16"
              name="reason"
              [(ngModel)]="reason"
            ></textarea>
          </app-field>
        } @else {
          @if (!form.id) {
            <app-field label="País" [required]="true" [error]="action.field('countryCode')">
              <input
                appControl
                class="input w-24 uppercase"
                name="country"
                maxlength="2"
                [(ngModel)]="form.countryCode"
              />
            </app-field>
            <app-field label="Código" [required]="true" [error]="action.field('code')">
              <input
                appControl
                class="input uppercase"
                name="code"
                data-testid="ex-code"
                [(ngModel)]="form.code"
              />
            </app-field>
          }
          <app-field label="Descrição" [required]="true" [error]="action.field('description')">
            <input
              appControl
              class="input"
              name="desc"
              data-testid="ex-desc"
              [(ngModel)]="form.description"
            />
          </app-field>
          <app-field label="Fonte legal" [required]="true" [error]="action.field('legalSource')">
            <input
              appControl
              class="input"
              name="source"
              data-testid="ex-source"
              [(ngModel)]="form.legalSource"
            />
          </app-field>
        }
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ex-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class TaxExemptions {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly rows = signal<TaxExemption[]>([]);
  protected readonly canManage = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly tone = fiscalTone;
  protected readonly status = (s: keyof typeof FISCAL_STATUS) => FISCAL_STATUS[s];
  protected retiring: TaxExemption | null = null;
  protected reason = '';
  protected form = this.blank();
  protected readonly columns: Column<TaxExemption>[] = [
    { key: 'code', label: 'Código', required: true },
    { key: 'countryCode', label: 'País' },
    { key: 'description', label: 'Descrição' },
    { key: 'legalSource', label: 'Fonte legal', hideOnMobile: true },
    {
      key: 'people',
      label: 'Preparado / confirmado',
      hideOnMobile: true,
      value: (x) => `${x.createdBy ?? '—'} / ${x.confirmedBy ?? '—'}`,
    },
    { key: 'status', label: 'Estado', value: (x) => FISCAL_STATUS[x.status] },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    void this.load();
  }

  private blank() {
    return { id: '', version: 0, countryCode: 'AO', code: '', description: '', legalSource: '' };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const r = await this.api.get<{ items: TaxExemption[]; can: { manage: boolean } }>(
        'sales/fiscal/exemptions',
      );
      this.rows.set(r.items);
      this.canManage.set(r.can.manage);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected open(x: TaxExemption | null) {
    this.action.error.set(null);
    this.retiring = null;
    this.form = x
      ? {
          id: x.id,
          version: x.version,
          countryCode: x.countryCode,
          code: x.code,
          description: x.description,
          legalSource: x.legalSource,
        }
      : this.blank();
    this.opened.set(true);
  }

  protected async decide(x: TaxExemption, action: 'confirm' | 'retire') {
    this.action.error.set(null);
    if (action === 'retire') {
      this.retiring = x;
      this.reason = '';
      this.form = this.blank();
      this.opened.set(true);
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Confirmar o motivo de isenção',
      message: `Confirma que ${x.code} — ${x.description} consta da fonte oficial (${x.legalSource})?`,
      confirmLabel: 'Confirmar',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.api.post(`sales/fiscal/exemptions/${x.id}/confirm`, { expectedVersion: x.version }),
    );
    if (r) this.toasts.show('Motivo confirmado.');
    await this.load();
  }

  protected async save() {
    const f = this.form;
    const x = this.retiring;
    const r = await this.action.run(() =>
      x
        ? this.api.post(`sales/fiscal/exemptions/${x.id}/retire`, {
            expectedVersion: x.version,
            reason: this.reason,
          })
        : f.id
          ? this.api.patch(`sales/fiscal/exemptions/${f.id}`, {
              expectedVersion: f.version,
              description: f.description,
              legalSource: f.legalSource,
            })
          : this.api.post('sales/fiscal/exemptions', {
              countryCode: f.countryCode,
              code: f.code,
              description: f.description,
              legalSource: f.legalSource,
            }),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show(
      x ? 'Motivo retirado.' : 'Motivo guardado: falta a confirmação de outra pessoa.',
    );
    await this.load();
  }
}
