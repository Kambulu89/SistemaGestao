import { DatePipe } from '@angular/common';
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
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select } from '../../../shared/ui/select/select';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import {
  ModulesApi,
  type FeatureDto,
  type FeatureReason,
  type ModuleDto,
  type TenantModuleStatus,
} from '../data-access/modules.api';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const STATUS: Record<TenantModuleStatus, { label: string; tone: Tone }> = {
  ENABLED: { label: 'Activo', tone: 'success' },
  DISABLED: { label: 'Desactivado', tone: 'neutral' },
  ENABLING: { label: 'A activar', tone: 'brand' },
  DISABLING: { label: 'A desactivar', tone: 'brand' },
  ERROR: { label: 'Erro na activação', tone: 'danger' },
};

const REASONS: Record<FeatureReason, string> = {
  NOT_LICENSED: 'O plano não inclui o módulo',
  FEATURE_NOT_LICENSED: 'O plano não inclui a funcionalidade',
  MODULE_DISABLED: 'O módulo está desactivado',
  FEATURE_OFF: 'Desligada',
};

const OVERRIDE_CHOICES = [
  { value: 'on', label: 'Ligar' },
  { value: 'off', label: 'Desligar' },
  { value: 'reset', label: 'Repor o valor por omissão' },
];

interface Activation {
  readonly module: ModuleDto;
}

/**
 * Registo de módulos do tenant (C03). O servidor decide a licença, as dependências e o acesso efectivo; aqui
 * mostra-se o estado e as acções, com o que é preciso saber antes de activar ou desactivar.
 */
@Component({
  selector: 'app-tenant-modules-page',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    PageHeader,
    Select,
    Textarea,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Módulos"
      description="Licenciado (plano), activo (decisão do tenant) e autorizado (o seu perfil) são coisas diferentes. Desactivar um módulo não apaga os seus dados."
    />

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">
        {{ text }}
        @for (line of errorDetails(); track line) {
          <span class="block text-sm">{{ line }}</span>
        }
      </app-alert>
    }

    @if (modules.isLoading() && !modules.hasValue()) {
      <app-loading-state label="A carregar módulos…" />
    } @else if (modules.error()) {
      <app-alert tone="danger" title="Não foi possível carregar os módulos">{{
        loadError()
      }}</app-alert>
    } @else if (modules.value(); as list) {
      @if (list.length === 0) {
        <app-empty-state icon="cube" title="Sem módulos no registo" />
      }
      <div class="space-y-4">
        @for (m of list; track m.code) {
          <app-card>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold">
                  {{ m.name }}
                  <code class="ms-1 text-xs font-normal text-fg-muted"
                    >{{ m.code }} · v{{ m.releaseVersion }}</code
                  >
                </h2>
                <p class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                  @if (m.kind === 'FOUNDATION') {
                    <app-badge tone="brand">Núcleo (sempre activo)</app-badge>
                  } @else {
                    <app-badge [tone]="status(m.status).tone">{{
                      status(m.status).label
                    }}</app-badge>
                    <app-badge [tone]="m.licensed ? 'success' : 'warning'">{{
                      m.licensed ? 'Licenciado' : 'Não licenciado'
                    }}</app-badge>
                  }
                  @if (m.registryStatus === 'DEPRECATED') {
                    <app-badge tone="danger">Descontinuado</app-badge>
                  }
                  @if (m.enabledAt) {
                    <span class="text-fg-muted">desde {{ m.enabledAt | date: 'dd/MM/yyyy' }}</span>
                  }
                </p>
                @if (m.requires.length > 0) {
                  <p class="mt-1 text-sm text-fg-muted">Requer: {{ requires(m) }}</p>
                }
              </div>
              @if (canManage() && m.kind === 'MODULE') {
                <div class="flex gap-1">
                  @if (m.status === 'ENABLED') {
                    <app-button size="sm" variant="secondary" (click)="askDisable(m)"
                      >Desactivar</app-button
                    >
                  } @else if (m.registryStatus === 'AVAILABLE') {
                    <app-button size="sm" [disabled]="!m.licensed" (click)="askEnable(m)">{{
                      m.status === 'ERROR' ? 'Tentar de novo' : 'Activar'
                    }}</app-button>
                  }
                </div>
              }
            </div>

            @if (m.lastError; as err) {
              <app-alert tone="danger" class="mt-3 block">{{ err }}</app-alert>
            }
            @if (m.kind === 'MODULE' && !m.licensed) {
              <p class="mt-2 text-sm text-fg-muted">O plano contratado não inclui este módulo.</p>
            }

            @if (m.features.length > 0) {
              <h3 class="mb-1 mt-4 text-sm font-semibold">Funcionalidades</h3>
              <ul
                class="divide-y divide-line text-sm"
                [attr.aria-label]="'Funcionalidades de ' + m.name"
              >
                @for (f of m.features; track f.code) {
                  <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {{ f.name }} <code class="text-xs text-fg-muted">{{ f.code }}</code>
                      @if (f.override !== null) {
                        <span class="ms-1 text-xs text-fg-muted"
                          >override {{ f.override ? 'ligado' : 'desligado' }}
                          @if (f.overrideExpiresAt) {
                            até {{ f.overrideExpiresAt | date: 'dd/MM/yyyy' }}
                          }
                          — {{ f.overrideReason }}</span
                        >
                      }
                    </span>
                    <span class="flex items-center gap-2">
                      @if (f.enabled) {
                        <app-badge tone="success">Disponível</app-badge>
                      } @else {
                        <app-badge tone="neutral">{{ reason(f) }}</app-badge>
                      }
                      @if (canManage()) {
                        <app-button size="sm" variant="ghost" (click)="openOverride(f)"
                          >Alterar</app-button
                        >
                      }
                    </span>
                  </li>
                }
              </ul>
            }
          </app-card>
        }
      </div>
    }

    <app-dialog
      [open]="enabling() !== null"
      [title]="enabling() ? 'Activar ' + enabling()!.module.name : ''"
      (closed)="enabling.set(null)"
    >
      @if (enabling(); as e) {
        @if (e.module.missingDependencies.length > 0) {
          <p>
            Para activar <strong>{{ e.module.name }}</strong> é preciso activar também:
            <strong>{{ e.module.missingDependencies.join(', ') }}</strong
            >. Todos têm de estar licenciados no plano.
          </p>
        } @else {
          <p>
            Activar <strong>{{ e.module.name }}</strong> neste tenant?
          </p>
        }
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="enabling.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="confirmEnable()">Activar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="disabling() !== null"
      [title]="disabling() ? 'Desactivar ' + disabling()!.name : ''"
      (closed)="disabling.set(null)"
    >
      @if (disabling(); as m) {
        @if (m.activeDependents.length > 0) {
          <app-alert tone="warning" title="Há módulos activos que dependem deste">
            Desactive primeiro: {{ m.activeDependents.join(', ') }}.
          </app-alert>
        } @else {
          <p>
            Desactivar <strong>{{ m.name }}</strong
            >? Deixam de se aceitar novos comandos do módulo; os dados e o histórico não são
            apagados.
          </p>
          @if (enabledFeatures(m).length > 0) {
            <p class="mt-2 text-sm text-fg-muted">
              Funcionalidades afectadas: {{ enabledFeatures(m).join(', ') }}.
            </p>
          }
        }
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="disabling.set(null)">Cancelar</app-button>
        <app-button
          variant="danger"
          [disabled]="(disabling()?.activeDependents?.length ?? 0) > 0"
          [loading]="busy()"
          (click)="confirmDisable()"
          >Desactivar</app-button
        >
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="overriding() !== null"
      [title]="overriding() ? 'Funcionalidade ' + overriding()!.name : ''"
      (closed)="overriding.set(null)"
    >
      <form [formGroup]="overrideForm" (ngSubmit)="applyOverride()" novalidate class="space-y-3">
        <p class="text-sm text-fg-muted">Um override nunca ultrapassa o que o plano licencia.</p>
        <app-select label="Acção" formControlName="choice" [required]="true" [options]="choices" />
        @if (overrideForm.controls.choice.value !== 'reset') {
          <app-textarea label="Motivo" formControlName="reason" [required]="true" [rows]="2" />
          <app-input label="Válido até (opcional)" type="date" formControlName="expiresOn" />
        }
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="overriding.set(null)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Aplicar</app-button>
        </div>
      </form>
    </app-dialog>
  `,
})
export class TenantModulesPage {
  private readonly api = inject(ModulesApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() =>
    this.permissions.can(TENANT_PERMISSIONS.modulesManage),
  );
  protected readonly choices = OVERRIDE_CHOICES;

  // Os `params` ligam a lista ao tenant: trocar de tenant volta a pedir e cancela o pedido antigo.
  protected readonly modules = rxResource({
    params: () => this.tenantId()?.id,
    stream: () => this.api.list(),
  });
  protected readonly loadError = computed(() => errorMessage(this.modules.error()));

  protected readonly enabling = signal<Activation | null>(null);
  protected readonly disabling = signal<ModuleDto | null>(null);
  protected readonly overriding = signal<FeatureDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly errorDetails = signal<readonly string[]>([]);

  protected readonly overrideForm = inject(NonNullableFormBuilder).group({
    choice: ['on', Validators.required],
    reason: [''],
    expiresOn: [''],
  });

  protected status(status: TenantModuleStatus) {
    return STATUS[status];
  }

  protected reason(feature: FeatureDto): string {
    return feature.reason ? REASONS[feature.reason] : '';
  }

  protected requires(module: ModuleDto): string {
    return module.requires
      .filter((r) => r.code !== 'core')
      .map((r) => (r.optional ? `${r.code} (opcional)` : r.code))
      .join(', ');
  }

  protected enabledFeatures(module: ModuleDto): string[] {
    return module.features.filter((f) => f.enabled).map((f) => f.code);
  }

  protected askEnable(module: ModuleDto): void {
    this.clearMessages();
    this.enabling.set({ module });
  }

  protected confirmEnable(): void {
    const target = this.enabling();
    if (!target) return;
    this.busy.set(true);
    this.api
      .enable(target.module.code, target.module.missingDependencies.length > 0)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.enabling.set(null);
          this.notice.set(`${target.module.name} activado.`);
          this.modules.reload();
        },
        error: (error: ApiError) => this.fail(error, () => this.enabling.set(null)),
      });
  }

  protected askDisable(module: ModuleDto): void {
    this.clearMessages();
    this.disabling.set(module);
  }

  protected confirmDisable(): void {
    const module = this.disabling();
    if (!module) return;
    this.busy.set(true);
    this.api
      .disable(module.code)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (result) => {
          this.disabling.set(null);
          this.notice.set(
            `${module.name} desactivado; os dados foram mantidos.` +
              (result.affectedFeatures.length > 0
                ? ` Funcionalidades afectadas: ${result.affectedFeatures.join(', ')}.`
                : ''),
          );
          this.modules.reload();
        },
        error: (error: ApiError) => this.fail(error, () => this.disabling.set(null)),
      });
  }

  protected openOverride(feature: FeatureDto): void {
    this.clearMessages();
    this.overrideForm.reset({
      // Propõe o contrário do estado actual (desligar o que está disponível, ligar o que não está).
      choice: feature.enabled ? 'off' : 'on',
      reason: '',
      expiresOn: '',
    });
    this.overriding.set(feature);
  }

  protected applyOverride(): void {
    const feature = this.overriding();
    if (!feature) return;
    const v = this.overrideForm.getRawValue();
    const reset = v.choice === 'reset';
    if (!reset && !v.reason.trim()) {
      this.overrideForm.controls.reason.setErrors({ required: true });
      this.overrideForm.controls.reason.markAsTouched();
      return;
    }
    this.busy.set(true);
    this.api
      .setFeatureOverride(feature.code, {
        override: reset ? null : v.choice === 'on',
        reason: reset ? null : v.reason.trim(),
        expiresAt: !reset && v.expiresOn ? `${v.expiresOn}T23:59:59Z` : null,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.overriding.set(null);
          this.notice.set(`Funcionalidade ${feature.name} actualizada.`);
          this.modules.reload();
        },
        error: (error: ApiError) => {
          const field = error.fieldErrors?.find((d) => d.path === 'reason');
          if (field) {
            this.overrideForm.controls.reason.setErrors({ server: { message: field.message } });
            this.overrideForm.controls.reason.markAsTouched();
            return;
          }
          this.fail(error, () => this.overriding.set(null));
        },
      });
  }

  private fail(error: ApiError, close: () => void): void {
    close();
    // O estado do tenant mudou entretanto (ou a licença): mostra o actual antes de insistir.
    this.modules.reload();
    this.actionError.set(this.explain(error));
    this.errorDetails.set(error.fieldErrors?.map((d) => d.message) ?? []);
  }

  private explain(error: ApiError): string {
    switch (error.code) {
      case 'MODULE_NOT_LICENSED':
        return 'O plano contratado não inclui todos os módulos necessários.';
      case 'DEPENDENCIES_MISSING':
        return 'Active primeiro os módulos de que este depende:';
      case 'DEPENDENTS_ENABLED':
        return 'Desactive primeiro os módulos que dependem deste:';
      case 'MODULE_ACTIVATION_FAILED':
        return 'A activação falhou; pode tentar de novo (o progresso mantém-se).';
      case 'FEATURE_NOT_LICENSED':
        return 'O plano contratado não inclui esta funcionalidade; um override não ultrapassa a licença.';
      case 'PERMISSION_DENIED':
        return 'Não tem permissão para esta operação.';
      default:
        return error.message;
    }
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.errorDetails.set([]);
  }
}
