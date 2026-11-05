import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { inject } from '@angular/core';
import type { Chart } from './model';
import { accountingDeps, legalEntityOptions } from './shared';

/** Planos de contas (um activo por entidade legal). Nenhum plano oficial vem pré-carregado (D-014). */
@Component({
  selector: 'app-charts',
  imports: [
    FormsModule,
    PageHeader,
    DataTable,
    CellDef,
    StatusBadge,
    ErrorAlert,
    FormSection,
    FormField,
    FieldControl,
  ],
  template: `
    <app-page-header
      title="Planos de contas"
      subtitle="Um plano activo por entidade legal. A estrutura é definida pela empresa e deve ser validada com o normativo em vigor."
    />
    <app-data-table
      label="Planos de contas"
      [columns]="columns"
      [rows]="charts.value() ?? []"
      [total]="charts.value()?.length ?? 0"
      [loading]="charts.loading()"
      [error]="charts.error()"
      emptyText="Ainda não há planos de contas."
      (retry)="charts.load()"
    >
      <ng-template appCell="status" let-row><app-status-badge [status]="row.status" /></ng-template>
    </app-data-table>
    @if (canManage()) {
      <form class="mt-4 space-y-3" (ngSubmit)="create()" aria-label="Novo plano de contas">
        <app-error-alert [error]="action.error()" [showDetails]="false" />
        <app-form-section
          title="Novo plano"
          description="Depois de criado, acrescente as classes e contas."
        >
          <app-field
            label="Entidade legal"
            [required]="true"
            [error]="action.field('legalEntityId')"
          >
            <select appControl class="input" name="le" [(ngModel)]="form.legalEntityId">
              <option [ngValue]="null">—</option>
              @for (o of entities(); track o.id) {
                <option [ngValue]="o.id">{{ o.label }}</option>
              }
            </select>
          </app-field>
          <app-field label="Código" [required]="true" [error]="action.field('code')">
            <input appControl class="input" name="code" [(ngModel)]="form.code" />
          </app-field>
          <app-field label="Nome" [required]="true" [error]="action.field('name')">
            <input appControl class="input" name="name" [(ngModel)]="form.name" />
          </app-field>
          <app-field
            label="Jurisdição (país ISO)"
            [required]="true"
            [error]="action.field('jurisdiction')"
          >
            <input appControl class="input" name="jurisdiction" [(ngModel)]="form.jurisdiction" />
          </app-field>
          <app-field
            label="Modelo de referência"
            hint="Texto livre, p. ex. a norma em que o plano se baseia. Não é uma certificação."
            [error]="action.field('baseModel')"
            class="md:col-span-2"
          >
            <input appControl class="input" name="baseModel" [(ngModel)]="form.baseModel" />
          </app-field>
        </app-form-section>
        <button type="submit" class="btn-primary" [disabled]="action.busy()">Criar plano</button>
      </form>
    }
  `,
})
export class Charts {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly action = new Action();
  protected form = {
    legalEntityId: null as string | null,
    code: '',
    name: '',
    jurisdiction: 'AO',
    baseModel: '',
  };
  protected readonly charts = new Loadable(
    async () => (await this.deps.api.page<Chart>('accounting/charts', { limit: 200 })).items,
  );
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly columns: Column<Chart>[] = [
    { key: 'code', label: 'Código', link: (r) => ['/contabilidade/planos', r.id] },
    { key: 'name', label: 'Nome' },
    {
      key: 'legalEntityId',
      label: 'Entidade legal',
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
    },
    { key: 'jurisdiction', label: 'Jurisdição', hideOnMobile: true },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.charts.load();
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (e) => {
        this.entities.set(e);
        this.form.legalEntityId = this.deps.workspace.legalEntityId() ?? null;
      },
      () => undefined,
    );
  }

  protected async create() {
    const created = await this.action.run(() =>
      this.deps.api.post<Chart>('accounting/charts', {
        ...this.form,
        baseModel: this.form.baseModel || null,
      }),
    );
    if (!created) return;
    this.toasts.show('Plano criado.');
    this.form = { ...this.form, code: '', name: '', baseModel: '' };
    await this.charts.load();
  }
}
