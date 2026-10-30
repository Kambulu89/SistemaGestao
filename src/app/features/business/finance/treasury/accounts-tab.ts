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
import { FinanceApi, type AccountDto, type AccountType } from './finance.api';
import { financeError, formatDecimal } from './finance-model';

const TYPES: readonly SelectOption[] = [
  { value: 'CASH', label: 'Caixa' },
  { value: 'BANK', label: 'Banco' },
];

/**
 * Contas de tesouraria (caixa e bancos). O saldo deriva dos movimentos (que nunca se alteram); o identificador da conta é
 * sensível e só aparece a quem gere tesouraria.
 */
@Component({
  selector: 'app-finance-accounts',
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

    @if (creating()) {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">Nova conta</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Organização"
            [required]="true"
            [options]="organizationOptions()"
            [ngModel]="organizationId()"
            (ngModelChange)="organizationId.set($event ?? '')"
          />
          <app-select
            label="Tipo"
            [required]="true"
            [options]="types"
            [ngModel]="type()"
            (ngModelChange)="type.set($event ?? 'CASH')"
          />
          <app-input
            label="Código"
            [required]="true"
            [ngModel]="code()"
            (ngModelChange)="code.set($event ?? '')"
          />
          <app-input
            label="Nome"
            [required]="true"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          @if (type() === 'BANK') {
            <app-input
              label="Banco"
              [ngModel]="bankName()"
              (ngModelChange)="bankName.set($event ?? '')"
            />
            <app-input
              label="IBAN / identificador"
              [ngModel]="identifier()"
              (ngModelChange)="identifier.set($event ?? '')"
            />
          }
        </div>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar conta</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (account(); as a) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ a.name }}
            <app-badge class="ms-2" [tone]="a.active ? 'success' : 'neutral'">{{
              a.active ? 'Activa' : 'Inactiva'
            }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted" data-testid="account-balance"
            >Saldo: {{ money(a.balance) }} {{ a.currency }}</span
          >
        </div>
        <p class="mt-2 text-sm text-fg-muted">
          {{ a.code }} · {{ a.type === 'BANK' ? 'Banco' : 'Caixa' }}
          @if (a.bankName) {
            · {{ a.bankName }}
          }
          @if (a.accountIdentifier) {
            · {{ a.accountIdentifier }}
          }
        </p>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <h3 class="mb-2 mt-5 text-sm font-semibold">Movimentos</h3>
        @if (entries.hasValue() && entries.value().items.length > 0) {
          <app-table
            caption="Movimentos da conta"
            [columns]="entryColumns"
            [rows]="entries.value().items"
            data-testid="entries"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('date') {
                  {{ row.occurredOn }}
                }
                @case ('amount') {
                  <span [class.text-red-600]="row.amountSigned.startsWith('-')">{{
                    money(row.amountSigned)
                  }}</span>
                }
                @case ('kind') {
                  {{ row.reversalOfId ? 'Reversão' : 'Pagamento' }}
                }
              }
            </ng-template>
          </app-table>
        } @else {
          <p class="text-sm text-fg-muted">Sem movimentos.</p>
        }
        <div class="mt-4 flex gap-2">
          @if (canManage()) {
            <app-button variant="secondary" [loading]="busy()" (click)="toggle(a)">{{
              a.active ? 'Inactivar' : 'Reactivar'
            }}</app-button>
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
        @if (canManage()) {
          <app-button (click)="startNew()">Nova conta</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (accounts.isLoading() && !accounts.hasValue()) {
          <app-loading-state label="A carregar contas…" />
        } @else if (accounts.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as contas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (accounts.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="card" title="Sem contas de tesouraria" />
          } @else {
            <app-table
              caption="Contas de tesouraria"
              [columns]="columns"
              [rows]="page.items"
              data-testid="accounts"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                  }
                  @case ('code') {
                    {{ row.code }}
                  }
                  @case ('type') {
                    {{ row.type === 'BANK' ? 'Banco' : 'Caixa' }}
                  }
                  @case ('balance') {
                    {{ money(row.balance) }} {{ row.currency }}
                  }
                  @case ('status') {
                    <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                      row.active ? 'Activa' : 'Inactiva'
                    }}</app-badge>
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
export class AccountsTab {
  private readonly api = inject(FinanceApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly types = TYPES;
  protected readonly canManage = computed(() => this.permissions.can('treasury.manage'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Conta' },
    { key: 'code', label: 'Código' },
    { key: 'type', label: 'Tipo' },
    { key: 'balance', label: 'Saldo', align: 'end' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];
  protected readonly entryColumns: readonly TableColumn[] = [
    { key: 'date', label: 'Data' },
    { key: 'kind', label: 'Origem' },
    { key: 'amount', label: 'Montante', align: 'end' },
  ];

  private readonly reload = signal(0);
  protected readonly accounts = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
    },
    stream: () => this.api.accounts({ limit: 100 }),
  });
  private readonly organizations = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.api.organizations(),
  });

  protected readonly account = signal<AccountDto | null>(null);
  protected readonly entries = rxResource({
    params: () => {
      const current = this.account();
      return current ? { id: current.id, balance: current.balance } : undefined;
    },
    stream: ({ params }) => this.api.entries(params.id),
  });

  protected readonly creating = signal(false);
  protected readonly organizationId = signal('');
  protected readonly type = signal<AccountType>('CASH');
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly bankName = signal('');
  protected readonly identifier = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly organizationOptions = computed<readonly SelectOption[]>(() =>
    (this.organizations.hasValue() ? this.organizations.value() : []).map((o) => ({
      value: o.id,
      label: `${o.code} — ${o.legalName}`,
    })),
  );

  protected money = formatDecimal;
  protected loadError = () => financeError(this.accounts.error(), 'Pedido falhado.');

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

  protected startNew(): void {
    this.reset();
    this.organizationId.set(this.organizationOptions()[0]?.value ?? '');
    this.type.set('CASH');
    this.code.set('');
    this.name.set('');
    this.bankName.set('');
    this.identifier.set('');
    this.creating.set(true);
  }

  protected create(): void {
    this.reset();
    if (!this.organizationId()) return void this.clientError.set('Escolha a organização.');
    if (!this.code().trim()) return void this.clientError.set('Indique o código.');
    if (!this.name().trim()) return void this.clientError.set('Indique o nome da conta.');
    const bank = this.type() === 'BANK';
    this.run(
      this.api.createAccount({
        organizationId: this.organizationId(),
        code: this.code().trim(),
        name: this.name().trim(),
        type: this.type(),
        ...(bank && this.bankName().trim() ? { bankName: this.bankName().trim() } : {}),
        ...(bank && this.identifier().trim()
          ? { accountIdentifier: this.identifier().trim() }
          : {}),
      }),
      (created) => {
        this.creating.set(false);
        this.account.set(created);
        this.notice.set('Conta criada.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: AccountDto): void {
    this.reset();
    this.account.set(row);
  }

  protected close(): void {
    this.account.set(null);
    this.creating.set(false);
    this.reload.update((n) => n + 1);
  }

  protected toggle(current: AccountDto): void {
    this.reset();
    this.run(
      this.api.updateAccount(current.id, current.version, { active: !current.active }),
      (saved) => {
        this.account.set(saved);
        this.notice.set(
          saved.active ? 'Conta reactivada.' : 'Conta inactivada: deixa de receber pagamentos.',
        );
      },
    );
  }
}
