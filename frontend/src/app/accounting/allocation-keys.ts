import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { type OrgRecord, recordLabel } from '../admin/org-kinds';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { AllocationEditor } from './allocation-editor';
import {
  type AllocationKey,
  type AllocationTarget,
  type Dimension,
  normalizeAmount,
  percentTotal,
} from './model';
import { accountingDeps, legalEntityOptions } from './shared';

/** Chaves de repartição: destinos reutilizáveis (p. ex. rateio de rendas por áreas) para aplicar às linhas. */
@Component({
  selector: 'app-allocation-keys',
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
    AllocationEditor,
  ],
  template: `
    <app-page-header
      title="Chaves de repartição"
      subtitle="Repartições a 100% reutilizáveis nas imputações das linhas."
    />
    <app-data-table
      label="Chaves de repartição"
      [columns]="columns"
      [rows]="keys.value() ?? []"
      [total]="keys.value()?.length ?? 0"
      [loading]="keys.loading()"
      [error]="keys.error()"
      emptyText="Ainda não há chaves."
      (retry)="keys.load()"
    >
      <ng-template appCell="code" let-row>
        <button type="button" class="btn-link" (click)="edit(row)">{{ row.code }}</button>
      </ng-template>
      <ng-template appCell="status" let-row><app-status-badge [status]="row.status" /></ng-template>
    </app-data-table>
    @if (canManage()) {
      <form
        class="mt-4 space-y-3"
        (ngSubmit)="save()"
        [attr.aria-label]="editing() ? 'Alterar chave' : 'Nova chave'"
      >
        <app-error-alert [error]="action.error()" [showDetails]="true" />
        <app-form-section [title]="editing() ? 'Alterar ' + editing()!.code : 'Nova chave'">
          <app-field
            label="Entidade legal"
            [required]="true"
            [error]="action.field('legalEntityId')"
          >
            <select
              appControl
              class="input"
              name="le"
              [disabled]="!!editing()"
              [(ngModel)]="form.legalEntityId"
              (ngModelChange)="loadCenters()"
            >
              <option [ngValue]="null">—</option>
              @for (e of entities(); track e.id) {
                <option [ngValue]="e.id">{{ e.label }}</option>
              }
            </select>
          </app-field>
          <app-field label="Código" [required]="true" [error]="action.field('code')">
            <input
              appControl
              class="input"
              name="code"
              [disabled]="!!editing()"
              [(ngModel)]="form.code"
            />
          </app-field>
          <app-field label="Nome" [required]="true" [error]="action.field('name')">
            <input appControl class="input" name="name" [(ngModel)]="form.name" />
          </app-field>
          <app-field label="Estado">
            <select appControl class="input" name="status" [(ngModel)]="form.status">
              <option value="ACTIVE">Activa</option>
              <option value="INACTIVE">Inactiva</option>
            </select>
          </app-field>
          <div class="md:col-span-2">
            <app-allocation-editor
              label="Destinos da chave"
              [(targets)]="targets"
              [dimensions]="dimensions()"
              [costCenters]="centers()"
            />
          </div>
        </app-form-section>
        <div class="flex gap-2">
          <button type="submit" class="btn-primary" [disabled]="action.busy() || !complete()">
            {{ editing() ? 'Guardar chave' : 'Criar chave' }}
          </button>
          @if (editing()) {
            <button type="button" class="btn-secondary" (click)="reset()">Nova chave</button>
          }
        </div>
      </form>
    }
  `,
})
export class AllocationKeys {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly dimensions = signal<Dimension[]>([]);
  protected readonly centers = signal<{ id: string; label: string }[]>([]);
  protected readonly editing = signal<AllocationKey | null>(null);
  protected readonly targets = signal<AllocationTarget[]>([
    { percent: '100', costCenterId: null, values: [] },
  ]);
  protected readonly complete = computed(() => percentTotal(this.targets()).complete);
  protected readonly action = new Action();
  protected form = { legalEntityId: null as string | null, code: '', name: '', status: 'ACTIVE' };
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly keys = new Loadable(
    async () =>
      (await this.deps.api.page<AllocationKey>('accounting/allocation-keys', { limit: 200 })).items,
  );
  protected readonly columns: Column<AllocationKey>[] = [
    { key: 'code', label: 'Código' },
    { key: 'name', label: 'Nome' },
    {
      key: 'legalEntityId',
      label: 'Entidade',
      hideOnMobile: true,
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
    },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.keys.load();
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      this.form.legalEntityId =
        this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
      await this.loadCenters();
    })();
    this.deps.api.page<Dimension>('accounting/dimensions', { limit: 200 }).then(
      (p) => this.dimensions.set(p.items),
      () => undefined,
    );
  }

  protected async loadCenters() {
    const le = this.form.legalEntityId;
    if (!le || !this.deps.workspace.can('organization.read')) return this.centers.set([]);
    const page = await this.deps.api.page<OrgRecord>('organization/cost-centers', {
      legalEntityId: le,
      status: 'ACTIVE',
      limit: 200,
    });
    this.centers.set(page.items.map((r) => ({ id: r.id, label: recordLabel(r) })));
  }

  protected async edit(k: AllocationKey) {
    const full = await this.deps.api.get<AllocationKey>(`accounting/allocation-keys/${k.id}`);
    this.editing.set(full);
    this.form = {
      legalEntityId: full.legalEntityId,
      code: full.code,
      name: full.name,
      status: full.status,
    };
    this.targets.set(full.lines ?? []);
    await this.loadCenters();
  }

  protected reset() {
    this.editing.set(null);
    this.form = { ...this.form, code: '', name: '', status: 'ACTIVE' };
    this.targets.set([{ percent: '100', costCenterId: null, values: [] }]);
  }

  protected async save() {
    const k = this.editing();
    const lines = this.targets().map((t) => ({
      percent: normalizeAmount(t.percent),
      costCenterId: t.costCenterId,
      values: t.values.map((v) => ({ dimensionId: v.dimensionId, valueId: v.valueId })),
    }));
    const result = await this.action.run(() =>
      k
        ? this.deps.api.patch<AllocationKey>(`accounting/allocation-keys/${k.id}`, {
            expectedVersion: k.version,
            name: this.form.name,
            status: this.form.status,
            lines,
          })
        : this.deps.api.post<AllocationKey>('accounting/allocation-keys', { ...this.form, lines }),
    );
    if (!result) return;
    this.toasts.show(k ? 'Chave guardada.' : 'Chave criada.');
    await this.keys.load();
    this.editing.set(result);
    this.targets.set(result.lines ?? []);
  }
}
