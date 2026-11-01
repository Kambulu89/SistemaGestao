import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { finalize, of } from 'rxjs';
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
import { OrganizationApi } from '../data-access/organization.api';
import { SettingsApi, type TaxRateDto } from '../data-access/settings.api';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Taxas de imposto por organização, com intervalo de validade. Períodos sobrepostos para o mesmo código
 * são rejeitados; a taxa não se altera (é copiada para os documentos emitidos): fecha-se o período e cria-se outra.
 */
@Component({
  selector: 'app-settings-tax-rates',
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

    @if (organizations().length === 0) {
      <app-card>
        <app-empty-state
          icon="building"
          title="Sem organizações"
          description="Os impostos pertencem a uma organização (entidade legal). Crie primeiro uma organização."
        />
      </app-card>
    } @else {
      <div class="mb-3 flex items-end justify-between gap-3">
        <div class="w-72">
          <app-select
            label="Organização"
            [formControl]="organizationControl"
            [options]="organizationOptions()"
          />
        </div>
        @if (canManage()) {
          <app-button (click)="openCreate()">Nova taxa</app-button>
        }
      </div>

      <app-card [flush]="true">
        @if (rates.isLoading() && !rates.hasValue()) {
          <app-loading-state label="A carregar taxas…" />
        } @else if (rates.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as taxas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (rates.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="card" title="Ainda não há taxas nesta organização" />
          } @else {
            <app-table caption="Taxas de imposto" [columns]="columns" [rows]="list">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('code') {
                    <span class="font-medium">{{ row.code }}</span>
                    <span class="block text-xs text-fg-muted">{{ row.name }}</span>
                  }
                  @case ('rate') {
                    {{ row.rate }} %
                    @if (row.exemptionReason) {
                      <span class="block text-xs text-fg-muted">{{ row.exemptionReason }}</span>
                    }
                  }
                  @case ('period') {
                    {{ row.validFrom }} → {{ row.validTo ?? 'sem fim' }}
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
    }

    <app-dialog [open]="creating()" title="Nova taxa" (closed)="creating.set(false)">
      <form [formGroup]="createForm" (ngSubmit)="create()" novalidate class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <app-input label="Código" formControlName="code" [required]="true" hint="Ex.: IVA" />
          <app-input
            label="Taxa (%)"
            formControlName="rate"
            [required]="true"
            hint="Decimal, ex.: 14"
          />
        </div>
        <app-input label="Nome" formControlName="name" [required]="true" />
        <app-input label="Categoria" formControlName="category" [required]="true" hint="Ex.: VAT" />
        <div class="grid grid-cols-2 gap-3">
          <app-input
            label="Válida desde"
            type="date"
            formControlName="validFrom"
            [required]="true"
          />
          <app-input label="Válida até (opcional)" type="date" formControlName="validTo" />
        </div>
        <app-input
          label="Motivo da isenção"
          formControlName="exemptionReason"
          hint="Obrigatório para uma taxa zero."
        />
        <p class="text-xs text-fg-muted">
          A taxa não se altera depois de criada. Para mudar, feche o período desta e crie outra.
        </p>
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
        <app-input label="Categoria" formControlName="category" [required]="true" />
        <app-input
          label="Válida até"
          type="date"
          formControlName="validTo"
          hint="Fechar o período permite criar outra taxa a seguir."
        />
        <app-input label="Motivo da isenção" formControlName="exemptionReason" />
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="editing.set(null)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Guardar</app-button>
        </div>
      </form>
    </app-dialog>
  `,
})
export class TaxRatesTab {
  private readonly api = inject(SettingsApi);
  private readonly organizationApi = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly columns: readonly TableColumn[] = [
    { key: 'code', label: 'Taxa' },
    { key: 'rate', label: 'Valor' },
    { key: 'category', label: 'Categoria' },
    { key: 'period', label: 'Validade' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];

  protected readonly canManage = computed(() =>
    this.permissions.can(TENANT_PERMISSIONS.settingsManage),
  );

  private readonly orgs = rxResource({
    params: () => this.tenantId()?.id,
    stream: () => this.organizationApi.listOrganizations(),
  });
  protected readonly organizations = computed(() =>
    this.orgs.hasValue() ? this.orgs.value() : [],
  );
  protected readonly organizationOptions = computed<readonly SelectOption[]>(() =>
    this.organizations().map((o) => ({ value: o.id, label: o.tradeName ?? o.legalName })),
  );
  protected readonly organizationControl = new FormControl('', { nonNullable: true });
  private readonly picked = toSignal(this.organizationControl.valueChanges, { initialValue: '' });
  /** A organização escolhida, ou a primeira por omissão. */
  protected readonly organizationId = computed(
    () => this.picked() || this.organizations()[0]?.id || '',
  );

  constructor() {
    // O selector mostra a organização efectivamente usada (a primeira, por omissão) em vez de um marcador vazio.
    effect(() => {
      const first = this.organizations()[0]?.id;
      if (first && !this.organizationControl.value) this.organizationControl.setValue(first);
    });
  }

  protected readonly rates = rxResource({
    params: () => ({ tenant: this.tenantId()?.id, organizationId: this.organizationId() }),
    stream: ({ params }) =>
      params.organizationId
        ? this.api.listTaxRates({ organizationId: params.organizationId })
        : of([]),
  });
  protected readonly loadError = computed(() => errorMessage(this.rates.error()));

  protected readonly creating = signal(false);
  protected readonly editing = signal<TaxRateDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly createForm = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/)]],
    name: ['', [Validators.required, Validators.maxLength(160)]],
    rate: ['', [Validators.required, Validators.pattern(/^\d{1,5}(\.\d{1,4})?$/)]],
    category: ['', [Validators.required, Validators.maxLength(50)]],
    validFrom: ['', [Validators.required, Validators.pattern(DATE)]],
    validTo: [''],
    exemptionReason: [''],
  });
  protected readonly editForm = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(160)]],
    category: ['', [Validators.required, Validators.maxLength(50)]],
    validTo: [''],
    exemptionReason: [''],
  });

  protected openCreate(): void {
    this.clearMessages();
    this.createForm.reset();
    this.creating.set(true);
  }

  protected create(): void {
    if (this.createForm.invalid) {
      this.createForm.markAllAsTouched();
      return;
    }
    const v = this.createForm.getRawValue();
    this.busy.set(true);
    this.api
      .createTaxRate({
        organizationId: this.organizationId(),
        code: v.code.trim().toUpperCase(),
        name: v.name.trim(),
        rate: v.rate.trim(),
        validFrom: v.validFrom,
        validTo: v.validTo || null,
        category: v.category.trim(),
        exemptionReason: v.exemptionReason.trim() || null,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.creating.set(false);
          this.notice.set('Taxa criada.');
          this.rates.reload();
        },
        error: (error: ApiError) => {
          const field = error.fieldErrors?.find((d) => d.path in this.createForm.controls);
          if (field) {
            const control =
              this.createForm.controls[field.path as keyof typeof this.createForm.controls];
            control.setErrors({ server: { message: field.message } });
            control.markAsTouched();
            return;
          }
          this.creating.set(false);
          this.actionError.set(this.explain(error));
        },
      });
  }

  protected openEdit(rate: TaxRateDto): void {
    this.clearMessages();
    this.editForm.reset({
      name: rate.name,
      category: rate.category,
      validTo: rate.validTo ?? '',
      exemptionReason: rate.exemptionReason ?? '',
    });
    this.editing.set(rate);
  }

  protected saveEdit(): void {
    const rate = this.editing();
    if (!rate) return;
    if (this.editForm.invalid) {
      this.editForm.markAllAsTouched();
      return;
    }
    const v = this.editForm.getRawValue();
    this.busy.set(true);
    this.api
      .updateTaxRate(rate.id, {
        expectedVersion: rate.version,
        name: v.name.trim(),
        category: v.category.trim(),
        validTo: v.validTo || null,
        exemptionReason: v.exemptionReason.trim() || null,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.editing.set(null);
          this.notice.set('Taxa actualizada.');
          this.rates.reload();
        },
        error: (error: ApiError) => {
          this.editing.set(null);
          this.rates.reload();
          this.actionError.set(this.explain(error));
        },
      });
  }

  private explain(error: ApiError): string {
    switch (error.code) {
      case 'TAX_RATE_OVERLAP':
        return 'O período sobrepõe-se a outra taxa com o mesmo código nesta organização.';
      case 'VERSION_CONFLICT':
        return 'A taxa foi alterada entretanto. A lista foi actualizada; repita a operação.';
      default:
        return error.message;
    }
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
