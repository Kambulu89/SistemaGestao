import { DatePipe } from '@angular/common';
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
import { OrdersApi } from '../orders/orders.api';
import {
  BillingApi,
  type ContractDto,
  type ContractType,
  type PartyOption,
  type RenewalMode,
} from './billing.api';
import {
  billingError,
  CONTRACT_STATUS,
  CONTRACT_TYPE,
  formatDecimal,
  isIsoDate,
  isMoney,
  RENEWAL,
} from './billing-model';

const TYPE_OPTIONS: readonly SelectOption[] = Object.entries(CONTRACT_TYPE).map(
  ([value, label]) => ({ value, label }),
);
const RENEWAL_OPTIONS: readonly SelectOption[] = Object.entries(RENEWAL).map(([value, label]) => ({
  value,
  label,
}));

/**
 * Contratos (M05): rascunho → activo (com número) → terminado; um activo cujo fim passou aparece como expirado (estado
 * derivado). Depois de activo, a contraparte, o tipo, o início e a moeda não mudam. O aviso de não renovação é o fim menos
 * os dias de pré-aviso.
 */
@Component({
  selector: 'app-billing-contracts',
  imports: [
    DatePipe,
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
        <h2 class="mb-4 text-base font-semibold">Novo contrato</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Organização"
            [required]="true"
            [options]="organizationOptions()"
            [ngModel]="form().organizationId"
            (ngModelChange)="patch({ organizationId: $event ?? '' })"
          />
          <app-input
            label="Procurar contraparte"
            placeholder="Nome (mínimo 2 letras)"
            [ngModel]="partyQuery()"
            (ngModelChange)="searchParties($event ?? '')"
          />
          <app-select
            label="Contraparte"
            placeholder="Escolha a contraparte"
            [required]="true"
            [options]="partyOptions()"
            [ngModel]="form().partyId"
            (ngModelChange)="patch({ partyId: $event ?? '' })"
          />
          <app-select
            label="Tipo"
            [options]="typeOptions"
            [ngModel]="form().type"
            (ngModelChange)="patch({ type: $event ?? 'SERVICE' })"
          />
          <app-input
            label="Título"
            [required]="true"
            [ngModel]="form().title"
            (ngModelChange)="patch({ title: $event ?? '' })"
          />
          <app-input
            label="Valor"
            [ngModel]="form().amount"
            (ngModelChange)="patch({ amount: $event ?? '' })"
          />
          <app-input
            label="Início (AAAA-MM-DD)"
            [required]="true"
            [ngModel]="form().startDate"
            (ngModelChange)="patch({ startDate: $event ?? '' })"
          />
          <app-input
            label="Fim (AAAA-MM-DD)"
            [ngModel]="form().endDate"
            (ngModelChange)="patch({ endDate: $event ?? '' })"
          />
          <app-select
            label="Renovação"
            [options]="renewalOptions"
            [ngModel]="form().renewalMode"
            (ngModelChange)="patch({ renewalMode: $event ?? 'NONE' })"
          />
          <app-input
            label="Pré-aviso (dias)"
            [ngModel]="form().noticeDays"
            (ngModelChange)="patch({ noticeDays: $event ?? '' })"
          />
        </div>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (contract(); as c) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ c.title }}
            <app-badge class="ms-2" [tone]="status(c).tone">{{ status(c).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted">{{ c.number ?? 'Sem número (rascunho)' }}</span>
        </div>
        <dl class="mt-4 grid gap-2 text-sm sm:grid-cols-2" data-testid="contract-facts">
          <div>Tipo: {{ type(c) }}</div>
          <div>Contraparte: {{ partyName(c.partyId) }}</div>
          <div>
            Vigência: {{ c.startDate | date: 'dd/MM/yyyy' }} —
            {{ c.endDate ? (c.endDate | date: 'dd/MM/yyyy') : 'sem fim' }}
          </div>
          <div>Valor: {{ c.amount ? money(c.amount) + ' ' + c.currency : '—' }}</div>
          <div>{{ renewal(c) }}</div>
          <div>
            Aviso de não renovação até:
            {{ c.noticeDeadline ? (c.noticeDeadline | date: 'dd/MM/yyyy') : '—' }}
          </div>
          @if (c.terminateReason) {
            <div class="sm:col-span-2">Terminado: {{ c.terminateReason }}</div>
          }
        </dl>
        @if (c.status !== 'TERMINATED' && canManage()) {
          <div class="mt-4 grid max-w-xl gap-3 sm:grid-cols-3">
            <app-input
              label="Novo valor"
              [ngModel]="editAmount()"
              (ngModelChange)="editAmount.set($event ?? '')"
            />
            <app-input
              label="Novo fim"
              [ngModel]="editEnd()"
              (ngModelChange)="editEnd.set($event ?? '')"
            />
            <div class="flex items-end">
              <app-button variant="secondary" [loading]="busy()" (click)="save()"
                >Guardar alterações</app-button
              >
            </div>
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap items-end gap-2">
          @if (c.status === 'DRAFT' && canManage()) {
            <app-button [loading]="busy()" (click)="activate()">Activar</app-button>
          }
          @if (c.status === 'ACTIVE' && canManage()) {
            <div class="min-w-56">
              <app-input
                label="Motivo do fim"
                [ngModel]="reason()"
                (ngModelChange)="reason.set($event ?? '')"
              />
            </div>
            <app-button variant="secondary" [loading]="busy()" (click)="terminate()"
              >Terminar</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
        @if (canManage()) {
          <app-button (click)="startNew()">Novo contrato</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (contracts.isLoading() && !contracts.hasValue()) {
          <app-loading-state label="A carregar contratos…" />
        } @else if (contracts.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar os contratos">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (contracts.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="document" title="Sem contratos" />
          } @else {
            <app-table
              caption="Contratos"
              [columns]="columns"
              [rows]="page.items"
              data-testid="contracts"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('title') {
                    <span class="font-medium">{{ row.title }}</span>
                  }
                  @case ('number') {
                    {{ row.number ?? '—' }}
                  }
                  @case ('type') {
                    {{ type(row) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('end') {
                    {{ row.endDate ? (row.endDate | date: 'dd/MM/yyyy') : '—' }}
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
export class ContractsTab {
  private readonly api = inject(BillingApi);
  private readonly orderApi = inject(OrdersApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('contract.manage'));
  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly renewalOptions = RENEWAL_OPTIONS;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'title', label: 'Título' },
    { key: 'number', label: 'Número' },
    { key: 'type', label: 'Tipo' },
    { key: 'status', label: 'Estado' },
    { key: 'end', label: 'Fim' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  protected readonly contracts = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
    },
    stream: () => this.api.contracts({ limit: 100 }),
  });
  /** Organizações dos clientes (a lista de clientes traz a organização; sem `customer.read` vem vazia). */
  private readonly customers = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.orderApi.customers(),
  });

  protected readonly creating = signal(false);
  protected readonly form = signal({
    organizationId: '',
    partyId: '',
    type: 'SERVICE' as string,
    title: '',
    amount: '',
    startDate: '',
    endDate: '',
    renewalMode: 'NONE' as string,
    noticeDays: '0' as string | number,
  });
  protected readonly partyQuery = signal('');
  protected readonly parties = signal<readonly PartyOption[]>([]);
  protected readonly contract = signal<ContractDto | null>(null);
  protected readonly editAmount = signal('');
  protected readonly editEnd = signal('');
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly organizationOptions = computed<readonly SelectOption[]>(() => {
    const seen = new Map<string, string>();
    for (const c of this.customers.hasValue() ? this.customers.value() : []) {
      seen.set(c.organizationId, c.organizationId.slice(0, 8));
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  });
  protected readonly partyOptions = computed<readonly SelectOption[]>(() =>
    this.parties().map((p) => ({ value: p.id, label: p.displayName })),
  );

  protected money = formatDecimal;
  protected status = (c: ContractDto) => CONTRACT_STATUS[c.effectiveStatus];
  protected type = (c: ContractDto) => CONTRACT_TYPE[c.type];
  protected renewal = (c: ContractDto) => RENEWAL[c.renewalMode];
  protected loadError = () => billingError(this.contracts.error(), 'Pedido falhado.');

  protected partyName(id: string): string {
    return this.parties().find((p) => p.id === id)?.displayName ?? id.slice(0, 8);
  }

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
        this.actionError.set(billingError(error, 'Não foi possível concluir a operação.')),
    });
  }

  private show(c: ContractDto): void {
    this.contract.set(c);
    this.editAmount.set(c.amount ?? '');
    this.editEnd.set(c.endDate ?? '');
  }

  protected patch(change: Partial<ReturnType<typeof this.form>>): void {
    this.form.update((f) => ({ ...f, ...change }));
  }

  protected searchParties(q: string): void {
    this.partyQuery.set(q);
    if (q.trim().length < 2) return void this.parties.set([]);
    this.api.parties(q.trim()).subscribe({
      next: (list) => this.parties.set(list),
      error: () => this.parties.set([]),
    });
  }

  protected startNew(): void {
    this.reset();
    this.form.set({
      organizationId: this.organizationOptions()[0]?.value ?? '',
      partyId: '',
      type: 'SERVICE',
      title: '',
      amount: '',
      startDate: '',
      endDate: '',
      renewalMode: 'NONE',
      noticeDays: '0',
    });
    this.partyQuery.set('');
    this.parties.set([]);
    this.creating.set(true);
  }

  protected create(): void {
    this.reset();
    const f = this.form();
    if (!f.organizationId) return void this.clientError.set('Escolha a organização.');
    if (!f.partyId) return void this.clientError.set('Escolha a contraparte.');
    if (!f.title.trim()) return void this.clientError.set('Indique o título.');
    if (!isIsoDate(f.startDate)) return void this.clientError.set('Início inválido (AAAA-MM-DD).');
    if (f.endDate && !isIsoDate(f.endDate)) {
      return void this.clientError.set('Fim inválido (AAAA-MM-DD).');
    }
    if (f.amount && !isMoney(f.amount)) {
      return void this.clientError.set('Valor com até 4 casas.');
    }
    const notice = Number(f.noticeDays);
    if (!Number.isInteger(notice) || notice < 0) {
      return void this.clientError.set('Pré-aviso: número inteiro de dias.');
    }
    this.run(
      this.api.createContract({
        organizationId: f.organizationId,
        partyId: f.partyId,
        type: f.type as ContractType,
        title: f.title.trim(),
        startDate: f.startDate,
        endDate: f.endDate || null,
        amount: f.amount.trim() || null,
        renewalMode: f.renewalMode as RenewalMode,
        noticeDays: notice,
      }),
      (created) => {
        this.creating.set(false);
        this.show(created);
        this.notice.set('Rascunho criado. Active o contrato quando estiver acordado.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: ContractDto): void {
    this.reset();
    this.run(this.api.contract(row.id), (full) => this.show(full));
  }

  protected close(): void {
    this.contract.set(null);
    this.creating.set(false);
    this.reason.set('');
    this.reload.update((n) => n + 1);
  }

  protected save(): void {
    const current = this.contract();
    if (!current) return;
    this.reset();
    if (this.editEnd() && !isIsoDate(this.editEnd())) {
      return void this.clientError.set('Fim inválido (AAAA-MM-DD).');
    }
    if (this.editAmount() && !isMoney(this.editAmount())) {
      return void this.clientError.set('Valor com até 4 casas.');
    }
    this.run(
      this.api.updateContract(current.id, current.version, {
        amount: this.editAmount().trim() || null,
        endDate: this.editEnd() || null,
      }),
      (saved) => {
        this.show(saved);
        this.notice.set('Contrato actualizado.');
      },
    );
  }

  protected activate(): void {
    const current = this.contract();
    if (!current) return;
    this.reset();
    this.run(this.api.activateContract(current.id), (result) => {
      this.show(result.contract);
      this.notice.set(
        result.idempotent
          ? 'O contrato já estava activo.'
          : `Contrato ${result.contract.number} activado.`,
      );
    });
  }

  protected terminate(): void {
    const current = this.contract();
    if (!current) return;
    this.reset();
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo do fim.');
    this.run(this.api.terminateContract(current.id, this.reason().trim()), (result) => {
      this.show(result.contract);
      this.reason.set('');
      this.notice.set('Contrato terminado.');
    });
  }
}
