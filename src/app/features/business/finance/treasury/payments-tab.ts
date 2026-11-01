import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import {
  FinanceApi,
  type PaymentDirection,
  type PaymentDto,
  type PaymentStatus,
} from './finance.api';
import { DIRECTION, financeError, formatDecimal, METHOD, PAYMENT_STATUS } from './finance-model';

const DIRECTIONS: readonly SelectOption[] = [
  { value: '', label: 'Todos' },
  { value: 'INBOUND', label: 'Recebimentos' },
  { value: 'OUTBOUND', label: 'Pagamentos' },
];
const STATUSES: readonly SelectOption[] = [
  { value: '', label: 'Todos' },
  ...Object.entries(PAYMENT_STATUS).map(([value, v]) => ({ value, label: v.label })),
];

/**
 * Pagamentos e recebimentos. Confirmar é a operação que move dinheiro (movimento na conta e liquidação das obrigações
 * numa só transacção); um confirmado nunca se edita nem apaga: reverte-se, com motivo.
 */
@Component({
  selector: 'app-finance-payments',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-3 block">
        {{ text }}
      </app-alert>
    }

    @if (payment(); as p) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ direction(p) }} — {{ p.partyName }}
            <app-badge class="ms-2" [tone]="status(p).tone">{{ status(p).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted" data-testid="payment-amount"
            >{{ money(p.amount) }} {{ p.currency }}</span
          >
        </div>
        <p class="mt-2 text-sm text-fg-muted">
          {{ method(p) }} · {{ p.occurredOn }}
          @if (p.reference) {
            · {{ p.reference }}
          }
        </p>
        @if (p.failureReason) {
          <p class="mt-2 text-sm" data-testid="payment-reason">Falha: {{ p.failureReason }}</p>
        }
        @if (p.reverseReason) {
          <p class="mt-2 text-sm" data-testid="payment-reason">Reversão: {{ p.reverseReason }}</p>
        }
        @if (p.allocations && p.allocations.length > 0) {
          <h3 class="mb-2 mt-4 text-sm font-semibold">Obrigações liquidadas</h3>
          <ul class="text-sm">
            @for (a of p.allocations; track a.id) {
              <li>{{ money(a.amount) }}{{ a.reversedAt ? ' · revertida' : '' }}</li>
            }
          </ul>
        }

        @if (needsReason()) {
          <div class="mt-4 max-w-md">
            <app-input
              [label]="needsReason() === 'fail' ? 'Motivo da falha' : 'Motivo da reversão'"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event ?? '')"
            />
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap gap-2">
          @if (canManage() && p.status === 'DRAFT') {
            <app-button variant="secondary" [loading]="busy()" (click)="submit(p)"
              >Submeter</app-button
            >
            <app-button variant="secondary" [loading]="busy()" (click)="remove(p)"
              >Apagar</app-button
            >
          }
          @if (canConfirm() && (p.status === 'DRAFT' || p.status === 'PENDING')) {
            <app-button [loading]="busy()" (click)="confirm(p)">Confirmar</app-button>
            <app-button variant="secondary" [loading]="busy()" (click)="fail(p)"
              >Marcar como falhado</app-button
            >
          }
          @if (canConfirm() && p.status === 'CONFIRMED') {
            <app-button variant="secondary" [loading]="busy()" (click)="reverse(p)"
              >Reverter</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 grid max-w-xl gap-3 sm:grid-cols-2">
        <app-select
          label="Sentido"
          [options]="directions"
          [ngModel]="directionFilter()"
          (ngModelChange)="directionFilter.set($any($event ?? ''))"
        />
        <app-select
          label="Estado"
          [options]="statuses"
          [ngModel]="statusFilter()"
          (ngModelChange)="statusFilter.set($any($event ?? ''))"
        />
      </div>
      <app-card [flush]="true">
        @if (list.isLoading() && !list.hasValue()) {
          <app-loading-state label="A carregar pagamentos…" />
        } @else if (list.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar os pagamentos">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (list.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state
              icon="card"
              title="Sem pagamentos"
              description="Registe um recebimento ou pagamento a partir de uma conta a receber ou a pagar."
            />
          } @else {
            <app-table
              caption="Pagamentos e recebimentos"
              [columns]="columns"
              [rows]="page.items"
              data-testid="payments"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('party') {
                    <span class="font-medium">{{ row.partyName }}</span>
                  }
                  @case ('direction') {
                    {{ direction(row) }}
                  }
                  @case ('date') {
                    {{ row.occurredOn }}
                  }
                  @case ('amount') {
                    {{ money(row.amount) }} {{ row.currency }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('actions') {
                    <app-button size="sm" variant="secondary" (click)="open(row)">Abrir</app-button>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>
    }
  `,
})
export class PaymentsTab {
  private readonly api = inject(FinanceApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly directions = DIRECTIONS;
  protected readonly statuses = STATUSES;
  protected readonly canManage = computed(() => this.permissions.can('payment.manage'));
  protected readonly canConfirm = computed(() => this.permissions.can('payment.confirm'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'party', label: 'Entidade' },
    { key: 'direction', label: 'Sentido' },
    { key: 'date', label: 'Data' },
    { key: 'amount', label: 'Montante', align: 'end' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  protected readonly directionFilter = signal<PaymentDirection | ''>('');
  protected readonly statusFilter = signal<PaymentStatus | ''>('');
  protected readonly list = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? {
            tenantId: tenant.id,
            direction: this.directionFilter(),
            status: this.statusFilter(),
            reload: this.reload(),
          }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.payments({
        direction: params.direction || undefined,
        status: params.status || undefined,
        limit: 100,
      }),
  });

  protected readonly payment = signal<PaymentDto | null>(null);
  protected readonly needsReason = signal<'fail' | 'reverse' | null>(null);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected money = formatDecimal;
  protected status = (p: PaymentDto) => PAYMENT_STATUS[p.status];
  protected direction = (p: PaymentDto) => DIRECTION[p.direction];
  protected method = (p: PaymentDto) => METHOD[p.method];
  protected loadError = () => financeError(this.list.error(), 'Pedido falhado.');

  private reset(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: done,
      error: (error: unknown) =>
        this.actionError.set(financeError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected open(row: PaymentDto): void {
    this.reset();
    this.needsReason.set(null);
    this.reason.set('');
    this.api.payment(row.id).subscribe({
      next: (p) => this.payment.set(p),
      error: (error: unknown) =>
        this.actionError.set(financeError(error, 'Não foi possível abrir o pagamento.')),
    });
  }

  protected close(): void {
    this.payment.set(null);
    this.needsReason.set(null);
    this.reload.update((n) => n + 1);
  }

  protected submit(p: PaymentDto): void {
    this.reset();
    this.run(this.api.submitPayment(p.id), (saved) => {
      this.payment.set(saved);
      this.notice.set('Pagamento submetido.');
    });
  }

  protected confirm(p: PaymentDto): void {
    this.reset();
    this.run(this.api.confirmPayment(p.id), (saved) => {
      this.payment.set(saved);
      this.notice.set('Confirmado: a conta foi movimentada e as obrigações liquidadas.');
    });
  }

  protected remove(p: PaymentDto): void {
    this.reset();
    this.run(this.api.deletePayment(p.id), () => {
      this.payment.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }

  protected fail(p: PaymentDto): void {
    this.reset();
    if (this.needsReason() !== 'fail') return void this.needsReason.set('fail');
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo da falha.');
    this.run(this.api.failPayment(p.id, this.reason().trim()), (saved) => {
      this.payment.set(saved);
      this.needsReason.set(null);
      this.reason.set('');
      this.notice.set('Pagamento marcado como falhado: os saldos não mudaram.');
    });
  }

  protected reverse(p: PaymentDto): void {
    this.reset();
    if (this.needsReason() !== 'reverse') return void this.needsReason.set('reverse');
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo da reversão.');
    this.run(this.api.reversePayment(p.id, this.reason().trim()), (saved) => {
      this.payment.set(saved);
      this.needsReason.set(null);
      this.reason.set('');
      this.notice.set('Pagamento revertido: saldos repostos e movimento inverso lançado.');
    });
  }
}
