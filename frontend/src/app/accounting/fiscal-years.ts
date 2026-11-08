import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { Action, Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import type { FiscalYear } from './model';
import { accountingDeps, legalEntityOptions } from './shared';

/** Exercícios: ao criar, o servidor gera os períodos (abertura, mensais e regularizações). */
@Component({
  selector: 'app-fiscal-years',
  imports: [
    FormsModule,
    EntityListPage,
    DataTable,
    CellDef,
    ErrorAlert,
    FormSection,
    FormField,
    FieldControl,
  ],
  template: `
    <app-entity-list-page
      title="Exercícios e períodos"
      subtitle="Os lançamentos só entram em períodos abertos."
      permission="accounting.read"
      feature="accounting"
    >
      <app-data-table
        tableId="acc-fiscal-years"
        label="Exercícios"
        [columns]="columns"
        [rows]="years.value() ?? []"
        [total]="years.value()?.length ?? 0"
        [loading]="years.loading()"
        [error]="years.error()"
        emptyText="Ainda não há exercícios."
        (retry)="years.load()"
      >
        <ng-template appCell="status" let-row
          ><span
            class="badge"
            [class]="
              row.status === 'OPEN' ? 'bg-success-soft text-success-text' : 'bg-surface-2 text-fg'
            "
            >{{ row.status === 'OPEN' ? 'Aberto' : 'Fechado' }}</span
          ></ng-template
        >
      </app-data-table>
      @if (canManage()) {
        <form class="mt-4 space-y-3" (ngSubmit)="create()" aria-label="Novo exercício">
          <app-error-alert [error]="action.error()" [showDetails]="false" />
          <app-form-section
            title="Novo exercício"
            description="De 1 a 24 meses; não se sobrepõe a outro da mesma entidade legal."
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
            <app-field
              label="Código"
              [required]="true"
              hint="Ex.: 2026"
              [error]="action.field('code')"
            >
              <input appControl class="input" name="code" [(ngModel)]="form.code" />
            </app-field>
            <app-field label="Início" [required]="true" [error]="action.field('startDate')">
              <input
                appControl
                type="date"
                class="input"
                name="start"
                [(ngModel)]="form.startDate"
              />
            </app-field>
            <app-field label="Fim" [required]="true" [error]="action.field('endDate')">
              <input appControl type="date" class="input" name="end" [(ngModel)]="form.endDate" />
            </app-field>
          </app-form-section>
          <button type="submit" class="btn-primary" [disabled]="action.busy()">
            Criar exercício
          </button>
        </form>
      }
    </app-entity-list-page>
  `,
})
export class FiscalYears {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly action = new Action();
  protected form = { legalEntityId: null as string | null, code: '', startDate: '', endDate: '' };
  protected readonly years = new Loadable(
    async () =>
      (await this.deps.api.page<FiscalYear>('accounting/fiscal-years', { limit: 200 })).items,
  );
  protected readonly columns: Column<FiscalYear>[] = [
    {
      key: 'code',
      required: true,
      label: 'Exercício',
      link: (r) => ['/contabilidade/exercicios', r.id],
    },
    {
      key: 'legalEntityId',
      label: 'Entidade legal',
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
    },
    { key: 'startDate', label: 'Início', value: (r) => formatDate(r.startDate) },
    { key: 'endDate', label: 'Fim', value: (r) => formatDate(r.endDate) },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.years.load();
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
      this.deps.api.post<FiscalYear>('accounting/fiscal-years', this.form),
    );
    if (!created) return;
    this.toasts.show(`Exercício criado com ${created.periods?.length ?? 0} períodos.`);
    this.form = { ...this.form, code: '', startDate: '', endDate: '' };
    await this.years.load();
  }
}
