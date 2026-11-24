import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  DOCUMENT_KIND,
  type FiscalSeries,
  fiscalTone,
  SERIES_STATUS,
  SIMULATION_NOTICE,
} from './fiscal-model';

type Dialog = 'edit' | 'close' | 'numbers' | null;

/**
 * Séries fiscais por entidade, tipo de documento e ano, várias em simultâneo. Numeração sem saltos e cronológica,
 * atribuída na emissão; a configuração fixa-se ao activar. Só em modo de simulação.
 */
@Component({
  selector: 'app-fiscal-series',
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
      title="Séries fiscais"
      subtitle="Numeração dos documentos fiscais por entidade, tipo e ano."
    />
    <p
      class="mb-3 rounded-card border border-warning bg-warning-soft p-3 text-sm text-warning-text"
      role="note"
      data-testid="fs-simulation"
    >
      {{ notice }}
    </p>
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      @if (dialog() === null && action.error(); as err) {
        <app-error-alert class="mb-3 block" [error]="err" [showDetails]="true" />
      }
      @if (canManage()) {
        <div class="mb-3 flex justify-end">
          <button type="button" class="btn-primary" data-testid="fs-new" (click)="openEdit(null)">
            <app-icon name="plus" [size]="16" />Nova série
          </button>
        </div>
      }
      <app-data-table
        label="Séries fiscais"
        [columns]="columns"
        [rows]="rows()"
        [total]="rows().length"
        [limit]="1000"
        emptyText="Ainda não há séries fiscais."
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="fs-status">{{
            status(row.status)
          }}</span>
          <span class="badge ml-1 bg-warning-soft text-warning-text">Simulação</span>
        </ng-template>
        <ng-template appCell="actions" let-row>
          @if (row.can.edit) {
            <button
              type="button"
              class="link"
              [attr.aria-label]="'Editar ' + row.code"
              (click)="openEdit(row)"
            >
              Editar
            </button>
          }
          @if (row.can.activate) {
            <button
              type="button"
              class="link ml-2"
              data-testid="fs-activate"
              (click)="activate(row)"
            >
              Activar
            </button>
          }
          @if (row.can.close) {
            <button type="button" class="link ml-2" (click)="openClose(row)">Fechar</button>
          }
          <button
            type="button"
            class="link ml-2"
            [attr.aria-label]="'Números de ' + row.code"
            (click)="openNumbers(row)"
          >
            Números
          </button>
        </ng-template>
      </app-data-table>
    }

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      @switch (dialog()) {
        @case ('edit') {
          <div class="space-y-3">
            @if (!form.id || form.draft) {
              @if (!form.id) {
                <app-field
                  label="Entidade legal"
                  [required]="true"
                  [error]="action.field('legalEntityId')"
                >
                  <select
                    appControl
                    class="input"
                    name="le"
                    data-testid="fs-le"
                    [(ngModel)]="form.legalEntityId"
                  >
                    <option value="">—</option>
                    @for (e of entities(); track e.legalEntityId) {
                      <option [value]="e.legalEntityId">{{ e.code }}</option>
                    }
                  </select>
                </app-field>
              }
              <app-field
                label="Tipo de documento"
                [required]="true"
                [error]="action.field('documentKind')"
              >
                <select
                  appControl
                  class="input"
                  name="kind"
                  data-testid="fs-kind"
                  [(ngModel)]="form.documentKind"
                >
                  @for (k of kinds; track k[0]) {
                    <option [value]="k[0]">{{ k[1] }}</option>
                  }
                </select>
              </app-field>
              <app-field
                label="Código do tipo"
                [required]="true"
                hint="Como na fonte oficial."
                [error]="action.field('fiscalCode')"
              >
                <input
                  appControl
                  class="input w-28 uppercase"
                  name="fcode"
                  data-testid="fs-fcode"
                  [(ngModel)]="form.fiscalCode"
                />
              </app-field>
              <app-field label="Código da série" [required]="true" [error]="action.field('code')">
                <input
                  appControl
                  class="input uppercase"
                  name="code"
                  data-testid="fs-code"
                  [(ngModel)]="form.code"
                />
              </app-field>
              <app-field label="Ano fiscal" [required]="true" [error]="action.field('fiscalYear')">
                <input
                  appControl
                  class="input w-28"
                  type="number"
                  name="year"
                  data-testid="fs-year"
                  [(ngModel)]="form.fiscalYear"
                />
              </app-field>
              <app-field label="Prefixo" [required]="true" [error]="action.field('prefix')">
                <input
                  appControl
                  class="input"
                  name="prefix"
                  data-testid="fs-prefix"
                  [(ngModel)]="form.prefix"
                />
              </app-field>
              <app-field
                label="Dígitos"
                hint="Zeros à esquerda (0 a 10)."
                [error]="action.field('padding')"
              >
                <input
                  appControl
                  class="input w-24"
                  type="number"
                  min="0"
                  max="10"
                  name="padding"
                  [(ngModel)]="form.padding"
                />
              </app-field>
            }
            <app-field
              label="Referência da comunicação à autoridade"
              hint="Registo manual; não é verificada nem enviada."
              [error]="action.field('authorityReference')"
            >
              <input appControl class="input" name="ref" [(ngModel)]="form.authorityReference" />
            </app-field>
          </div>
        }
        @case ('close') {
          <app-field label="Motivo" [required]="true" [error]="action.field('reason')">
            <textarea
              appControl
              class="input min-h-16"
              name="reason"
              [(ngModel)]="reason"
            ></textarea>
          </app-field>
        }
        @case ('numbers') {
          <ul class="max-h-80 space-y-1 overflow-auto text-sm" data-testid="fs-numbers">
            @for (n of numbers(); track n.number) {
              <li>
                <strong>{{ n.formatted }}</strong> · {{ n.issueDate }} · {{ n.documentType }} ·
                {{ when(n.at) }}
              </li>
            } @empty {
              <li class="text-muted">Ainda sem números atribuídos.</li>
            }
          </ul>
        }
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">
          {{ dialog() === 'numbers' ? 'Fechar' : 'Cancelar' }}
        </button>
        @if (dialog() !== 'numbers') {
          <button
            type="button"
            class="btn-primary"
            data-testid="fs-save"
            [disabled]="action.busy()"
            (click)="save()"
          >
            Guardar
          </button>
        }
      </div>
    </app-modal>
  `,
})
export class FiscalSeriesPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly rows = signal<FiscalSeries[]>([]);
  protected readonly entities = signal<{ legalEntityId: string; code: string }[]>([]);
  protected readonly numbers = signal<
    {
      number: number;
      formatted: string;
      issueDate: string;
      documentType: string;
      at: string | null;
    }[]
  >([]);
  protected readonly canManage = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly action = new Action();
  protected readonly notice = SIMULATION_NOTICE;
  protected readonly kinds = Object.entries(DOCUMENT_KIND);
  protected readonly tone = fiscalTone;
  protected readonly when = formatDateTime;
  protected readonly status = (s: string) => SERIES_STATUS[s] ?? s;
  protected target: FiscalSeries | null = null;
  protected reason = '';
  protected form = this.blank();
  protected readonly columns: Column<FiscalSeries>[] = [
    { key: 'code', label: 'Série', required: true },
    { key: 'legalEntity', label: 'Entidade', value: (s) => s.legalEntity.code },
    {
      key: 'documentKind',
      label: 'Documento',
      value: (s) => `${DOCUMENT_KIND[s.documentKind]} (${s.fiscalCode})`,
    },
    { key: 'fiscalYear', label: 'Ano', value: (s) => String(s.fiscalYear) },
    { key: 'next', label: 'Próximo número' },
    {
      key: 'issued',
      label: 'Emitidos',
      align: 'end',
      hideOnMobile: true,
      value: (s) => String(s.issued),
    },
    {
      key: 'lastIssueDate',
      label: 'Última emissão',
      hideOnMobile: true,
      value: (s) => s.lastIssueDate ?? '—',
    },
    { key: 'status', label: 'Estado', value: (s) => SERIES_STATUS[s.status] },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    void this.load();
  }

  private blank() {
    return {
      id: '',
      version: 0,
      draft: true,
      legalEntityId: '',
      documentKind: 'INVOICE',
      fiscalCode: '',
      code: '',
      fiscalYear: new Date().getFullYear(),
      prefix: '',
      padding: 0,
      authorityReference: '',
    };
  }

  protected dialogTitle() {
    const d = this.dialog();
    if (d === 'edit') return this.form.id ? 'Editar série' : 'Nova série';
    if (d === 'close') return 'Fechar a série';
    if (d === 'numbers') return `Números de ${this.target?.code ?? ''}`;
    return '';
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [r, s] = await Promise.all([
        this.api.get<{ items: FiscalSeries[]; can: { manage: boolean } }>('sales/fiscal/series'),
        this.api.get<{ items: { legalEntityId: string; code: string }[] }>('sales/fiscal/settings'),
      ]);
      this.rows.set(r.items);
      this.canManage.set(r.can.manage);
      this.entities.set(s.items);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected openEdit(s: FiscalSeries | null) {
    this.action.error.set(null);
    this.form = s
      ? {
          id: s.id,
          version: s.version,
          draft: s.status === 'DRAFT',
          legalEntityId: s.legalEntity.id,
          documentKind: s.documentKind,
          fiscalCode: s.fiscalCode,
          code: s.code,
          fiscalYear: s.fiscalYear,
          prefix: s.prefix,
          padding: s.padding,
          authorityReference: s.authorityReference ?? '',
        }
      : this.blank();
    this.dialog.set('edit');
  }
  protected openClose(s: FiscalSeries) {
    this.action.error.set(null);
    this.target = s;
    this.reason = '';
    this.dialog.set('close');
  }
  protected async openNumbers(s: FiscalSeries) {
    this.target = s;
    this.numbers.set(await this.api.get(`sales/fiscal/series/${s.id}/numbers`, { limit: 100 }));
    this.dialog.set('numbers');
  }

  protected async activate(s: FiscalSeries) {
    const ok = await this.confirm.ask({
      title: 'Activar a série',
      message: `A partir de agora ${s.code} atribui números (em simulação) e a configuração deixa de poder mudar.`,
      confirmLabel: 'Activar',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.api.post(`sales/fiscal/series/${s.id}/activate`, { expectedVersion: s.version }),
    );
    if (r) this.toasts.show('Série activa.');
    await this.load();
  }

  protected async save() {
    const f = this.form;
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    const r = await this.action.run(() => {
      if (this.dialog() === 'close')
        return this.api.post(`sales/fiscal/series/${this.target!.id}/close`, {
          expectedVersion: this.target!.version,
          reason: this.reason,
        });
      const config = {
        documentKind: f.documentKind,
        fiscalCode: f.fiscalCode,
        code: f.code,
        fiscalYear: Number(f.fiscalYear),
        prefix: f.prefix,
        padding: Number(f.padding),
      };
      if (!f.id)
        return this.api.post('sales/fiscal/series', {
          ...config,
          legalEntityId: f.legalEntityId,
          authorityReference: nz(f.authorityReference),
        });
      return this.api.patch(`sales/fiscal/series/${f.id}`, {
        expectedVersion: f.version,
        ...(f.draft ? config : {}),
        authorityReference: nz(f.authorityReference),
      });
    });
    if (!r) return;
    this.toasts.show(this.dialog() === 'close' ? 'Série fechada.' : 'Série guardada.');
    this.dialog.set(null);
    await this.load();
  }
}
