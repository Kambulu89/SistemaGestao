import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import {
  CHANGE_LABELS,
  formatLimit,
  formatPrice,
  subscriptionLabel,
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
import {
  PlatformApi,
  type PlatformSubscriptionView,
  type PlatformTenantDto,
} from '../data-access/platform.api';

const PAGE_SIZE = 10;

/** Estados que o servidor aceita definir (TRIAL só nasce da atribuição com período de teste). */
const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Activa' },
  { value: 'PAST_DUE', label: 'Pagamento em atraso' },
  { value: 'SUSPENDED', label: 'Suspensa' },
  { value: 'CANCELLED', label: 'Cancelada' },
] as const;

/** Resultado de abrir uma assinatura: existe, ou o tenant ainda não tem. */
type Managed =
  { readonly kind: 'view'; readonly view: PlatformSubscriptionView } | { readonly kind: 'none' };

/** Assinaturas dos tenants (C02): ver o plano contratado e o consumo, atribuir, mudar de plano e de estado. */
@Component({
  selector: 'app-subscriptions',
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
    Pagination,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Subscrições"
      description="Plano contratado por cada tenant, consumo e histórico. Um downgrade que exceda os limites exige um período de adequação: nada é eliminado."
    />

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">
        {{ text }}
      </app-alert>
    }

    <app-card [flush]="true">
      @if (tenants.isLoading() && !tenants.hasValue()) {
        <app-loading-state label="A carregar subscrições…" />
      } @else if (tenants.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as subscrições">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (tenants.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="building" title="Ainda não há tenants" />
        } @else {
          <app-table caption="Subscrições" [columns]="columns" [rows]="pageRows()">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <code class="ms-2 text-xs text-fg-muted">{{ row.code }}</code>
                }
                @case ('plan') {
                  @if (row.plan) {
                    {{ row.plan.code }} · r{{ row.plan.revision }}
                  } @else {
                    <span class="text-fg-muted">Sem plano</span>
                  }
                }
                @case ('status') {
                  @if (row.plan) {
                    <app-badge [tone]="label(row.plan.status).tone">{{
                      label(row.plan.status).label
                    }}</app-badge>
                  } @else {
                    —
                  }
                }
                @case ('actions') {
                  <span class="flex justify-end">
                    <app-button size="sm" variant="secondary" (click)="open(row)">Gerir</app-button>
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

    <!-- Aberto enquanto há um tenant escolhido: fechar o diálogo emite "closed", por isso o estado de carga não o pode fechar. -->
    <app-dialog
      [open]="current() !== null"
      [title]="current() ? 'Subscrição de ' + current()!.name : ''"
      (closed)="close()"
    >
      @if (dialogError(); as text) {
        <app-alert tone="danger" class="mb-3 block" title="Operação recusada">
          {{ text }}
          @for (line of dialogDetails(); track line) {
            <span class="block text-sm">{{ line }}</span>
          }
        </app-alert>
      }
      @if (managed(); as m) {
        @if (m.kind === 'view') {
          @let v = m.view;
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt class="text-fg-muted">Plano</dt>
            <dd>{{ v.plan.name }} ({{ v.plan.planCode }} r{{ v.plan.revision }})</dd>
            <dt class="text-fg-muted">Preço contratado</dt>
            <dd>{{ price(v.plan) }}</dd>
            <dt class="text-fg-muted">Estado</dt>
            <dd>
              <app-badge [tone]="label(v.subscription.status).tone">{{
                label(v.subscription.status).label
              }}</app-badge>
              @if (!v.entitled) {
                <span class="ms-1 text-fg-muted">sem direitos activos</span>
              }
            </dd>
            <dt class="text-fg-muted">Período até</dt>
            <dd>{{ v.subscription.periodEnd | date: 'dd/MM/yyyy' }}</dd>
            @if (v.subscription.adequacyUntil) {
              <dt class="text-fg-muted">Adequação até</dt>
              <dd>{{ v.subscription.adequacyUntil | date: 'dd/MM/yyyy' }}</dd>
            }
          </dl>

          <h3 class="mb-1 mt-4 text-sm font-semibold">Consumo</h3>
          <ul class="text-sm">
            @for (u of v.usage; track u.metric) {
              <li class="flex items-center gap-2">
                {{ u.metric === 'members' ? 'Membros' : u.metric }}: {{ u.used }} /
                {{ limit(u.limit) }}
                @if (u.blocked) {
                  <app-badge tone="warning">Bloqueado</app-badge>
                }
              </li>
            }
          </ul>

          <h3 class="mb-1 mt-4 text-sm font-semibold">Histórico</h3>
          <ul class="max-h-32 overflow-auto text-sm text-fg-muted" aria-label="Histórico">
            @for (h of v.history; track $index) {
              <li>
                {{ occurred(h.occurredAt) }} — {{ changeLabel(h.kind) }}
                @if (h.toStatus) {
                  ({{ label(h.toStatus).label }})
                }
                @if (h.adequacyUntil) {
                  · adequação até {{ occurred(h.adequacyUntil) }}
                }
              </li>
            }
          </ul>

          <form
            [formGroup]="changeForm"
            (ngSubmit)="changePlan()"
            novalidate
            class="mt-4 space-y-2"
          >
            <h3 class="text-sm font-semibold">Mudar de plano</h3>
            <app-select
              label="Novo plano"
              formControlName="plan"
              [required]="true"
              [options]="planOptions()"
            />
            <app-input
              label="Dias de adequação (opcional)"
              type="number"
              formControlName="adequacyDays"
              min="1"
              max="180"
              hint="Só se o consumo exceder os limites do novo plano."
            />
            <app-button type="submit" size="sm" [loading]="busy()">Mudar plano</app-button>
          </form>

          <form
            [formGroup]="statusForm"
            (ngSubmit)="changeStatus()"
            novalidate
            class="mt-4 space-y-2"
          >
            <h3 class="text-sm font-semibold">Mudar o estado</h3>
            <app-select
              label="Estado"
              formControlName="status"
              [required]="true"
              [options]="statusOptions"
            />
            @if (statusForm.controls.status.value === 'PAST_DUE') {
              <app-input
                label="Dias de tolerância"
                type="number"
                formControlName="graceDays"
                min="1"
                max="90"
              />
            }
            <app-button type="submit" size="sm" variant="secondary" [loading]="busy()"
              >Aplicar estado</app-button
            >
          </form>
        } @else {
          <p class="mb-3 text-sm">Este tenant ainda não tem subscrição.</p>
          <form [formGroup]="assignForm" (ngSubmit)="assign()" novalidate class="space-y-2">
            <app-select
              label="Plano"
              formControlName="plan"
              [required]="true"
              [options]="planOptions()"
            />
            <app-input
              label="Dias de teste (opcional)"
              type="number"
              formControlName="trialDays"
              min="1"
              max="90"
            />
            <app-button type="submit" [loading]="busy()">Atribuir plano</app-button>
          </form>
        }
      } @else if (current()) {
        <app-loading-state label="A carregar subscrição…" />
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="close()">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class Subscriptions {
  private readonly api = inject(PlatformApi);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Tenant' },
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

  private readonly plans = rxResource({ stream: () => this.api.listPlans() });
  /** Só versões publicadas se podem contratar; o valor é `código:revisão`. */
  protected readonly planOptions = computed(() =>
    (this.plans.hasValue() ? this.plans.value() : [])
      .filter((p) => p.status === 'PUBLISHED')
      .map((p) => ({
        value: `${p.planCode}:${p.revision}`,
        label: `${p.name} (${p.planCode} r${p.revision})`,
      })),
  );

  protected readonly current = signal<PlatformTenantDto | null>(null);
  protected readonly managed = signal<Managed | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly dialogError = signal<string | null>(null);
  protected readonly dialogDetails = signal<readonly string[]>([]);

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly assignForm = this.fb.group({
    plan: ['', Validators.required],
    trialDays: this.fb.control<number | null>(null),
  });
  protected readonly changeForm = this.fb.group({
    plan: ['', Validators.required],
    adequacyDays: this.fb.control<number | null>(null),
  });
  protected readonly statusForm = this.fb.group({
    status: ['ACTIVE', Validators.required],
    graceDays: this.fb.control<number | null>(null),
  });

  protected label = subscriptionLabel;
  protected limit = formatLimit;
  protected changeLabel = (kind: string) => CHANGE_LABELS[kind] ?? kind;
  protected occurred = (iso: string) => iso.slice(0, 10);
  protected price(plan: PlatformSubscriptionView['plan']): string {
    return formatPrice(plan.price, plan.currency, plan.billingInterval);
  }

  protected open(tenant: PlatformTenantDto): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.current.set(tenant);
    this.reload(tenant);
  }

  protected close(): void {
    this.current.set(null);
    this.managed.set(null);
    this.dialogError.set(null);
    this.dialogDetails.set([]);
  }

  private reload(tenant: PlatformTenantDto): void {
    this.managed.set(null);
    this.api.subscription(tenant.id).subscribe({
      next: (view) => this.managed.set({ kind: 'view', view }),
      error: (error: ApiError) => {
        if (error.status === 404) this.managed.set({ kind: 'none' });
        else {
          this.close();
          this.actionError.set(error.message);
        }
      },
    });
  }

  private split(value: string): { planCode: string; revision: number } {
    const [planCode = '', revision = '1'] = value.split(':');
    return { planCode, revision: Number(revision) };
  }

  protected assign(): void {
    const tenant = this.current();
    if (!tenant || this.assignForm.invalid) return this.assignForm.markAllAsTouched();
    const v = this.assignForm.getRawValue();
    this.run(
      tenant,
      this.api.assign(tenant.id, { ...this.split(v.plan), trialDays: v.trialDays ?? undefined }),
      'Plano atribuído.',
    );
  }

  protected changePlan(): void {
    const tenant = this.current();
    if (!tenant || this.changeForm.invalid) return this.changeForm.markAllAsTouched();
    const v = this.changeForm.getRawValue();
    this.run(
      tenant,
      this.api.changePlan(tenant.id, {
        ...this.split(v.plan),
        adequacyDays: v.adequacyDays ?? undefined,
      }),
      'Plano alterado.',
    );
  }

  protected changeStatus(): void {
    const tenant = this.current();
    if (!tenant || this.statusForm.invalid) return this.statusForm.markAllAsTouched();
    const v = this.statusForm.getRawValue();
    this.run(
      tenant,
      this.api.setSubscriptionStatus(tenant.id, {
        status: v.status as 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED',
        graceDays: v.status === 'PAST_DUE' ? (v.graceDays ?? undefined) : undefined,
      }),
      'Estado da subscrição alterado.',
    );
  }

  private run(tenant: PlatformTenantDto, call: Observable<unknown>, message: string): void {
    this.dialogError.set(null);
    this.dialogDetails.set([]);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.notice.set(message);
        this.tenants.reload();
        this.reload(tenant);
      },
      error: (error: ApiError) => {
        // O consumo excede os novos limites: o servidor diz quais; o pedido pode repetir-se com adequação.
        this.dialogError.set(
          error.code === 'PLAN_LIMITS_EXCEEDED'
            ? `${error.message} Indique os dias de adequação para aplicar a mudança sem eliminar nada.`
            : error.message,
        );
        this.dialogDetails.set(error.fieldErrors?.map((d) => d.message) ?? []);
      },
    });
  }
}
