import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { PLATFORM_PERMISSIONS } from '../../../core/permissions/permission.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import {
  subscriptionLabel,
  tenantLifecycleLabel,
} from '../../../core/subscription/subscription-labels';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Pagination } from '../../../shared/ui/pagination/pagination';
import { Select } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import {
  PlatformApi,
  type PlatformTenantDto,
  type ProvisioningStateDto,
  type ProvisioningStep,
} from '../data-access/platform.api';

const PAGE_SIZE = 10;

const STEP_LABELS: Record<ProvisioningStep, string> = {
  TENANT: 'Tenant criado',
  SUBSCRIPTION: 'Plano atribuído',
  ADMIN_ROLE: 'Papel de administrador',
  ORGANIZATION: 'Organização inicial',
  ADMIN_INVITATION: 'Convite ao administrador',
  ACTIVATION: 'Tenant activado',
};
const STEP_ORDER = Object.keys(STEP_LABELS) as ProvisioningStep[];

interface Lifecycle {
  readonly tenant: PlatformTenantDto;
  readonly to: 'SUSPENDED' | 'ACTIVE';
}

/** Tenants da plataforma (C01): provisionamento idempotente, estado do plano e suspensão. */
@Component({
  selector: 'app-tenants',
  imports: [
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
    Pagination,
    Select,
    Table,
    Textarea,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Tenants"
      description="Organizações clientes da plataforma. A administração da plataforma não dá acesso aos dados de nenhuma organização."
    />

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">
        {{ text }}
      </app-alert>
    }

    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-base font-semibold">Organizações</h2>
      <app-button (click)="openProvision()">Novo tenant</app-button>
    </div>

    <app-card [flush]="true">
      @if (tenants.isLoading() && !tenants.hasValue()) {
        <app-loading-state label="A carregar tenants…" />
      } @else if (tenants.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os tenants">
            {{ loadError() }}
          </app-alert>
        </div>
      } @else if (tenants.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state title="Ainda não há tenants" icon="building" />
        } @else {
          <app-table caption="Lista de tenants" [columns]="columns" [rows]="pageRows()">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <code class="ms-2 text-xs text-fg-muted">{{ row.code }}</code>
                }
                @case ('plan') {
                  @if (row.plan) {
                    {{ row.plan.code }} · r{{ row.plan.revision }}
                    <app-badge class="ms-1" [tone]="subscription(row.plan.status).tone">{{
                      subscription(row.plan.status).label
                    }}</app-badge>
                  } @else {
                    <span class="text-fg-muted">Sem plano</span>
                  }
                }
                @case ('status') {
                  <app-badge [tone]="lifecycle(row.status).tone">{{
                    lifecycle(row.status).label
                  }}</app-badge>
                }
                @case ('actions') {
                  <span class="flex justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="openDetail(row)"
                      >Estado</app-button
                    >
                    @if (row.status === 'ACTIVE') {
                      <app-button
                        size="sm"
                        variant="danger"
                        (click)="askLifecycle(row, 'SUSPENDED')"
                        >Suspender</app-button
                      >
                    } @else if (row.status === 'SUSPENDED') {
                      <app-button
                        size="sm"
                        variant="secondary"
                        (click)="askLifecycle(row, 'ACTIVE')"
                        >Reactivar</app-button
                      >
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
          <app-pagination
            class="border-t border-line"
            [page]="pageNumber()"
            [pageSize]="pageSize"
            [total]="list.length"
            (pageChange)="pageNumber.set($event)"
          />
        }
      }
    </app-card>

    <app-dialog [open]="provisioning()" title="Novo tenant" (closed)="provisioning.set(false)">
      <form [formGroup]="provisionForm" (ngSubmit)="provision()" novalidate class="space-y-3">
        <app-input
          label="Identificador"
          formControlName="code"
          [required]="true"
          hint="2–50 caracteres: minúsculas, dígitos e _. Não se altera depois."
        />
        <app-input label="Nome" formControlName="name" [required]="true" />
        <app-input
          label="Email do administrador"
          type="email"
          formControlName="adminEmail"
          [required]="true"
          hint="Recebe um convite; nenhuma palavra-passe é pedida aqui."
        />
        @if (canBilling() && planOptions().length > 0) {
          <app-select
            label="Plano"
            formControlName="planCode"
            [required]="true"
            [options]="planOptions()"
          />
        } @else {
          <app-input label="Código do plano" formControlName="planCode" [required]="true" />
        }
        <app-input
          label="Dias de teste (opcional)"
          type="number"
          formControlName="trialDays"
          min="1"
          max="90"
        />
        <p class="text-xs text-fg-muted">
          Repetir o pedido com os mesmos dados retoma o provisionamento sem duplicar a organização
          nem o convite.
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="provisioning.set(false)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Provisionar</app-button>
        </div>
      </form>
    </app-dialog>

    <app-dialog
      [open]="detail() !== null"
      [title]="detail() ? 'Estado de ' + detail()!.tenant.name : ''"
      (closed)="detail.set(null)"
    >
      @if (detail(); as state) {
        <ul class="space-y-1.5 text-sm" aria-label="Passos do provisionamento">
          @for (step of steps; track step) {
            <li class="flex items-center gap-2">
              <app-badge [tone]="state.done.includes(step) ? 'success' : 'warning'">{{
                state.done.includes(step) ? 'Feito' : 'Em falta'
              }}</app-badge>
              {{ stepLabel(step) }}
            </li>
          }
        </ul>
        <p class="mt-3 text-sm text-fg-muted">
          {{ state.organizations }} organização(ões) · {{ state.pendingInvitations }} convite(s)
          pendente(s). Só se mostram contagens: os dados da organização não são acessíveis aqui.
        </p>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="detail.set(null)">Fechar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="pendingLifecycle() !== null"
      [title]="pendingLifecycle()?.to === 'SUSPENDED' ? 'Suspender tenant' : 'Reactivar tenant'"
      (closed)="pendingLifecycle.set(null)"
    >
      @if (pendingLifecycle(); as change) {
        <form [formGroup]="reasonForm" (ngSubmit)="confirmLifecycle()" novalidate class="space-y-3">
          <p>
            @if (change.to === 'SUSPENDED') {
              <strong>{{ change.tenant.name }}</strong> deixa de poder fazer operações empresariais
              de imediato.
            } @else {
              <strong>{{ change.tenant.name }}</strong> volta a ficar operacional.
            }
          </p>
          <app-textarea
            label="Motivo"
            formControlName="reason"
            [required]="true"
            [rows]="3"
            hint="Fica registado nos eventos de segurança."
          />
          <div class="flex justify-end gap-2 pt-2">
            <app-button variant="secondary" (click)="pendingLifecycle.set(null)"
              >Cancelar</app-button
            >
            <app-button
              type="submit"
              [variant]="change.to === 'SUSPENDED' ? 'danger' : 'primary'"
              [loading]="busy()"
              >Confirmar</app-button
            >
          </div>
        </form>
      }
    </app-dialog>
  `,
})
export class Tenants {
  private readonly api = inject(PlatformApi);
  private readonly permissions = inject(PermissionService);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly steps = STEP_ORDER;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Nome' },
    { key: 'plan', label: 'Plano' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];

  protected readonly pageNumber = signal(1);
  protected readonly tenants = rxResource({ stream: () => this.api.listTenants() });
  protected readonly loadError = computed(() => errorMessage(this.tenants.error()));

  protected readonly pageRows = computed(() => {
    const list = this.tenants.hasValue() ? this.tenants.value() : [];
    const start = (this.pageNumber() - 1) * PAGE_SIZE;
    return list.slice(start, start + PAGE_SIZE);
  });

  protected readonly canBilling = computed(() =>
    this.permissions.can(PLATFORM_PERMISSIONS.billingManage),
  );
  private readonly plans = rxResource({
    params: () => (this.canBilling() ? true : undefined),
    stream: () => this.api.listPlans(),
  });
  protected readonly planOptions = computed(() => {
    const seen = new Set<string>();
    return (this.plans.hasValue() ? this.plans.value() : [])
      .filter((p) => p.status === 'PUBLISHED')
      .filter((p) => !seen.has(p.planCode) && !!seen.add(p.planCode))
      .map((p) => ({ value: p.planCode, label: `${p.name} (${p.planCode})` }));
  });

  protected readonly provisioning = signal(false);
  protected readonly detail = signal<ProvisioningStateDto | null>(null);
  protected readonly pendingLifecycle = signal<Lifecycle | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly provisionForm = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[a-z0-9_]{2,50}$/)]],
    name: ['', [Validators.required, Validators.maxLength(160)]],
    adminEmail: ['', [Validators.required, Validators.email]],
    planCode: ['', Validators.required],
    trialDays: this.fb.control<number | null>(null),
  });
  protected readonly reasonForm = this.fb.group({
    reason: ['', [Validators.required, Validators.minLength(3)]],
  });

  protected subscription = subscriptionLabel;
  protected lifecycle = tenantLifecycleLabel;
  protected stepLabel(step: ProvisioningStep): string {
    return STEP_LABELS[step];
  }

  protected openProvision(): void {
    this.clearMessages();
    this.provisionForm.reset();
    this.provisioning.set(true);
  }

  protected provision(): void {
    if (this.provisionForm.invalid) {
      this.provisionForm.markAllAsTouched();
      return;
    }
    const v = this.provisionForm.getRawValue();
    this.busy.set(true);
    this.api
      .provision({
        code: v.code.trim(),
        name: v.name.trim(),
        adminEmail: v.adminEmail.trim(),
        planCode: v.planCode.trim(),
        trialDays: v.trialDays ?? undefined,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (state) => {
          this.provisioning.set(false);
          this.notice.set(
            state.created
              ? `Tenant ${state.tenant.name} criado; o administrador foi convidado por email.`
              : `Tenant ${state.tenant.name} já existia; o provisionamento foi retomado.`,
          );
          this.tenants.reload();
          this.detail.set(state);
        },
        error: (error: ApiError) => {
          const field = error.fieldErrors?.find((d) => d.path in this.provisionForm.controls);
          if (field) {
            const control =
              this.provisionForm.controls[field.path as keyof typeof this.provisionForm.controls];
            control.setErrors({ server: { message: field.message } });
            control.markAsTouched();
            return;
          }
          this.provisioning.set(false);
          // Uma falha a meio deixa o tenant em preparação: a lista mostra-o e o pedido pode repetir-se.
          this.tenants.reload();
          this.actionError.set(this.explain(error));
        },
      });
  }

  protected openDetail(tenant: PlatformTenantDto): void {
    this.clearMessages();
    this.api.tenantState(tenant.id).subscribe({
      next: (state) => this.detail.set(state),
      error: (error: ApiError) => this.actionError.set(this.explain(error)),
    });
  }

  protected askLifecycle(tenant: PlatformTenantDto, to: 'SUSPENDED' | 'ACTIVE'): void {
    this.clearMessages();
    this.reasonForm.reset();
    this.pendingLifecycle.set({ tenant, to });
  }

  protected confirmLifecycle(): void {
    const change = this.pendingLifecycle();
    if (!change) return;
    if (this.reasonForm.invalid) {
      this.reasonForm.markAllAsTouched();
      return;
    }
    const reason = this.reasonForm.getRawValue().reason.trim();
    const call =
      change.to === 'SUSPENDED'
        ? this.api.suspend(change.tenant.id, reason)
        : this.api.resume(change.tenant.id, reason);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.pendingLifecycle.set(null);
        this.notice.set(
          change.to === 'SUSPENDED'
            ? `${change.tenant.name} suspenso.`
            : `${change.tenant.name} reactivado.`,
        );
        this.tenants.reload();
      },
      error: (error: ApiError) => {
        this.pendingLifecycle.set(null);
        this.tenants.reload();
        this.actionError.set(this.explain(error));
      },
    });
  }

  private explain(error: ApiError): string {
    switch (error.code) {
      case 'PLATFORM_PERMISSION_DENIED':
        return 'Não tem permissão de plataforma para esta operação.';
      case 'SUBSCRIPTION_EXISTS':
        return `${error.message} Use a página de subscrições para mudar o plano deste tenant.`;
      case 'TENANT_NOT_PROVISIONABLE':
        return error.message;
      case 'INVALID_STATE_TRANSITION':
        return `${error.message} A lista foi actualizada.`;
      default:
        return error.status === 404 && error.code === 'NOT_FOUND'
          ? 'O plano indicado não existe ou não está publicado.'
          : error.message;
    }
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
