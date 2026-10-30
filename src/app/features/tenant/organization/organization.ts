import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { OrganizationApi, type UnitDto, type UnitType } from '../data-access/organization.api';
import { CostCentersPanel } from './cost-centers-panel';
import { buildUnitRows } from './organization-tree';
import { TeamPanel } from './team-panel';

const UNIT_TYPES: readonly { value: UnitType; label: string }[] = [
  { value: 'BRANCH', label: 'Filial' },
  { value: 'DEPARTMENT', label: 'Departamento' },
  { value: 'SECTION', label: 'Secção' },
  { value: 'TEAM', label: 'Equipa' },
  { value: 'OTHER', label: 'Outra' },
];

/** Organização e árvore de unidades do tenant activo. */
@Component({
  selector: 'app-tenant-organization',
  imports: [
    ReactiveFormsModule,
    Alert,
    Badge,
    Button,
    Card,
    CostCentersPanel,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    PageHeader,
    Select,
    Table,
    TeamPanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Organização"
      description="Estrutura legal e operacional: organizações e a sua árvore de unidades."
    />

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">
        {{ text }}
      </app-alert>
    }

    @if (organizations.isLoading() && !organizations.hasValue()) {
      <app-card><app-loading-state label="A carregar organização…" /></app-card>
    } @else if (organizations.error()) {
      <app-alert tone="danger" title="Não foi possível carregar a organização">
        {{ loadError(organizations.error()) }}
      </app-alert>
    } @else if (organizations.value(); as orgs) {
      @if (orgs.length === 0) {
        <app-card>
          <app-empty-state
            icon="building"
            title="Ainda não há organizações"
            description="Crie a primeira organização para poder definir unidades."
          />
        </app-card>
      } @else {
        <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div class="min-w-64">
            <app-select
              label="Organização"
              [formControl]="orgControl"
              placeholder="Seleccione…"
              [options]="orgOptions()"
            />
          </div>
          @if (canManage() && selectedOrg()) {
            <app-button (click)="openCreate()">Nova unidade</app-button>
          }
        </div>

        @if (selectedOrg(); as org) {
          <p class="mb-3 text-sm text-fg-muted">
            {{ org.legalName }} · {{ org.countryCode }} · moeda base {{ org.baseCurrency }}
          </p>
        }

        <app-card [flush]="true">
          @if (units.isLoading() && !units.hasValue()) {
            <app-loading-state label="A carregar unidades…" />
          } @else if (units.error()) {
            <div class="p-5">
              <app-alert tone="danger" title="Não foi possível carregar as unidades">
                {{ loadError(units.error()) }}
              </app-alert>
            </div>
          } @else if (rows().length === 0) {
            <app-empty-state icon="building" title="Sem unidades nesta organização" />
          } @else {
            <app-table caption="Unidades da organização" [columns]="columns" [rows]="rows()">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span [style.padding-inline-start.rem]="row.depth * 1.25" class="inline-block">
                      <span class="font-medium">{{ row.unit.name }}</span>
                    </span>
                  }
                  @case ('code') {
                    <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{{
                      row.unit.code
                    }}</code>
                  }
                  @case ('type') {
                    {{ typeLabel(row.unit.type) }}
                  }
                  @case ('active') {
                    <app-badge [tone]="row.unit.active ? 'success' : 'neutral'">{{
                      row.unit.active ? 'Activa' : 'Inactiva'
                    }}</app-badge>
                  }
                  @case ('actions') {
                    @if (canManage()) {
                      <span class="flex justify-end">
                        <app-button size="sm" variant="secondary" (click)="toggle(row.unit)">
                          {{ row.unit.active ? 'Inactivar' : 'Reactivar' }}
                        </app-button>
                      </span>
                    }
                  }
                }
              </ng-template>
            </app-table>
          }
        </app-card>

        @if (selectedOrg(); as org) {
          <app-team-panel [units]="unitList()" />
          <app-cost-centers-panel [organizationId]="org.id" />
        }
      }
    }

    <app-dialog [open]="creating()" title="Nova unidade" (closed)="creating.set(false)">
      <form [formGroup]="form" (ngSubmit)="create()" novalidate class="space-y-3">
        <app-input label="Código" formControlName="code" [required]="true" />
        <app-input label="Nome" formControlName="name" [required]="true" />
        <app-select
          label="Tipo"
          formControlName="type"
          placeholder="Tipo"
          [options]="typeOptions"
        />
        <app-select
          label="Unidade superior"
          formControlName="parentId"
          placeholder="Nenhuma (raiz)"
          [options]="parentOptions()"
        />
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Criar</app-button>
        </div>
      </form>
    </app-dialog>
  `,
})
export class TenantOrganization {
  private readonly api = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('organization.manage'));

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Unidade' },
    { key: 'code', label: 'Código' },
    { key: 'type', label: 'Tipo' },
    { key: 'active', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly typeOptions = UNIT_TYPES;

  protected readonly organizations = rxResource({
    params: () => this.tenant()?.id,
    stream: () => this.api.listOrganizations(),
  });

  protected readonly orgControl = inject(NonNullableFormBuilder).control('');
  private readonly selectedId = signal<string | null>(null);

  protected readonly orgOptions = computed(() =>
    (this.organizations.hasValue() ? this.organizations.value() : []).map((o) => ({
      value: o.id,
      label: `${o.code} — ${o.legalName}`,
    })),
  );

  /** A organização escolhida; por omissão a primeira (a escolha é sempre dentro do tenant activo). */
  protected readonly selectedOrg = computed(() => {
    const list = this.organizations.hasValue() ? this.organizations.value() : [];
    return list.find((o) => o.id === this.selectedId()) ?? list[0] ?? null;
  });

  protected readonly units = rxResource({
    params: () => {
      const org = this.selectedOrg();
      const tenant = this.tenant();
      return org && tenant ? { tenantId: tenant.id, organizationId: org.id } : undefined;
    },
    stream: ({ params }) => this.api.listUnits(params.organizationId),
  });

  protected readonly rows = computed(() =>
    buildUnitRows(this.units.hasValue() ? this.units.value() : []),
  );
  protected readonly unitList = computed(() => (this.units.hasValue() ? this.units.value() : []));
  protected readonly parentOptions = computed(() =>
    this.rows().map(({ unit, depth }) => ({
      value: unit.id,
      label: `${'— '.repeat(depth)}${unit.code} ${unit.name}`,
    })),
  );

  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly form = inject(NonNullableFormBuilder).group({
    code: ['', [Validators.required, Validators.maxLength(40)]],
    name: ['', [Validators.required, Validators.maxLength(160)]],
    type: ['OTHER'],
    parentId: [''],
  });

  constructor() {
    this.orgControl.valueChanges.subscribe((id) => this.selectedId.set(id || null));
  }

  protected typeLabel(type: UnitType): string {
    return UNIT_TYPES.find((t) => t.value === type)?.label ?? type;
  }

  protected loadError(error: unknown): string {
    return errorMessage(error);
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.form.reset({ code: '', name: '', type: 'OTHER', parentId: '' });
    this.creating.set(true);
  }

  protected create(): void {
    const org = this.selectedOrg();
    if (!org) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    this.busy.set(true);
    this.api
      .createUnit({
        organizationId: org.id,
        parentId: value.parentId || null,
        code: value.code.trim(),
        name: value.name.trim(),
        type: value.type as UnitType,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.creating.set(false);
          this.notice.set('Unidade criada.');
          this.units.reload();
        },
        error: (error: ApiError) => this.showCreateError(error),
      });
  }

  protected toggle(unit: UnitDto): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.api.setUnitActive(unit, !unit.active).subscribe({
      next: () => {
        this.notice.set(unit.active ? 'Unidade inactivada.' : 'Unidade reactivada.');
        this.units.reload();
      },
      error: (error: ApiError) => {
        // Outro utilizador alterou a unidade: mostra o estado actual e pede para repetir.
        if (error.code === 'VERSION_CONFLICT') this.units.reload();
        this.actionError.set(
          error.code === 'VERSION_CONFLICT'
            ? 'A unidade foi alterada entretanto por outra pessoa. A lista foi actualizada; repita a operação.'
            : error.message,
        );
      },
    });
  }

  /** Conflitos e erros por campo ficam no campo certo; o resto no diálogo, sem o fechar. */
  private showCreateError(error: ApiError): void {
    const controls = this.form.controls;
    if (error.code === 'UNIT_CODE_TAKEN') {
      controls.code.setErrors({ server: { message: error.message } });
      controls.code.markAsTouched();
      return;
    }
    const byPath: Record<string, 'code' | 'name' | 'type' | 'parentId'> = {
      code: 'code',
      name: 'name',
      type: 'type',
      parentId: 'parentId',
    };
    let placed = false;
    for (const detail of error.fieldErrors ?? []) {
      const key = byPath[detail.path];
      if (key) {
        controls[key].setErrors({ server: { message: detail.message } });
        controls[key].markAsTouched();
        placed = true;
      }
    }
    if (!placed) {
      this.creating.set(false);
      this.actionError.set(error.message);
    }
  }
}
