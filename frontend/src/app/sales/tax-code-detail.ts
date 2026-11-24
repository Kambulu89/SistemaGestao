import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import {
  FISCAL_STATUS,
  fiscalTone,
  ratePct,
  TAX_KIND,
  TAX_TYPE,
  type TaxCode,
  type TaxRate,
} from './fiscal-model';

type Dialog = 'rate' | 'retire' | null;

/**
 * Imposto ou retenção: as taxas por vigência (do país ou de uma entidade), cada uma com a fonte legal; preparada por
 * uma pessoa e confirmada por outra, depois de verificada na fonte oficial. Confirmada não muda: retira-se com motivo.
 */
@Component({
  selector: 'app-tax-code-detail',
  imports: [
    FormsModule,
    EntityFormPage,
    DataTable,
    CellDef,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? x()!.code + ' — ' + x()!.name : 'Imposto'"
      [subtitle]="
        x() ? kind(x()!.kind) + ' · ' + type(x()!.taxType) + ' · ' + x()!.countryCode : ''
      "
      formId="tax-code-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as c) {
        <section class="card" aria-labelledby="tx-r-title">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="tx-r-title" class="font-semibold">Taxas</h2>
            @if (c.can.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="tx-rate-new"
                (click)="openRate(null)"
              >
                Nova taxa
              </button>
            }
          </div>
          <p class="mb-2 text-xs text-muted">
            Só as taxas confirmadas e em vigor entram nos cálculos. A de uma entidade prevalece
            sobre a do país.
            @if (c.kind === 'WITHHOLDING') {
              A retenção aplica-se à base do documento a partir da base mínima.
            }
          </p>
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <app-data-table
            label="Taxas do imposto"
            [columns]="columns"
            [rows]="c.rates"
            [total]="c.rates.length"
            [limit]="1000"
            emptyText="Sem taxas: acrescente a primeira a partir da fonte oficial."
          >
            <ng-template appCell="status" let-row>
              <span class="badge" [class]="tone(row.status)" data-testid="tx-status">{{
                status(row.status)
              }}</span>
            </ng-template>
            <ng-template appCell="actions" let-row>
              @if (row.can.edit) {
                <button
                  type="button"
                  class="link"
                  [attr.aria-label]="'Editar a taxa de ' + row.validFrom"
                  (click)="openRate(row)"
                >
                  Editar
                </button>
                <button
                  type="button"
                  class="link ml-2"
                  [attr.aria-label]="'Apagar a taxa de ' + row.validFrom"
                  (click)="remove(row)"
                >
                  Apagar
                </button>
              }
              @if (row.can.confirm) {
                <button
                  type="button"
                  class="link ml-2"
                  data-testid="tx-confirm"
                  (click)="confirmRate(row)"
                >
                  Confirmar
                </button>
              }
              @if (row.can.retire) {
                <button type="button" class="link ml-2" (click)="openRetire(row)">Retirar</button>
              }
            </ng-template>
          </app-data-table>
        </section>

        <app-audit-history
          entityType="tax_code"
          [entityId]="c.id"
          [refreshKey]="c.version + c.rates.length"
        />
      }
    </app-entity-form-page>

    <app-modal
      [title]="dialog() === 'retire' ? 'Retirar a taxa' : rateForm.id ? 'Editar taxa' : 'Nova taxa'"
      [open]="dialog() !== null"
      (closed)="dialog.set(null)"
    >
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @if (dialog() === 'rate') {
        <div class="space-y-3">
          <app-field label="Taxa (%)" [required]="true" [error]="act.field('rate')">
            <input
              appControl
              class="input w-32"
              inputmode="decimal"
              name="rate"
              data-testid="tx-rate"
              [(ngModel)]="rateForm.rate"
            />
          </app-field>
          <app-field label="De" [required]="true" [error]="act.field('validFrom')">
            <input
              appControl
              class="input"
              type="date"
              name="from"
              data-testid="tx-from"
              [(ngModel)]="rateForm.validFrom"
            />
          </app-field>
          <app-field label="Até" hint="Vazio: sem fim." [error]="act.field('validTo')">
            <input appControl class="input" type="date" name="to" [(ngModel)]="rateForm.validTo" />
          </app-field>
          @if (!rateForm.id) {
            <app-field
              label="Só para a entidade"
              hint="Vazio: todas as entidades do país."
              [error]="act.field('legalEntityId')"
            >
              <select appControl class="input" name="le" [(ngModel)]="rateForm.legalEntityId">
                <option value="">Todas</option>
                @for (e of entities(); track e.legalEntityId) {
                  <option [value]="e.legalEntityId">{{ e.code }}</option>
                }
              </select>
            </app-field>
          }
          @if (x()?.kind === 'WITHHOLDING') {
            <app-field
              label="Base mínima"
              hint="Vazio: qualquer valor."
              [error]="act.field('minBase')"
            >
              <input
                appControl
                class="input w-40"
                inputmode="decimal"
                name="min"
                [(ngModel)]="rateForm.minBase"
              />
            </app-field>
          }
          <app-field
            label="Fonte legal"
            [required]="true"
            hint="Diploma, artigo e data de publicação."
            [error]="act.field('legalSource')"
          >
            <input
              appControl
              class="input"
              name="source"
              data-testid="tx-source"
              [(ngModel)]="rateForm.legalSource"
            />
          </app-field>
          <app-field label="Notas" [error]="act.field('notes')">
            <input appControl class="input" name="notes" [(ngModel)]="rateForm.notes" />
          </app-field>
        </div>
      } @else {
        <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
          <textarea appControl class="input min-h-16" name="reason" [(ngModel)]="reason"></textarea>
        </app-field>
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tx-ok"
          [disabled]="act.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class TaxCodeDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<TaxCode | null>(null);
  protected readonly entities = signal<{ legalEntityId: string; code: string }[]>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly act = new Action();
  protected readonly tone = fiscalTone;
  protected readonly status = (s: keyof typeof FISCAL_STATUS) => FISCAL_STATUS[s];
  protected readonly kind = (k: string) => TAX_KIND[k] ?? k;
  protected readonly type = (k: string) => TAX_TYPE[k] ?? k;
  protected reason = '';
  protected target: TaxRate | null = null;
  protected rateForm = this.blank();
  protected readonly columns: Column<TaxRate>[] = [
    { key: 'rate', label: 'Taxa', required: true, value: (r) => ratePct(r.rate) },
    {
      key: 'period',
      label: 'Vigência',
      value: (r) => (r.validTo ? `${r.validFrom} a ${r.validTo}` : `desde ${r.validFrom}`),
    },
    {
      key: 'scope',
      label: 'Âmbito',
      hideOnMobile: true,
      value: (r) => r.legalEntity?.code ?? 'País',
    },
    {
      key: 'minBase',
      label: 'Base mínima',
      align: 'end',
      hiddenByDefault: true,
      value: (r) => (r.minBase ? money(r.minBase) : '—'),
    },
    { key: 'legalSource', label: 'Fonte legal' },
    {
      key: 'people',
      label: 'Preparada / confirmada',
      hideOnMobile: true,
      value: (r) =>
        `${r.createdBy ?? '—'} / ${r.confirmedBy ? r.confirmedBy + ' · ' + formatDateTime(r.confirmedAt) : '—'}`,
    },
    { key: 'status', label: 'Estado', value: (r) => FISCAL_STATUS[r.status] },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private blank() {
    return {
      id: '',
      version: 0,
      rate: '',
      validFrom: '',
      validTo: '',
      legalEntityId: '',
      minBase: '',
      legalSource: '',
      notes: '',
    };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [c, s] = await Promise.all([
        this.api.get<TaxCode>(`sales/fiscal/tax-codes/${this.id()}`),
        this.api.get<{ items: { legalEntityId: string; code: string; countryCode: string }[] }>(
          'sales/fiscal/settings',
        ),
      ]);
      this.set(c);
      this.entities.set(s.items.filter((e) => e.countryCode === c.countryCode));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(c: TaxCode) {
    this.x.set(c);
    this.breadcrumbs.setCurrent(c.code);
  }
  protected back() {
    void this.router.navigate(['/vendas/fiscal/impostos']);
  }

  protected openRate(r: TaxRate | null) {
    this.act.error.set(null);
    this.rateForm = r
      ? {
          id: r.id,
          version: r.version,
          rate: r.rate,
          validFrom: r.validFrom,
          validTo: r.validTo ?? '',
          legalEntityId: r.legalEntity?.id ?? '',
          minBase: r.minBase ?? '',
          legalSource: r.legalSource,
          notes: r.notes ?? '',
        }
      : this.blank();
    this.dialog.set('rate');
  }
  protected openRetire(r: TaxRate) {
    this.act.error.set(null);
    this.target = r;
    this.reason = '';
    this.dialog.set('retire');
  }

  private async run(req: () => Promise<TaxCode>, done: string) {
    const r = await this.act.run(req);
    if (!r) return;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show(done);
  }

  protected async save() {
    const nz = (v: string) => (v.trim() === '' ? null : v.trim().replace(',', '.'));
    if (this.dialog() === 'retire') {
      const t = this.target!;
      return this.run(
        () =>
          this.api.post<TaxCode>(`sales/fiscal/tax-rates/${t.id}/retire`, {
            expectedVersion: t.version,
            reason: this.reason,
          }),
        'Taxa retirada.',
      );
    }
    const f = this.rateForm;
    const body = {
      rate: f.rate.trim().replace(',', '.'),
      validFrom: f.validFrom,
      validTo: nz(f.validTo),
      minBase: nz(f.minBase),
      legalSource: f.legalSource,
      notes: nz(f.notes),
    };
    return this.run(
      () =>
        f.id
          ? this.api.patch<TaxCode>(`sales/fiscal/tax-rates/${f.id}`, {
              ...body,
              expectedVersion: f.version,
            })
          : this.api.post<TaxCode>(`sales/fiscal/tax-codes/${this.x()!.id}/rates`, {
              ...body,
              legalEntityId: nz(f.legalEntityId),
            }),
      'Taxa guardada: falta a confirmação de outra pessoa.',
    );
  }

  protected async confirmRate(r: TaxRate) {
    const ok = await this.confirm.ask({
      title: 'Confirmar a taxa',
      message: `Confirma que verificou ${ratePct(r.rate)} desde ${r.validFrom} na fonte oficial (${r.legalSource})? Depois de confirmada não muda.`,
      confirmLabel: 'Confirmar',
    });
    if (!ok) return;
    await this.run(
      () =>
        this.api.post<TaxCode>(`sales/fiscal/tax-rates/${r.id}/confirm`, {
          expectedVersion: r.version,
        }),
      'Taxa confirmada.',
    );
  }

  protected async remove(r: TaxRate) {
    const ok = await this.confirm.ask({
      title: 'Apagar a taxa',
      message: `Apagar o rascunho de ${ratePct(r.rate)} desde ${r.validFrom}?`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!ok) return;
    await this.run(
      () =>
        this.api
          .delete(`sales/fiscal/tax-rates/${r.id}`)
          .then(() => this.api.get<TaxCode>(`sales/fiscal/tax-codes/${this.x()!.id}`)),
      'Taxa apagada.',
    );
  }
}
