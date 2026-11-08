import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { Action, Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { JOURNAL_TYPES, type Journal, label } from './model';
import { accountingDeps, legalEntityOptions } from './shared';

interface Series {
  id: string;
  code: string;
  legalEntityId: string;
  documentType: string;
  status: string;
}

/** Diários: cada um numera os lançamentos contabilizados com uma série documental própria (tipo JOURNAL). */
@Component({
  selector: 'app-journals',
  imports: [
    FormsModule,
    RouterLink,
    EntityListPage,
    DataTable,
    CellDef,
    StatusBadge,
    ErrorAlert,
    FormSection,
    FormField,
    FieldControl,
  ],
  template: `
    <app-entity-list-page
      title="Diários"
      subtitle="A numeração vem da série documental do diário, no momento da contabilização."
      permission="accounting.read"
      feature="accounting"
    >
      <app-data-table
        tableId="acc-journals"
        label="Diários"
        [columns]="columns"
        [rows]="journals.value() ?? []"
        [total]="journals.value()?.length ?? 0"
        [loading]="journals.loading()"
        [error]="journals.error()"
        emptyText="Ainda não há diários."
        (retry)="journals.load()"
      >
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>
      @if (canManage()) {
        <form class="mt-4 space-y-3" (ngSubmit)="create()" aria-label="Novo diário">
          <app-error-alert [error]="action.error()" [showDetails]="false" />
          <app-form-section title="Novo diário">
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
            <app-field label="Tipo" [required]="true" [error]="action.field('type')">
              <select appControl class="input" name="type" [(ngModel)]="form.type">
                @for (t of types; track t.value) {
                  <option [value]="t.value">{{ t.label }}</option>
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
              label="Série documental"
              [required]="true"
              [error]="action.field('documentSeriesId')"
              class="md:col-span-2"
            >
              <select appControl class="input" name="series" [(ngModel)]="form.documentSeriesId">
                <option [ngValue]="null">—</option>
                @for (s of seriesFor(form.legalEntityId); track s.id) {
                  <option [ngValue]="s.id">{{ s.code }}</option>
                }
              </select>
            </app-field>
            @if (form.legalEntityId && seriesFor(form.legalEntityId).length === 0) {
              <p class="text-sm text-muted md:col-span-2">
                Não há séries abertas do tipo "Lançamento contabilístico" para esta entidade.
                <a class="btn-link" routerLink="/empresa/document-series/novo">Criar série</a>
              </p>
            }
          </app-form-section>
          <button type="submit" class="btn-primary" [disabled]="action.busy()">Criar diário</button>
        </form>
      }
    </app-entity-list-page>
  `,
})
export class Journals {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly types = JOURNAL_TYPES;
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly series = signal<Series[]>([]);
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly action = new Action();
  protected form = {
    legalEntityId: null as string | null,
    code: '',
    name: '',
    type: 'GENERAL',
    documentSeriesId: null as string | null,
  };
  protected readonly journals = new Loadable(
    async () => (await this.deps.api.page<Journal>('accounting/journals', { limit: 200 })).items,
  );
  protected readonly columns: Column<Journal>[] = [
    { key: 'code', required: true, label: 'Código' },
    { key: 'name', label: 'Nome' },
    { key: 'type', label: 'Tipo', value: (r) => label(JOURNAL_TYPES, r.type) },
    {
      key: 'legalEntityId',
      label: 'Entidade legal',
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
      hideOnMobile: true,
    },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.journals.load();
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (e) => {
        this.entities.set(e);
        this.form.legalEntityId = this.deps.workspace.legalEntityId() ?? null;
      },
      () => undefined,
    );
    if (this.deps.workspace.can('settings.read'))
      this.deps.api
        .page<Series>('document-series', { documentType: 'JOURNAL', status: 'ACTIVE', limit: 200 })
        .then(
          (p) => this.series.set(p.items),
          () => undefined,
        );
  }

  protected seriesFor(legalEntityId: string | null) {
    return this.series().filter((s) => s.legalEntityId === legalEntityId);
  }

  protected async create() {
    const created = await this.action.run(() =>
      this.deps.api.post<Journal>('accounting/journals', this.form),
    );
    if (!created) return;
    this.toasts.show('Diário criado.');
    this.form = { ...this.form, code: '', name: '', documentSeriesId: null };
    await this.journals.load();
  }
}
