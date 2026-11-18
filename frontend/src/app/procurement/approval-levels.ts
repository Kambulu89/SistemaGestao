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
import { money } from '../inventory/valuation-model';
import type { ApprovalLevel } from './requisition-model';

/**
 * Etapas de aprovação das requisições de compra: uma requisição precisa de todas as etapas activas (da sua entidade
 * ou gerais) cujo valor mínimo o total em moeda funcional atinge, por ordem; sem nenhuma, há uma aprovação base.
 */
@Component({
  selector: 'app-approval-levels',
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
      title="Etapas de aprovação das compras"
      subtitle="Por valor mínimo em moeda funcional; cada etapa é decidida por uma pessoa diferente e nunca por quem pede."
    />
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      @if (canEdit()) {
        <div class="mb-3 flex justify-end">
          <button type="button" class="btn-primary" data-testid="al-new" (click)="open(null)">
            <app-icon name="plus" [size]="16" />Nova etapa
          </button>
        </div>
      }
      <app-data-table
        label="Etapas de aprovação"
        [columns]="columns"
        [rows]="rows()"
        [total]="rows().length"
        [limit]="1000"
        emptyText="Sem etapas: cada requisição tem uma aprovação base."
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
      [title]="form.id ? 'Editar etapa' : 'Nova etapa'"
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
            data-testid="al-code"
            [disabled]="!!form.id"
            [(ngModel)]="form.code"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            name="name"
            data-testid="al-name"
            [(ngModel)]="form.name"
          />
        </app-field>
        <app-field label="Ordem" [required]="true" [error]="action.field('sequence')">
          <input
            appControl
            class="input w-24"
            type="number"
            min="1"
            max="99"
            name="sequence"
            data-testid="al-seq"
            [(ngModel)]="form.sequence"
          />
        </app-field>
        <app-field
          label="Valor mínimo (moeda funcional)"
          [required]="true"
          [error]="action.field('minAmount')"
        >
          <input
            appControl
            class="input w-48"
            inputmode="decimal"
            name="min"
            data-testid="al-min"
            [(ngModel)]="form.minAmount"
          />
        </app-field>
        <app-field
          label="Entidade legal"
          hint="Vazio: todas."
          [error]="action.field('legalEntityId')"
        >
          <select appControl class="input" name="le" [(ngModel)]="form.legalEntityId">
            <option value="">Todas</option>
            @for (e of entities(); track e.id) {
              <option [value]="e.id">{{ e.code }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Perfil exigido"
          hint="Vazio: qualquer pessoa que aprove requisições no âmbito."
          [error]="action.field('approverRoleId')"
        >
          <select
            appControl
            class="input"
            name="role"
            data-testid="al-role"
            [(ngModel)]="form.approverRoleId"
          >
            <option value="">Nenhum</option>
            @for (r of roles(); track r.id) {
              <option [value]="r.id">{{ r.name }}</option>
            }
          </select>
        </app-field>
        @if (form.id) {
          <app-field label="Estado" [error]="action.field('status')">
            <select appControl class="input" name="status" [(ngModel)]="form.status">
              <option value="ACTIVE">Activa</option>
              <option value="INACTIVE">Inactiva</option>
            </select>
          </app-field>
        }
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="al-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class ApprovalLevels {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly rows = signal<ApprovalLevel[]>([]);
  protected readonly entities = signal<{ id: string; code: string }[]>([]);
  protected readonly roles = signal<{ id: string; name: string }[]>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly canEdit = computed(() => this.workspace.can('procurement.settings'));
  protected form = this.blank();
  protected readonly columns: Column<ApprovalLevel>[] = [
    { key: 'sequence', label: 'Ordem', value: (l) => String(l.sequence) },
    { key: 'code', label: 'Código', required: true },
    { key: 'name', label: 'Nome' },
    {
      key: 'minAmount',
      label: 'A partir de',
      align: 'end',
      value: (l) => money(l.minAmount, null),
    },
    { key: 'legalEntity', label: 'Entidade', value: (l) => l.legalEntity?.code ?? 'Todas' },
    {
      key: 'approverRole',
      label: 'Perfil exigido',
      hideOnMobile: true,
      value: (l) => l.approverRole?.name ?? '—',
    },
    {
      key: 'status',
      label: 'Estado',
      value: (l) => (l.status === 'ACTIVE' ? 'Activa' : 'Inactiva'),
    },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    void this.load();
    this.api
      .get<{ id: string; code: string }[]>('organization/legal-entities', { limit: 200 })
      .then(
        (e) => this.entities.set(e),
        () => undefined,
      );
    this.api.get<{ id: string; name: string }[]>('roles').then(
      (r) => this.roles.set(r),
      () => undefined,
    );
  }

  private blank() {
    return {
      id: '',
      version: 0,
      code: '',
      name: '',
      sequence: 1,
      minAmount: '0',
      legalEntityId: '',
      approverRoleId: '',
      status: 'ACTIVE',
    };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.rows.set(await this.api.get<ApprovalLevel[]>('procurement/approval-levels'));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected open(l: ApprovalLevel | null) {
    this.action.error.set(null);
    this.form = l
      ? {
          id: l.id,
          version: l.version,
          code: l.code,
          name: l.name,
          sequence: l.sequence,
          minAmount: l.minAmount,
          legalEntityId: l.legalEntity?.id ?? '',
          approverRoleId: l.approverRole?.id ?? '',
          status: l.status,
        }
      : this.blank();
    this.opened.set(true);
  }

  protected async save() {
    const body = {
      name: this.form.name,
      sequence: Number(this.form.sequence),
      minAmount: String(this.form.minAmount).replace(',', '.'),
      legalEntityId: this.form.legalEntityId || null,
      approverRoleId: this.form.approverRoleId || null,
    };
    const r = await this.action.run(() =>
      this.form.id
        ? this.api.patch<ApprovalLevel>(`procurement/approval-levels/${this.form.id}`, {
            ...body,
            status: this.form.status,
            expectedVersion: this.form.version,
          })
        : this.api.post<ApprovalLevel>('procurement/approval-levels', {
            ...body,
            code: this.form.code,
          }),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show('Etapa guardada.');
    await this.load();
  }
}
