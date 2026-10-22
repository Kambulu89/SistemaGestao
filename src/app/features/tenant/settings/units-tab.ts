import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { TENANT_PERMISSIONS } from '../../../core/permissions/permission.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { SettingsApi, type ConversionDto, type UnitDto } from '../data-access/settings.api';

/**
 * Unidades de medida: bases e derivadas (factor sobre a base, mesma dimensão). A conversão é exacta e só
 * existe entre dimensões compatíveis; dimensão, base e factor não mudam depois de criados.
 */
@Component({
  selector: 'app-settings-units',
  imports: [
    ReactiveFormsModule,
    Alert,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }

    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-base font-semibold">Unidades</h2>
      @if (canManage()) {
        <app-button (click)="openCreate()">Nova unidade</app-button>
      }
    </div>

    <app-card [flush]="true">
      @if (units.isLoading() && !units.hasValue()) {
        <app-loading-state label="A carregar unidades…" />
      } @else if (units.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as unidades">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (units.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="cube" title="Ainda não há unidades de medida" />
        } @else {
          <app-table caption="Unidades de medida" [columns]="columns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('code') {
                  <span class="font-medium">{{ row.code }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.name }}</span>
                }
                @case ('base') {
                  {{ baseOf(row) }}
                }
                @case ('actions') {
                  @if (canManage()) {
                    <span class="flex justify-end">
                      <app-button size="sm" variant="secondary" (click)="openEdit(row)"
                        >Alterar</app-button
                      >
                    </span>
                  }
                }
                @default {
                  {{ row[column.key] }}
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if ((units.hasValue() ? units.value().length : 0) > 1) {
      <h2 class="mb-3 mt-8 text-base font-semibold">Conversão</h2>
      <app-card>
        <form
          [formGroup]="convertForm"
          (ngSubmit)="convert()"
          novalidate
          class="grid gap-3 sm:grid-cols-4 sm:items-end"
        >
          <app-input label="Quantidade" formControlName="quantity" [required]="true" />
          <app-select
            label="De"
            formControlName="from"
            [required]="true"
            [options]="unitOptions()"
          />
          <app-select
            label="Para"
            formControlName="to"
            [required]="true"
            [options]="unitOptions()"
          />
          <app-button type="submit" [loading]="converting()">Converter</app-button>
        </form>
        @if (conversionError(); as text) {
          <app-alert tone="danger" class="mt-3 block">{{ text }}</app-alert>
        }
        @if (conversion(); as c) {
          <p class="mt-3 text-sm" aria-live="polite">
            {{ c.quantity }} {{ c.from }} = <strong>{{ c.result }} {{ c.to }}</strong>
          </p>
        }
      </app-card>
    }

    <app-dialog [open]="creating()" title="Nova unidade" (closed)="creating.set(false)">
      <form [formGroup]="createForm" (ngSubmit)="create()" novalidate class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <app-input label="Código" formControlName="code" [required]="true" hint="Ex.: KG" />
          <app-input label="Nome" formControlName="name" [required]="true" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <app-input
            label="Dimensão"
            formControlName="dimension"
            [required]="true"
            hint="Ex.: MASS"
          />
          <app-input
            label="Casas decimais"
            type="number"
            formControlName="precision"
            [required]="true"
            min="0"
            max="6"
          />
        </div>
        <app-select
          label="Unidade base (opcional)"
          formControlName="baseUnitId"
          placeholder="É uma unidade base"
          [options]="baseOptions()"
        />
        @if (createForm.controls.baseUnitId.value) {
          <app-input
            label="Factor"
            formControlName="factor"
            hint="Obrigatório. 1 destas unidades = factor × unidade base. Ex.: 0.001"
          />
        }
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Criar</app-button>
        </div>
      </form>
    </app-dialog>

    <app-dialog
      [open]="editing() !== null"
      [title]="editing() ? 'Alterar ' + editing()!.code : ''"
      (closed)="editing.set(null)"
    >
      <form [formGroup]="editForm" (ngSubmit)="saveEdit()" novalidate class="space-y-3">
        <app-input label="Nome" formControlName="name" [required]="true" />
        <app-input
          label="Casas decimais"
          type="number"
          formControlName="precision"
          [required]="true"
          min="0"
          max="6"
        />
        <p class="text-xs text-fg-muted">A dimensão, a base e o factor não se alteram.</p>
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="editing.set(null)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Guardar</app-button>
        </div>
      </form>
    </app-dialog>
  `,
})
export class UnitsTab {
  private readonly api = inject(SettingsApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly columns: readonly TableColumn[] = [
    { key: 'code', label: 'Unidade' },
    { key: 'dimension', label: 'Dimensão' },
    { key: 'precision', label: 'Casas' },
    { key: 'base', label: 'Base' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];

  protected readonly canManage = computed(() =>
    this.permissions.can(TENANT_PERMISSIONS.settingsManage),
  );
  protected readonly units = rxResource({
    params: () => this.tenantId()?.id,
    stream: () => this.api.listUnits(),
  });
  protected readonly loadError = computed(() => errorMessage(this.units.error()));
  private readonly all = computed(() => (this.units.hasValue() ? this.units.value() : []));

  protected readonly unitOptions = computed<readonly SelectOption[]>(() =>
    this.all().map((u) => ({ value: u.code, label: `${u.code} — ${u.name}` })),
  );
  /** Só unidades base servem de base (sem cadeias). */
  protected readonly baseOptions = computed<readonly SelectOption[]>(() =>
    this.all()
      .filter((u) => u.baseUnitId === null)
      .map((u) => ({ value: u.id, label: `${u.code} — ${u.dimension}` })),
  );

  protected readonly creating = signal(false);
  protected readonly editing = signal<UnitDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly converting = signal(false);
  protected readonly conversion = signal<ConversionDto | null>(null);
  protected readonly conversionError = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly createForm = this.fb.group({
    code: ['', [Validators.required, Validators.maxLength(20)]],
    name: ['', [Validators.required, Validators.maxLength(120)]],
    dimension: ['', [Validators.required, Validators.pattern(/^[A-Z][A-Z_]{1,29}$/)]],
    precision: [0, [Validators.required, Validators.min(0), Validators.max(6)]],
    baseUnitId: [''],
    factor: [''],
  });
  protected readonly editForm = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    precision: [0, [Validators.required, Validators.min(0), Validators.max(6)]],
  });
  protected readonly convertForm = this.fb.group({
    quantity: ['1', [Validators.required, Validators.pattern(/^\d{1,13}(\.\d{1,6})?$/)]],
    from: ['', Validators.required],
    to: ['', Validators.required],
  });

  protected baseOf(unit: UnitDto): string {
    if (!unit.baseUnitId) return 'Unidade base';
    const base = this.all().find((u) => u.id === unit.baseUnitId);
    return `${unit.factor} × ${base?.code ?? '?'}`;
  }

  protected openCreate(): void {
    this.clearMessages();
    this.createForm.reset({ precision: 0 });
    this.creating.set(true);
  }

  protected create(): void {
    // O factor só é obrigatório para unidades derivadas: recalcula-se aqui, sem erros herdados de uma tentativa anterior.
    this.createForm.controls.factor.updateValueAndValidity();
    const v = this.createForm.getRawValue();
    const missingFactor = !!v.baseUnitId && !(v.factor ?? '').trim();
    if (this.createForm.invalid || missingFactor) {
      this.createForm.markAllAsTouched();
      if (missingFactor) this.createForm.controls.factor.setErrors({ required: true });
      return;
    }
    this.busy.set(true);
    this.api
      .createUnit({
        code: v.code.trim(),
        name: v.name.trim(),
        dimension: v.dimension.trim(),
        precision: v.precision,
        baseUnitId: v.baseUnitId || null,
        conversionFactor: v.baseUnitId ? v.factor.trim() : null,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.creating.set(false);
          this.notice.set('Unidade criada.');
          this.units.reload();
        },
        error: (error: ApiError) => {
          const field = error.fieldErrors?.find((d) =>
            ['code', 'name', 'dimension', 'precision', 'factor'].includes(d.path),
          );
          if (field) {
            const control =
              this.createForm.controls[field.path as keyof typeof this.createForm.controls];
            control.setErrors({ server: { message: field.message } });
            control.markAsTouched();
            return;
          }
          this.creating.set(false);
          this.actionError.set(
            error.code === 'UNIT_CODE_TAKEN'
              ? 'Já existe uma unidade com esse código.'
              : error.message,
          );
        },
      });
  }

  protected openEdit(unit: UnitDto): void {
    this.clearMessages();
    this.editForm.reset({ name: unit.name, precision: unit.precision });
    this.editing.set(unit);
  }

  protected saveEdit(): void {
    const unit = this.editing();
    if (!unit) return;
    if (this.editForm.invalid) {
      this.editForm.markAllAsTouched();
      return;
    }
    const v = this.editForm.getRawValue();
    this.busy.set(true);
    this.api
      .updateUnit(unit.id, {
        expectedVersion: unit.version,
        name: v.name.trim(),
        precision: v.precision,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.editing.set(null);
          this.notice.set('Unidade actualizada.');
          this.units.reload();
        },
        error: (error: ApiError) => {
          this.editing.set(null);
          this.units.reload();
          this.actionError.set(
            error.code === 'VERSION_CONFLICT'
              ? 'A unidade foi alterada entretanto. A lista foi actualizada; repita a operação.'
              : error.message,
          );
        },
      });
  }

  protected convert(): void {
    if (this.convertForm.invalid) {
      this.convertForm.markAllAsTouched();
      return;
    }
    const v = this.convertForm.getRawValue();
    this.conversion.set(null);
    this.conversionError.set(null);
    this.converting.set(true);
    this.api
      .convert(v.from, v.to, v.quantity.trim())
      .pipe(finalize(() => this.converting.set(false)))
      .subscribe({
        next: (result) => this.conversion.set(result),
        error: (error: ApiError) =>
          this.conversionError.set(
            error.fieldErrors?.[0]?.code === 'INCOMPATIBLE_DIMENSIONS'
              ? error.fieldErrors[0].message
              : error.message,
          ),
      });
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
