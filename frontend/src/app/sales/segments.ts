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
import type { Segment } from './customer-model';

/** Segmentos de clientes (usados nas tabelas de preços); só quem configura as vendas os altera. */
@Component({
  selector: 'app-customer-segments',
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
      title="Segmentos de clientes"
      subtitle="Agrupam clientes para preços e relatórios; um segmento inactivo deixa de poder ser escolhido."
    />
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      @if (canEdit()) {
        <div class="mb-3 flex justify-end">
          <button type="button" class="btn-primary" data-testid="sg-new" (click)="open(null)">
            <app-icon name="plus" [size]="16" />Novo segmento
          </button>
        </div>
      }
      <app-data-table
        label="Segmentos de clientes"
        [columns]="columns"
        [rows]="rows()"
        [total]="rows().length"
        [limit]="1000"
        emptyText="Ainda não há segmentos."
      >
        <ng-template appCell="actions" let-row>
          @if (canEdit()) {
            <button
              type="button"
              class="link"
              [attr.aria-label]="'Editar ' + row.code"
              (click)="open(row)"
            >
              Editar
            </button>
          }
        </ng-template>
      </app-data-table>
    }

    <app-modal
      [title]="form.id ? 'Editar segmento' : 'Novo segmento'"
      [open]="opened()"
      (closed)="opened.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input uppercase"
            name="code"
            data-testid="sg-code"
            [disabled]="!!form.id"
            [(ngModel)]="form.code"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            name="name"
            data-testid="sg-name"
            [(ngModel)]="form.name"
          />
        </app-field>
        <app-field label="Descrição" [error]="action.field('description')">
          <textarea
            appControl
            class="input min-h-16"
            name="description"
            [(ngModel)]="form.description"
          ></textarea>
        </app-field>
        @if (form.id) {
          <app-field label="Estado" [error]="action.field('status')">
            <select appControl class="input" name="status" [(ngModel)]="form.status">
              <option value="ACTIVE">Activo</option>
              <option value="INACTIVE">Inactivo</option>
            </select>
          </app-field>
        }
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="sg-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class CustomerSegments {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly rows = signal<Segment[]>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly canEdit = computed(() => this.workspace.can('sales.settings'));
  protected form = this.blank();
  protected readonly columns: Column<Segment>[] = [
    { key: 'code', label: 'Código', required: true },
    { key: 'name', label: 'Nome' },
    {
      key: 'description',
      label: 'Descrição',
      hideOnMobile: true,
      value: (s) => s.description ?? '—',
    },
    { key: 'customers', label: 'Clientes', align: 'end', value: (s) => String(s.customers) },
    {
      key: 'status',
      label: 'Estado',
      value: (s) => (s.status === 'ACTIVE' ? 'Activo' : 'Inactivo'),
    },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    void this.load();
  }

  private blank() {
    return { id: '', version: 0, code: '', name: '', description: '', status: 'ACTIVE' };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.rows.set(await this.api.get<Segment[]>('sales/segments'));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected open(s: Segment | null) {
    this.action.error.set(null);
    this.form = s
      ? {
          id: s.id,
          version: s.version,
          code: s.code,
          name: s.name,
          description: s.description ?? '',
          status: s.status,
        }
      : this.blank();
    this.opened.set(true);
  }

  protected async save() {
    const body = {
      name: this.form.name,
      description: this.form.description.trim() === '' ? null : this.form.description,
    };
    const r = await this.action.run(() =>
      this.form.id
        ? this.api.patch<Segment>(`sales/segments/${this.form.id}`, {
            ...body,
            status: this.form.status,
            expectedVersion: this.form.version,
          })
        : this.api.post<Segment>('sales/segments', { ...body, code: this.form.code }),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show('Segmento guardado.');
    await this.load();
  }
}
