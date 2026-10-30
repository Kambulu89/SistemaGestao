import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
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
  type ObligationDetailDto,
  type ObligationDto,
  type ObligationKind,
  type ObligationView,
  type PaymentDto,
  type PaymentMethod,
} from './finance.api';
import {
  financeError,
  formatDecimal,
  isMoney,
  METHOD,
  OBLIGATION_VIEW,
  PAYMENT_STATUS,
  SOURCE,
} from './finance-model';

const VIEWS: readonly SelectOption[] = [
  { value: '', label: 'Todos' },
  ...Object.entries(OBLIGATION_VIEW).map(([value, v]) => ({ value, label: v.label })),
];
const METHODS: readonly SelectOption[] = Object.entries(METHOD).map(([value, label]) => ({
  value,
  label,
}));

/**
 * Contas a receber e a pagar. O saldo deriva do valor original, dos créditos aplicados e dos pagamentos confirmados:
 * nunca se edita. Daqui regista-se o recebimento ou pagamento (rascunho) e, com permissão, confirma-se de seguida.
 */
@Component({
  selector: 'app-finance-obligations',
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

    @if (detail(); as d) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ d.partyName }}
            <app-badge class="ms-2" [tone]="view(d).tone">{{ view(d).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted"
            >{{ source(d) }} · vence em {{ d.dueOn }} · {{ d.currency }}</span
          >
        </div>
        <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-4" data-testid="obligation-figures">
          <div>
            <dt class="text-fg-muted">Original</dt>
            <dd>{{ money(d.originalAmount) }}</dd>
          </div>
          @if (kind() === 'receivable') {
            <div>
              <dt class="text-fg-muted">Créditos</dt>
              <dd>{{ money(d.credits) }}</dd>
            </div>
          }
          <div>
            <dt class="text-fg-muted">Liquidado</dt>
            <dd>{{ money(d.paid) }}</dd>
          </div>
          <div>
            <dt class="text-fg-muted">Saldo</dt>
            <dd class="font-semibold" data-testid="obligation-balance">{{ money(d.balance) }}</dd>
          </div>
        </dl>

        @if (d.allocations.length > 0) {
          <h3 class="mb-2 mt-5 text-sm font-semibold">Pagamentos</h3>
          <ul class="text-sm" data-testid="obligation-allocations">
            @for (a of d.allocations; track a.id) {
              <li>
                {{ a.occurredOn }} · {{ money(a.amount) }} ·
                {{ a.reversedAt ? 'Revertido' : paymentLabel(a.paymentStatus) }}
              </li>
            }
          </ul>
        }
        @if (d.creditApplications.length > 0) {
          <h3 class="mb-2 mt-5 text-sm font-semibold">Notas de crédito aplicadas</h3>
          <ul class="text-sm">
            @for (c of d.creditApplications; track c.id) {
              <li>{{ money(c.amount) }}</li>
            }
          </ul>
        }

        @if (canRegister() && d.status === 'OPEN') {
          <h3 class="mb-2 mt-5 text-sm font-semibold">
            {{ kind() === 'receivable' ? 'Registar recebimento' : 'Registar pagamento' }}
          </h3>
          <div class="grid gap-4 sm:grid-cols-4">
            <app-select
              label="Conta"
              [required]="true"
              [options]="accountOptions()"
              [ngModel]="accountId()"
              (ngModelChange)="accountId.set($event ?? '')"
            />
            <app-input
              label="Montante"
              [required]="true"
              [ngModel]="amount()"
              (ngModelChange)="amount.set($event ?? '')"
            />
            <app-select
              label="Método"
              [options]="methods"
              [ngModel]="method()"
              (ngModelChange)="method.set($event ?? 'TRANSFER')"
            />
            <app-input
              label="Referência"
              [ngModel]="reference()"
              (ngModelChange)="reference.set($event ?? '')"
            />
          </div>
          @if (clientError(); as text) {
            <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
          }
          <div class="mt-4 flex gap-2">
            <app-button variant="secondary" [loading]="busy()" (click)="register(d, false)"
              >Registar (rascunho)</app-button
            >
            @if (canConfirm()) {
              <app-button [loading]="busy()" (click)="register(d, true)"
                >Registar e confirmar</app-button
              >
            }
          </div>
        } @else if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4">
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 max-w-xs">
        <app-select
          label="Estado"
          [options]="views"
          [ngModel]="viewFilter()"
          (ngModelChange)="viewFilter.set($any($event ?? ''))"
        />
      </div>
      <app-card [flush]="true">
        @if (list.isLoading() && !list.hasValue()) {
          <app-loading-state label="A carregar…" />
        } @else if (list.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar">{{ loadError() }}</app-alert>
          </div>
        } @else if (list.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state
              icon="card"
              [title]="kind() === 'receivable' ? 'Sem contas a receber' : 'Sem contas a pagar'"
              description="As contas a receber nascem das facturas emitidas e as contas a pagar das facturas de fornecedor validadas."
            />
          } @else {
            <app-table
              [caption]="kind() === 'receivable' ? 'Contas a receber' : 'Contas a pagar'"
              [columns]="columns()"
              [rows]="page.items"
              data-testid="obligations"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('party') {
                    <span class="font-medium">{{ row.partyName }}</span>
                  }
                  @case ('source') {
                    {{ source(row) }}
                  }
                  @case ('due') {
                    {{ row.dueOn }}
                  }
                  @case ('original') {
                    {{ money(row.originalAmount) }}
                  }
                  @case ('balance') {
                    {{ money(row.balance) }} {{ row.currency }}
                  }
                  @case ('status') {
                    <app-badge [tone]="view(row).tone">{{ view(row).label }}</app-badge>
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
export class ObligationsTab {
  readonly kind = input.required<ObligationKind>();

  private readonly api = inject(FinanceApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly views = VIEWS;
  protected readonly methods = METHODS;
  protected readonly columns = computed<readonly TableColumn[]>(() => [
    { key: 'party', label: this.kind() === 'receivable' ? 'Cliente' : 'Fornecedor' },
    { key: 'source', label: 'Origem' },
    { key: 'due', label: 'Vencimento' },
    { key: 'original', label: 'Original', align: 'end' },
    { key: 'balance', label: 'Saldo', align: 'end' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ]);

  protected readonly canRegister = computed(() => this.permissions.can('payment.manage'));
  protected readonly canConfirm = computed(() => this.permissions.can('payment.confirm'));

  private readonly reload = signal(0);
  protected readonly viewFilter = signal<ObligationView | ''>('');
  protected readonly list = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? {
            tenantId: tenant.id,
            kind: this.kind(),
            view: this.viewFilter(),
            reload: this.reload(),
          }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.obligations(params.kind, { view: params.view || undefined, limit: 100 }),
  });
  private readonly accounts = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant && this.canRegister() ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.api.accounts({ active: 'true', limit: 100 }),
  });

  protected readonly detail = signal<ObligationDetailDto | null>(null);
  protected readonly accountId = signal('');
  protected readonly amount = signal('');
  protected readonly method = signal<PaymentMethod>('TRANSFER');
  protected readonly reference = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  /** Só contas da mesma organização e moeda da obrigação servem para a liquidar. */
  protected readonly accountOptions = computed<readonly SelectOption[]>(() => {
    const current = this.detail();
    const all = this.accounts.hasValue() ? this.accounts.value().items : [];
    return all
      .filter(
        (a) =>
          !current ||
          (a.organizationId === current.organizationId && a.currency === current.currency),
      )
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name} (${a.currency})` }));
  });

  protected money = formatDecimal;
  protected view = (o: ObligationDto) => OBLIGATION_VIEW[o.view];
  protected source = (o: ObligationDto) => SOURCE[o.sourceType] ?? o.sourceType;
  protected paymentLabel = (status: keyof typeof PAYMENT_STATUS) => PAYMENT_STATUS[status].label;
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

  protected open(row: ObligationDto): void {
    this.reset();
    this.api.obligation(this.kind(), row.id).subscribe({
      next: (d) => this.show(d),
      error: (error: unknown) =>
        this.actionError.set(financeError(error, 'Não foi possível abrir a obrigação.')),
    });
  }

  private show(d: ObligationDetailDto): void {
    this.detail.set(d);
    this.amount.set(d.balance);
    this.accountId.set(this.accountOptions()[0]?.value ?? '');
    this.reference.set('');
    this.method.set('TRANSFER');
  }

  protected close(): void {
    this.detail.set(null);
    this.reload.update((n) => n + 1);
  }

  protected register(current: ObligationDetailDto, confirm: boolean): void {
    this.reset();
    if (!this.accountId()) return void this.clientError.set('Escolha a conta de tesouraria.');
    const amount = this.amount().trim();
    if (!isMoney(amount) || !/[1-9]/.test(amount)) {
      return void this.clientError.set('Montante: número positivo, até 4 casas.');
    }
    const receivable = this.kind() === 'receivable';
    this.run(
      this.api.createPayment({
        organizationId: current.organizationId,
        direction: receivable ? 'INBOUND' : 'OUTBOUND',
        partyId: current.partyId,
        treasuryAccountId: this.accountId(),
        amount,
        method: this.method(),
        ...(this.reference().trim() ? { reference: this.reference().trim() } : {}),
        allocations: [
          receivable ? { receivableId: current.id, amount } : { payableId: current.id, amount },
        ],
      }),
      (payment: PaymentDto) => {
        if (!confirm)
          return this.afterRegister(current, 'Rascunho registado: confirme-o em Pagamentos.');
        this.run(this.api.confirmPayment(payment.id), () =>
          this.afterRegister(
            current,
            receivable ? 'Recebimento confirmado.' : 'Pagamento confirmado.',
          ),
        );
      },
    );
  }

  private afterRegister(current: ObligationDetailDto, message: string): void {
    this.notice.set(message);
    this.api.obligation(this.kind(), current.id).subscribe({
      next: (d) => this.show(d),
      error: () => this.detail.set(null),
    });
  }
}
