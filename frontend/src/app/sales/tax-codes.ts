import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { ToastService } from '../ui/toasts';
import { ROUNDING, TAX_KIND, TAX_TYPE, type TaxCode, type TaxCodeRow } from './fiscal-model';

interface EntityRounding {
  legalEntityId: string;
  code: string;
  name: string;
  countryCode: string;
  roundingLevel: 'LINE' | 'DOCUMENT';
}

/**
 * Impostos e retenções da empresa por país, com as taxas confirmadas (na ficha) e o arredondamento por entidade.
 * Nada vem pré-carregado: cada valor é introduzido a partir da fonte oficial e confirmado por outra pessoa.
 */
@Component({
  selector: 'app-tax-codes',
  imports: [
    FormsModule,
    PageHeader,
    DataTable,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Icon,
  ],
  template: `
    <app-page-header
      title="Impostos e retenções"
      subtitle="Valores configurados pela empresa a partir das fontes oficiais, com a fonte legal e a confirmação de outra pessoa. Nenhum valor vem pré-carregado."
    />
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      @if (canManage()) {
        <div class="mb-3 flex justify-end">
          <button type="button" class="btn-primary" data-testid="tc-new" (click)="openNew()">
            <app-icon name="plus" [size]="16" />Novo imposto
          </button>
        </div>
      }
      <app-data-table
        label="Impostos e retenções"
        [columns]="columns"
        [rows]="rows()"
        [total]="rows().length"
        [limit]="1000"
        emptyText="Ainda não há impostos configurados."
      />

      <section class="card mt-4" aria-labelledby="tc-r-title">
        <h2 id="tc-r-title" class="font-semibold">Arredondamento do imposto</h2>
        <p class="mb-3 text-sm text-muted">
          Por linha: cada imposto de cada linha é arredondado a 2 casas. Por documento: arredonda-se
          uma vez o total de cada imposto. Confirme na fonte oficial qual se aplica.
        </p>
        <div class="grid gap-3 sm:grid-cols-2" data-testid="tc-rounding">
          @for (e of entities(); track e.legalEntityId) {
            <app-field [label]="e.code + ' — ' + e.name + ' (' + e.countryCode + ')'">
              <select
                appControl
                class="input"
                [name]="'rd-' + e.legalEntityId"
                [disabled]="!canManage()"
                [ngModel]="e.roundingLevel"
                (ngModelChange)="setRounding(e, $event)"
              >
                @for (r of roundings; track r[0]) {
                  <option [value]="r[0]">{{ r[1] }}</option>
                }
              </select>
            </app-field>
          }
        </div>
      </section>
    }

    <app-modal title="Novo imposto" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="País" [required]="true" [error]="action.field('countryCode')">
          <input
            appControl
            class="input w-24 uppercase"
            name="country"
            maxlength="2"
            [(ngModel)]="form.countryCode"
          />
        </app-field>
        <app-field
          label="Código"
          [required]="true"
          hint="Código interno (ex.: o usado na fonte oficial)."
          [error]="action.field('code')"
        >
          <input
            appControl
            class="input uppercase"
            name="code"
            data-testid="tc-code"
            [(ngModel)]="form.code"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            name="name"
            data-testid="tc-name"
            [(ngModel)]="form.name"
          />
        </app-field>
        <app-field label="Natureza" [required]="true" [error]="action.field('kind')">
          <select
            appControl
            class="input"
            name="kind"
            data-testid="tc-kind"
            [(ngModel)]="form.kind"
          >
            @for (k of kinds; track k[0]) {
              <option [value]="k[0]">{{ k[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Tipo" [required]="true" [error]="action.field('taxType')">
          <select appControl class="input" name="type" [(ngModel)]="form.taxType">
            @for (t of types; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tc-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Criar
        </button>
      </div>
    </app-modal>
  `,
})
export class TaxCodes {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly rows = signal<TaxCodeRow[]>([]);
  protected readonly entities = signal<EntityRounding[]>([]);
  protected readonly canManage = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly kinds = Object.entries(TAX_KIND);
  protected readonly types = Object.entries(TAX_TYPE);
  protected readonly roundings = Object.entries(ROUNDING);
  protected form = this.blank();
  protected readonly columns: Column<TaxCodeRow>[] = [
    {
      key: 'code',
      label: 'Código',
      required: true,
      link: (r) => ['/vendas/fiscal/impostos', r.id],
    },
    { key: 'name', label: 'Nome' },
    { key: 'countryCode', label: 'País' },
    { key: 'kind', label: 'Natureza', value: (r) => TAX_KIND[r.kind] },
    {
      key: 'taxType',
      label: 'Tipo',
      hideOnMobile: true,
      value: (r) => TAX_TYPE[r.taxType] ?? r.taxType,
    },
    {
      key: 'confirmedRates',
      label: 'Taxas confirmadas',
      align: 'end',
      value: (r) => String(r.confirmedRates),
    },
    {
      key: 'draftRates',
      label: 'Por confirmar',
      align: 'end',
      hideOnMobile: true,
      value: (r) => String(r.draftRates),
    },
    {
      key: 'status',
      label: 'Estado',
      value: (r) => (r.status === 'ACTIVE' ? 'Activo' : 'Inactivo'),
    },
  ];

  constructor() {
    void this.load();
  }

  private blank() {
    return { countryCode: 'AO', code: '', name: '', kind: 'TAX', taxType: 'VAT' };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [c, s] = await Promise.all([
        this.api.get<{ items: TaxCodeRow[]; can: { manage: boolean } }>('sales/fiscal/tax-codes'),
        this.api.get<{ items: EntityRounding[] }>('sales/fiscal/settings'),
      ]);
      this.rows.set(c.items);
      this.canManage.set(c.can.manage);
      this.entities.set(s.items);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected openNew() {
    this.action.error.set(null);
    this.form = this.blank();
    this.opened.set(true);
  }

  protected async save() {
    const r = await this.action.run(() =>
      this.api.post<TaxCode>('sales/fiscal/tax-codes', this.form),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show('Imposto criado: acrescente as taxas com a fonte legal.');
    await this.router.navigate(['/vendas/fiscal/impostos', r.id]);
  }

  protected async setRounding(e: EntityRounding, level: string) {
    const r = await this.action.run(() =>
      this.api.put(`sales/fiscal/settings/${e.legalEntityId}`, { roundingLevel: level }),
    );
    if (r) this.toasts.show(`Arredondamento de ${e.code}: ${ROUNDING[level]}.`);
    await this.load();
  }
}
