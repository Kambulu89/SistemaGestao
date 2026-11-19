import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
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
import { type TabItem, Tabs } from '../ui/tabs';
import { ToastService } from '../ui/toasts';
import type { Setting } from './supplier-model';

type Kind = 'document-types' | 'criteria';
const LABEL: Record<Kind, string> = { 'document-types': 'tipo de documento', criteria: 'critério' };

/**
 * Configuração das compras: tipos de documento exigidos aos fornecedores (obrigatórios contam para a validade da
 * homologação) e critérios de homologação (os obrigatórios têm de estar cumpridos). Nada se apaga: inactiva-se.
 */
@Component({
  selector: 'app-procurement-settings',
  imports: [
    FormsModule,
    PageHeader,
    Tabs,
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
      title="Configuração das compras"
      subtitle="O que a empresa exige para homologar um fornecedor. Nada se apaga: inactiva-se."
    />
    <app-tabs label="Configuração das compras" [tabs]="tabs" [(active)]="tab" />
    <div
      class="mt-4"
      role="tabpanel"
      [id]="'panel-' + tab()"
      [attr.aria-labelledby]="'tab-' + tab()"
    >
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="load()" />
      } @else {
        @if (canEdit()) {
          <div class="mb-3 flex justify-end">
            <button type="button" class="btn-primary" data-testid="ps-new" (click)="open(null)">
              <app-icon name="plus" [size]="16" />Novo {{ label() }}
            </button>
          </div>
        }
        <app-data-table
          [label]="tab() === 'criteria' ? 'Critérios de homologação' : 'Tipos de documento'"
          [columns]="columns"
          [rows]="rows()"
          [total]="rows().length"
          [limit]="1000"
          emptyText="Sem registos."
        >
          <ng-template appCell="required" let-row>{{ row.required ? 'Sim' : 'Não' }}</ng-template>
          <ng-template appCell="status" let-row>
            <span
              class="badge"
              [class]="
                row.status === 'ACTIVE'
                  ? 'bg-success-soft text-success-text'
                  : 'bg-surface-2 text-muted'
              "
              >{{ row.status === 'ACTIVE' ? 'Activo' : 'Inactivo' }}</span
            >
          </ng-template>
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
    </div>

    <app-modal
      [title]="(form.id ? 'Editar ' : 'Novo ') + label()"
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
            data-testid="ps-code"
            [disabled]="!!form.id"
            [(ngModel)]="form.code"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            name="name"
            data-testid="ps-name"
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
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="required"
            data-testid="ps-required"
            [(ngModel)]="form.required"
          />
          Obrigatório
        </label>
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
          data-testid="ps-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class ProcurementSettings {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly tabs: TabItem[] = [
    { id: 'document-types', label: 'Tipos de documento' },
    { id: 'criteria', label: 'Critérios de homologação' },
  ];
  protected readonly tab = signal<string>('document-types');
  protected readonly rows = signal<Setting[]>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly canEdit = computed(() => this.workspace.can('procurement.settings'));
  protected readonly label = computed(() => LABEL[this.tab() as Kind]);
  protected form = {
    id: '',
    version: 0,
    code: '',
    name: '',
    description: '',
    required: false,
    status: 'ACTIVE',
  };
  protected readonly columns: Column<Setting>[] = [
    { key: 'code', label: 'Código', required: true },
    { key: 'name', label: 'Nome' },
    { key: 'required', label: 'Obrigatório', value: (r) => (r.required ? 'Sim' : 'Não') },
    {
      key: 'status',
      label: 'Estado',
      value: (r) => (r.status === 'ACTIVE' ? 'Activo' : 'Inactivo'),
    },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    effect(() => {
      this.tab();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.rows.set(await this.api.get<Setting[]>(`procurement/settings/${this.tab()}`));
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected open(row: Setting | null) {
    this.action.error.set(null);
    this.form = row
      ? {
          id: row.id,
          version: row.version,
          code: row.code,
          name: row.name,
          description: row.description ?? '',
          required: row.required,
          status: row.status,
        }
      : {
          id: '',
          version: 0,
          code: '',
          name: '',
          description: '',
          required: false,
          status: 'ACTIVE',
        };
    this.opened.set(true);
  }

  protected async save() {
    const body = {
      name: this.form.name,
      description: this.form.description.trim() || null,
      required: this.form.required,
    };
    const url = `procurement/settings/${this.tab()}`;
    const r = await this.action.run(() =>
      this.form.id
        ? this.api.patch<Setting>(`${url}/${this.form.id}`, {
            ...body,
            status: this.form.status,
            expectedVersion: this.form.version,
          })
        : this.api.post<Setting>(url, { ...body, code: this.form.code }),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show('Guardado.');
    await this.load();
  }
}
