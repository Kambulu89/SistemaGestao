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
import { SettingsApi, type SequenceDto } from '../data-access/settings.api';

/**
 * Sequências de numeração por organização, filial, documento, série e período. O modelo usa só os tokens
 * `{YYYY} {YY} {MM} {SERIES} {ORG} {BRANCH}`; a pré-visualização não consome números e o próximo número só sobe.
 */
@Component({
  selector: 'app-settings-sequences',
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
          description="As sequências pertencem a uma organização (entidade legal), para não misturar documentos."
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
          <app-button (click)="openCreate()">Nova sequência</app-button>
        }
      </div>

      <app-card [flush]="true">
        @if (sequences.isLoading() && !sequences.hasValue()) {
          <app-loading-state label="A carregar sequências…" />
        } @else if (sequences.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as sequências">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (sequences.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="settings" title="Ainda não há sequências nesta organização" />
          } @else {
            <app-table caption="Sequências de numeração" [columns]="columns" [rows]="list">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('document') {
                    <span class="font-medium">{{ row.documentType }}</span>
                    <span class="block text-xs text-fg-muted">
                      série {{ row.series }} · período {{ row.period
                      }}{{ row.branchId ? ' · filial' : '' }}
                    </span>
                  }
                  @case ('template') {
                    <code>{{ row.prefixTemplate }}</code>
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

    <app-dialog [open]="creating()" title="Nova sequência" (closed)="creating.set(false)">
      <form [formGroup]="createForm" (ngSubmit)="create()" novalidate class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <app-input
            label="Tipo de documento"
            formControlName="documentType"
            [required]="true"
            hint="Ex.: INVOICE"
          />
          <app-input label="Série" formControlName="series" [required]="true" hint="Ex.: A" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <app-input
            label="Período"
            formControlName="period"
            [required]="true"
            hint="ALL, 2026 ou 2026-03"
          />
          <app-select
            label="Filial (opcional)"
            formControlName="branchId"
            placeholder="Toda a organização"
            [options]="branchOptions()"
          />
        </div>
        <app-input
          label="Modelo do prefixo"
          formControlName="prefixTemplate"
          [required]="true"
          hint="Tokens: {YYYY} {YY} {MM} {SERIES} {ORG} {BRANCH}"
        />
        <div class="grid grid-cols-2 gap-3">
          <app-input label="Próximo número" formControlName="nextValue" [required]="true" />
          <app-input
            label="Preenchimento (1–12)"
            type="number"
            formControlName="padding"
            [required]="true"
            min="1"
            max="12"
          />
        </div>
        <p class="text-sm" aria-live="polite">
          @if (previewError(); as text) {
            <span class="text-red-600 dark:text-red-400">{{ text }}</span>
          } @else if (example(); as text) {
            Pré-visualização: <code class="font-semibold">{{ text }}</code>
          }
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="ghost" (click)="previewCreate()">Pré-visualizar</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Criar</app-button>
        </div>
      </form>
    </app-dialog>

    <app-dialog
      [open]="editing() !== null"
      [title]="editing() ? 'Alterar ' + editing()!.documentType + ' ' + editing()!.series : ''"
      (closed)="editing.set(null)"
    >
      <form [formGroup]="editForm" (ngSubmit)="saveEdit()" novalidate class="space-y-3">
        <app-input label="Modelo do prefixo" formControlName="prefixTemplate" [required]="true" />
        <div class="grid grid-cols-2 gap-3">
          <app-input
            label="Próximo número"
            formControlName="nextValue"
            [required]="true"
            hint="Só pode subir: números emitidos nunca se reutilizam."
          />
          <app-input
            label="Preenchimento (1–12)"
            type="number"
            formControlName="padding"
            [required]="true"
            min="1"
            max="12"
          />
        </div>
        <p class="text-sm" aria-live="polite">
          @if (previewError(); as text) {
            <span class="text-red-600 dark:text-red-400">{{ text }}</span>
          } @else if (example(); as text) {
            Pré-visualização: <code class="font-semibold">{{ text }}</code>
          }
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="ghost" (click)="previewEdit()">Pré-visualizar</app-button>
          <app-button variant="secondary" (click)="editing.set(null)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Guardar</app-button>
        </div>
      </form>
    </app-dialog>
  `,
})
export class SequencesTab {
  private readonly api = inject(SettingsApi);
  private readonly organizationApi = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly columns: readonly TableColumn[] = [
    { key: 'document', label: 'Documento' },
    { key: 'template', label: 'Modelo' },
    { key: 'nextValue', label: 'Próximo' },
    { key: 'padding', label: 'Preenchimento' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];

  protected readonly canManage = computed(() =>
    this.permissions.can(TENANT_PERMISSIONS.sequencesManage),
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

  private readonly branches = rxResource({
    params: () => ({ tenant: this.tenantId()?.id, organizationId: this.organizationId() }),
    stream: ({ params }) =>
      params.organizationId ? this.organizationApi.listUnits(params.organizationId) : of([]),
  });
  protected readonly branchOptions = computed<readonly SelectOption[]>(() =>
    (this.branches.hasValue() ? this.branches.value() : [])
      .filter((u) => u.type === 'BRANCH')
      .map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` })),
  );

  protected readonly sequences = rxResource({
    params: () => ({ tenant: this.tenantId()?.id, organizationId: this.organizationId() }),
    stream: ({ params }) =>
      params.organizationId
        ? this.api.listSequences({ organizationId: params.organizationId })
        : of([]),
  });
  protected readonly loadError = computed(() => errorMessage(this.sequences.error()));

  protected readonly creating = signal(false);
  protected readonly editing = signal<SequenceDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly example = signal<string | null>(null);
  protected readonly previewError = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly createForm = this.fb.group({
    documentType: ['', [Validators.required, Validators.pattern(/^[A-Z][A-Z0-9_]{1,49}$/)]],
    series: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/)]],
    period: [
      'ALL',
      [Validators.required, Validators.pattern(/^(ALL|\d{4}|\d{4}-(0[1-9]|1[0-2]))$/)],
    ],
    branchId: [''],
    prefixTemplate: ['', [Validators.required, Validators.maxLength(100)]],
    nextValue: ['1', [Validators.required, Validators.pattern(/^[1-9]\d{0,18}$/)]],
    padding: [6, [Validators.required, Validators.min(1), Validators.max(12)]],
  });
  protected readonly editForm = this.fb.group({
    prefixTemplate: ['', [Validators.required, Validators.maxLength(100)]],
    nextValue: ['1', [Validators.required, Validators.pattern(/^[1-9]\d{0,18}$/)]],
    padding: [6, [Validators.required, Validators.min(1), Validators.max(12)]],
  });

  protected openCreate(): void {
    this.clearMessages();
    this.createForm.reset({ period: 'ALL', nextValue: '1', padding: 6 });
    this.creating.set(true);
  }

  protected previewCreate(): void {
    const v = this.createForm.getRawValue();
    this.preview({
      series: v.series || 'A',
      branchId: v.branchId || null,
      prefixTemplate: v.prefixTemplate,
      padding: v.padding,
      nextValue: v.nextValue,
    });
  }

  protected previewEdit(): void {
    const sequence = this.editing();
    if (!sequence) return;
    const v = this.editForm.getRawValue();
    this.preview({
      series: sequence.series,
      branchId: sequence.branchId,
      prefixTemplate: v.prefixTemplate,
      padding: v.padding,
      nextValue: v.nextValue,
    });
  }

  /** Só renderiza o formato no servidor; nenhum número é consumido. */
  private preview(input: {
    series: string;
    branchId: string | null;
    prefixTemplate: string;
    padding: number;
    nextValue: string;
  }): void {
    this.example.set(null);
    this.previewError.set(null);
    this.api.previewSequence({ organizationId: this.organizationId(), ...input }).subscribe({
      next: (result) => this.example.set(result.example),
      error: (error: ApiError) =>
        this.previewError.set(error.fieldErrors?.[0]?.message ?? error.message),
    });
  }

  protected create(): void {
    if (this.createForm.invalid) {
      this.createForm.markAllAsTouched();
      return;
    }
    const v = this.createForm.getRawValue();
    this.busy.set(true);
    this.api
      .createSequence({
        organizationId: this.organizationId(),
        branchId: v.branchId || null,
        documentType: v.documentType.trim(),
        series: v.series.trim(),
        period: v.period.trim(),
        prefixTemplate: v.prefixTemplate,
        nextValue: v.nextValue.trim(),
        padding: v.padding,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.creating.set(false);
          this.notice.set('Sequência criada.');
          this.sequences.reload();
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
          this.actionError.set(
            error.code === 'SEQUENCE_EXISTS'
              ? 'Já existe uma sequência para esta organização, filial, documento, série e período.'
              : error.message,
          );
        },
      });
  }

  protected openEdit(sequence: SequenceDto): void {
    this.clearMessages();
    this.editForm.reset({
      prefixTemplate: sequence.prefixTemplate,
      nextValue: sequence.nextValue,
      padding: sequence.padding,
    });
    this.editing.set(sequence);
  }

  protected saveEdit(): void {
    const sequence = this.editing();
    if (!sequence) return;
    if (this.editForm.invalid) {
      this.editForm.markAllAsTouched();
      return;
    }
    const v = this.editForm.getRawValue();
    this.busy.set(true);
    this.api
      .updateSequence(sequence.id, {
        expectedVersion: sequence.version,
        prefixTemplate: v.prefixTemplate,
        padding: v.padding,
        nextValue: v.nextValue.trim(),
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.editing.set(null);
          this.notice.set('Sequência actualizada.');
          this.sequences.reload();
        },
        error: (error: ApiError) => {
          const field = error.fieldErrors?.find((d) => d.path in this.editForm.controls);
          if (field) {
            const control =
              this.editForm.controls[field.path as keyof typeof this.editForm.controls];
            control.setErrors({ server: { message: field.message } });
            control.markAsTouched();
            return;
          }
          this.editing.set(null);
          this.sequences.reload();
          this.actionError.set(
            error.code === 'VERSION_CONFLICT'
              ? 'A sequência foi alterada entretanto (podem ter sido emitidos números). A lista foi actualizada; repita a operação.'
              : error.message,
          );
        },
      });
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.example.set(null);
    this.previewError.set(null);
  }
}
