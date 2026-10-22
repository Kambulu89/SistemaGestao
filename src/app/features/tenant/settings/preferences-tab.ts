import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { TENANT_PERMISSIONS } from '../../../core/permissions/permission.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { OrganizationApi } from '../data-access/organization.api';
import {
  SettingsApi,
  type EffectiveSettingDto,
  type ScopeRef,
  type SettingScope,
  type SettingValue,
} from '../data-access/settings.api';

const LEVEL_LABELS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' }> = {
  DEFAULT: { label: 'Predefinido', tone: 'neutral' },
  TENANT: { label: 'Tenant', tone: 'brand' },
  ORGANIZATION: { label: 'Organização', tone: 'brand' },
  BRANCH: { label: 'Filial', tone: 'brand' },
  MODULE: { label: 'Módulo', tone: 'brand' },
  MEMBERSHIP: { label: 'Pessoal', tone: 'success' },
};

type EditScope = Extract<SettingScope, 'TENANT' | 'ORGANIZATION' | 'MEMBERSHIP'>;

const SCOPE_LABELS: Record<EditScope, string> = {
  TENANT: 'Todo o tenant',
  ORGANIZATION: 'A organização seleccionada',
  MEMBERSHIP: 'Só para mim',
};

/**
 * Valores efectivos das configurações e de onde vêm (omissão < tenant < organização < filial < módulo <
 * pessoal). Cada chave declara os âmbitos que admite: as regras fiscais não admitem preferência pessoal.
 */
@Component({
  selector: 'app-settings-preferences',
  imports: [
    ReactiveFormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
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

    @if (organizations().length > 0) {
      <div class="mb-3 max-w-sm">
        <app-select
          label="Ver os valores para"
          [formControl]="organizationControl"
          [options]="organizationOptions()"
          placeholder="Todo o tenant"
        />
      </div>
    }

    <app-card [flush]="true">
      @if (effective.isLoading() && !effective.hasValue()) {
        <app-loading-state label="A carregar configurações…" />
      } @else if (effective.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as configurações">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (effective.value(); as list) {
        <app-table caption="Configurações" [columns]="columns" [rows]="list">
          <ng-template let-row let-column="column">
            @switch (column.key) {
              @case ('setting') {
                <span class="font-medium">{{ row.description }}</span>
                <code class="ms-2 text-xs text-fg-muted">{{ row.key }}</code>
                @if (row.category === 'FISCAL') {
                  <app-badge class="ms-1" tone="warning">Fiscal</app-badge>
                }
              }
              @case ('value') {
                {{ display(row.value) }}
              }
              @case ('source') {
                <app-badge [tone]="level(row.source.level).tone">{{
                  level(row.source.level).label
                }}</app-badge>
              }
              @case ('actions') {
                <span class="flex justify-end">
                  @if (scopesFor(row).length > 0) {
                    <app-button size="sm" variant="secondary" (click)="edit(row)"
                      >Alterar</app-button
                    >
                  }
                </span>
              }
            }
          </ng-template>
        </app-table>
      }
    </app-card>

    <app-dialog
      [open]="editing() !== null"
      [title]="editing() ? editing()!.description : ''"
      (closed)="editing.set(null)"
    >
      @if (editing(); as setting) {
        <form [formGroup]="form" (ngSubmit)="save()" novalidate class="space-y-3">
          <app-select
            label="Aplicar a"
            formControlName="scope"
            [required]="true"
            [options]="scopeOptions()"
          />
          @switch (setting.spec.type) {
            @case ('enum') {
              <app-select
                label="Valor"
                formControlName="value"
                [required]="true"
                [options]="valueOptions()"
              />
            }
            @case ('boolean') {
              <app-select
                label="Valor"
                formControlName="value"
                [required]="true"
                [options]="booleanOptions"
              />
            }
            @case ('integer') {
              <app-input label="Valor" type="number" formControlName="value" [required]="true" />
            }
            @default {
              <app-input label="Valor" formControlName="value" [required]="true" />
            }
          }
          @if (setting.category === 'FISCAL') {
            <p class="text-xs text-fg-muted">
              Regra fiscal: só admite tenant e organização; preferências pessoais não se aplicam.
            </p>
          }
          <div class="flex justify-between gap-2 pt-2">
            <app-button
              variant="ghost"
              [disabled]="!hasStoredValue()"
              [loading]="busy()"
              (click)="reset()"
              >Repor herança</app-button
            >
            <span class="flex gap-2">
              <app-button variant="secondary" (click)="editing.set(null)">Cancelar</app-button>
              <app-button type="submit" [loading]="busy()">Guardar</app-button>
            </span>
          </div>
        </form>
      }
    </app-dialog>
  `,
})
export class PreferencesTab {
  private readonly api = inject(SettingsApi);
  private readonly organizationApi = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly columns: readonly TableColumn[] = [
    { key: 'setting', label: 'Configuração' },
    { key: 'value', label: 'Valor efectivo' },
    { key: 'source', label: 'Origem' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly booleanOptions: readonly SelectOption[] = [
    { value: 'true', label: 'Sim' },
    { value: 'false', label: 'Não' },
  ];

  protected readonly canManage = computed(() =>
    this.permissions.can(TENANT_PERMISSIONS.settingsManage),
  );
  protected readonly organizationControl = new FormControl('', { nonNullable: true });
  protected readonly organizationId = toSignal(this.organizationControl.valueChanges, {
    initialValue: '',
  });

  private readonly orgs = rxResource({
    params: () =>
      this.permissions.can(TENANT_PERMISSIONS.organizationRead) ? this.tenantId()?.id : undefined,
    stream: () => this.organizationApi.listOrganizations(),
  });
  protected readonly organizations = computed(() =>
    this.orgs.hasValue() ? this.orgs.value() : [],
  );
  protected readonly organizationOptions = computed<readonly SelectOption[]>(() =>
    this.organizations().map((o) => ({ value: o.id, label: o.tradeName ?? o.legalName })),
  );

  protected readonly effective = rxResource({
    params: () => ({ tenant: this.tenantId()?.id, organizationId: this.organizationId() }),
    stream: ({ params }) =>
      this.api.effective(params.organizationId ? { organizationId: params.organizationId } : {}),
  });
  protected readonly loadError = computed(() => errorMessage(this.effective.error()));

  // Versões dos valores guardados (só quem pode ler as configurações as vê).
  private readonly stored = rxResource({
    params: () =>
      this.permissions.can(TENANT_PERMISSIONS.settingsRead) ? this.tenantId()?.id : undefined,
    stream: () => this.api.listValues(),
  });

  protected readonly editing = signal<EffectiveSettingDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly form = inject(NonNullableFormBuilder).group({
    scope: ['TENANT' as EditScope, Validators.required],
    value: ['', Validators.required],
  });
  private readonly selectedScope = toSignal(this.form.controls.scope.valueChanges, {
    initialValue: 'TENANT' as EditScope,
  });

  protected level(level: string) {
    return LEVEL_LABELS[level] ?? LEVEL_LABELS['DEFAULT']!;
  }

  protected display(value: SettingValue): string {
    return typeof value === 'boolean' ? (value ? 'Sim' : 'Não') : String(value);
  }

  /** Âmbitos em que o utilizador pode definir a chave: o que a chave admite ∩ o que as suas permissões dão. */
  protected scopesFor(setting: EffectiveSettingDto): readonly EditScope[] {
    const allowed = new Set(setting.allowedScopes);
    const scopes: EditScope[] = [];
    if (this.canManage() && allowed.has('TENANT')) scopes.push('TENANT');
    if (this.canManage() && allowed.has('ORGANIZATION') && this.organizationId()) {
      scopes.push('ORGANIZATION');
    }
    if (allowed.has('MEMBERSHIP')) scopes.push('MEMBERSHIP');
    return scopes;
  }

  protected readonly scopeOptions = computed<readonly SelectOption[]>(() => {
    const setting = this.editing();
    return setting
      ? this.scopesFor(setting).map((scope) => ({ value: scope, label: SCOPE_LABELS[scope] }))
      : [];
  });

  protected readonly valueOptions = computed<readonly SelectOption[]>(() => {
    const spec = this.editing()?.spec;
    return spec?.type === 'enum' ? spec.options.map((o) => ({ value: o, label: o })) : [];
  });

  protected readonly hasStoredValue = computed(() => {
    const setting = this.editing();
    return setting ? this.existing(setting, this.selectedScope()) !== null : false;
  });

  protected edit(setting: EffectiveSettingDto): void {
    this.clearMessages();
    const scope = this.scopesFor(setting)[0] ?? 'MEMBERSHIP';
    this.form.reset({ scope, value: String(setting.value) });
    this.editing.set(setting);
  }

  /** O valor guardado neste âmbito (se existir), com a sua versão. */
  private existing(setting: EffectiveSettingDto, scope: EditScope): { version: number } | null {
    if (scope === 'MEMBERSHIP' && setting.source.level === 'MEMBERSHIP') {
      return { version: setting.source.version ?? 1 };
    }
    const scopeId = scope === 'ORGANIZATION' ? this.organizationId() : null;
    const row = (this.stored.hasValue() ? this.stored.value() : []).find(
      (v) =>
        v.key === setting.key &&
        v.scopeType === scope &&
        v.moduleCode === null &&
        (scope === 'MEMBERSHIP' ? true : v.scopeId === scopeId),
    );
    return row ? { version: row.version } : null;
  }

  private parse(setting: EffectiveSettingDto, raw: string): SettingValue {
    if (setting.spec.type === 'boolean') return raw === 'true';
    if (setting.spec.type === 'integer') return Number(raw);
    return raw;
  }

  protected save(): void {
    const setting = this.editing();
    if (!setting) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { scope, value } = this.form.getRawValue();
    const parsed = this.parse(setting, value);
    const version = this.existing(setting, scope)?.version;
    const call =
      scope === 'MEMBERSHIP'
        ? this.api.setPersonal(setting.key, parsed, version)
        : this.api.setValue(setting.key, this.scopeRef(scope), parsed, version);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.editing.set(null);
        this.notice.set('Configuração guardada.');
        this.refresh();
      },
      error: (error: ApiError) => this.fail(error, setting),
    });
  }

  protected reset(): void {
    const setting = this.editing();
    if (!setting) return;
    const scope = this.form.getRawValue().scope;
    this.busy.set(true);
    const call =
      scope === 'MEMBERSHIP'
        ? this.api.resetPersonal(setting.key)
        : this.api.resetValue(setting.key, this.scopeRef(scope));
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.editing.set(null);
        this.notice.set('Herança reposta.');
        this.refresh();
      },
      error: (error: ApiError) => this.fail(error, setting),
    });
  }

  private scopeRef(scope: Exclude<EditScope, 'MEMBERSHIP'>): ScopeRef {
    return scope === 'ORGANIZATION'
      ? { scopeType: 'ORGANIZATION', scopeId: this.organizationId() }
      : { scopeType: 'TENANT' };
  }

  private refresh(): void {
    this.effective.reload();
    this.stored.reload();
  }

  private fail(error: ApiError, setting: EffectiveSettingDto): void {
    this.editing.set(null);
    this.refresh();
    this.actionError.set(
      error.code === 'VERSION_CONFLICT' || error.code === 'VERSION_REQUIRED'
        ? `${setting.description}: o valor foi alterado entretanto. A lista foi actualizada; repita a operação.`
        : error.code === 'SCOPE_NOT_ALLOWED'
          ? 'Esta configuração não admite esse âmbito.'
          : error.message,
    );
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
