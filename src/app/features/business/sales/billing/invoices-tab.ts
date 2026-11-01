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
import { isPositiveQuantity } from '../orders/orders-model';
import { BillingApi, type BillableLine, type InvoiceDto } from './billing.api';
import {
  billingError,
  formatDecimal,
  INVOICE_STATUS,
  isIsoDate,
  isMoney,
  isTaxRate,
  isZeroRate,
  trimQuantity,
} from './billing-model';

type Mode = 'order' | 'free';

const BILLABLE_ORDERS = new Set(['CONFIRMED', 'PARTIAL', 'FULFILLED']);

/**
 * Facturas (M05): de uma encomenda (o facturável segue a expedição nos bens com stock) ou de linhas livres. O servidor
 * calcula os valores, numera, fixa o cliente e a morada ao emitir e nunca deixa alterar uma factura emitida. O estado de
 * pagamento não existe ainda (módulo Finanças): a lista não o mostra.
 */
@Component({
  selector: 'app-billing-invoices',
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
        <h2 class="mb-4 text-base font-semibold">Nova factura</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Origem"
            [options]="modeOptions"
            [ngModel]="mode()"
            (ngModelChange)="setMode($event)"
          />
          @if (mode() === 'order') {
            <app-select
              label="Encomenda"
              placeholder="Escolha a encomenda a facturar"
              [required]="true"
              [options]="orderOptions()"
              [ngModel]="orderId()"
              (ngModelChange)="chooseOrder($event ?? '')"
            />
          } @else {
            <app-select
              label="Cliente"
              placeholder="Escolha o cliente"
              [required]="true"
              [options]="customerOptions()"
              [ngModel]="customerId()"
              (ngModelChange)="customerId.set($event ?? '')"
            />
          }
        </div>
        @if (mode() === 'order' && orderId()) {
          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm" data-testid="billable-lines">
              <thead>
                <tr class="text-left text-fg-muted">
                  <th class="py-1 pe-3">Artigo</th>
                  <th class="py-1 pe-3 text-end">Encomendada</th>
                  <th class="py-1 pe-3 text-end">Expedida</th>
                  <th class="py-1 pe-3 text-end">Facturada</th>
                  <th class="py-1 pe-3 text-end">Facturável</th>
                  <th class="py-1 w-40">A facturar agora</th>
                </tr>
              </thead>
              <tbody>
                @for (line of billable(); track line.orderLineId) {
                  <tr class="border-t border-line">
                    <td class="py-2 pe-3">{{ line.description }}</td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.ordered) }}</td>
                    <td class="py-2 pe-3 text-end">
                      {{ line.stockTracked ? trim(line.shipped) : '—' }}
                    </td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.billed) }}</td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.billable) }}</td>
                    <td class="py-2">
                      @if (line.billable !== '0.000000') {
                        <input
                          class="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"
                          [attr.aria-label]="'Quantidade de ' + line.description"
                          [value]="quantities()[line.orderLineId] ?? ''"
                          (input)="setQuantity(line.orderLineId, $any($event.target).value)"
                        />
                      } @else {
                        —
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (invoice(); as inv) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ inv.number ?? 'Factura em rascunho' }}
            <app-badge class="ms-2" [tone]="status(inv).tone">{{ status(inv).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted">
            {{ customerName(inv) }} · {{ inv.currency }}
            @if (inv.issuedOn) {
              · emitida em {{ inv.issuedOn | date: 'dd/MM/yyyy' }}
            }
          </span>
        </div>
        @if (inv.customerSnapshot; as snap) {
          <p class="mt-2 text-sm text-fg-muted" data-testid="snapshot">
            {{ snap.name }}
            @if (snap.taxId) {
              · NIF {{ snap.taxId }}
            }
            @if (snap.billingAddress; as a) {
              · {{ a.line1 }}, {{ a.city }} ({{ a.countryCode }})
            }
          </p>
        }
        <p class="mt-2 text-sm">
          Vencimento:
          @if (inv.status === 'DRAFT' && canManage()) {
            <input
              type="date"
              class="h-8 rounded-lg border border-line bg-surface px-2 text-sm"
              aria-label="Vencimento"
              [value]="dueOn()"
              (change)="dueOn.set($any($event.target).value)"
            />
          } @else {
            <strong>{{ inv.dueOn | date: 'dd/MM/yyyy' }}</strong>
          }
        </p>
        <div class="mt-4 overflow-x-auto">
          <table class="w-full text-sm" data-testid="invoice-lines">
            <thead>
              <tr class="text-left text-fg-muted">
                <th class="py-1 pe-3">Descrição</th>
                <th class="py-1 pe-3 text-end">Qtd.</th>
                <th class="py-1 pe-3 text-end">Preço</th>
                <th class="py-1 pe-3 text-end">Líquido</th>
                <th class="py-1 pe-3 text-end">Imposto</th>
                <th class="py-1 pe-3 text-end">Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (line of inv.lines ?? []; track line.id) {
                <tr class="border-t border-line">
                  <td class="py-2 pe-3">
                    {{ line.description }}
                    @if (line.exemptionReason) {
                      <span class="block text-xs text-fg-muted">{{ line.exemptionReason }}</span>
                    }
                  </td>
                  <td class="py-2 pe-3 text-end">{{ trim(line.quantity) }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.unitPrice) }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.netAmount) }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.taxAmount) }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.total) }}</td>
                  <td class="py-2 text-end">
                    @if (inv.status === 'DRAFT' && canManage()) {
                      <app-button size="sm" variant="secondary" (click)="removeLine(line.id)"
                        >Remover</app-button
                      >
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="7" class="py-2 text-fg-muted">Sem linhas.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="mt-3 text-end text-sm" data-testid="invoice-totals">
          Líquido {{ money(inv.totals.net) }} · Imposto {{ money(inv.totals.tax) }} ·
          <strong>Total {{ money(inv.totals.total) }} {{ inv.currency }}</strong>
        </p>
        @if (inv.status === 'DRAFT' && canManage() && !inv.orderId) {
          <div class="mt-4 grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-5">
            <app-input
              label="Descrição"
              [ngModel]="line().description"
              (ngModelChange)="patchLine({ description: $event ?? '' })"
            />
            <app-input
              label="Quantidade"
              [ngModel]="line().quantity"
              (ngModelChange)="patchLine({ quantity: $event ?? '' })"
            />
            <app-input
              label="Preço sem imposto"
              [ngModel]="line().unitPrice"
              (ngModelChange)="patchLine({ unitPrice: $event ?? '' })"
            />
            <app-input
              label="Taxa (%)"
              [ngModel]="line().taxRate"
              (ngModelChange)="patchLine({ taxRate: $event ?? '' })"
            />
            <app-input
              label="Motivo da isenção"
              [ngModel]="line().exemptionReason"
              (ngModelChange)="patchLine({ exemptionReason: $event ?? '' })"
            />
            <div class="sm:col-span-5">
              <app-button variant="secondary" [loading]="busy()" (click)="addLine()"
                >Adicionar linha</app-button
              >
            </div>
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap items-end gap-2">
          @if (inv.status === 'DRAFT' && canIssue()) {
            <app-button [loading]="busy()" (click)="issue()">Emitir</app-button>
          }
          @if (inv.status === 'DRAFT' && canManage()) {
            <app-button variant="secondary" [loading]="busy()" (click)="remove()"
              >Apagar rascunho</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
        @if (canManage()) {
          <app-button (click)="startNew()">Nova factura</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (invoices.isLoading() && !invoices.hasValue()) {
          <app-loading-state label="A carregar facturas…" />
        } @else if (invoices.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as facturas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (invoices.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="document" title="Sem facturas" />
          } @else {
            <app-table
              caption="Facturas"
              [columns]="columns"
              [rows]="page.items"
              data-testid="invoices"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  }
                  @case ('customer') {
                    {{ customerName(row) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('due') {
                    {{ row.dueOn | date: 'dd/MM/yyyy' }}
                  }
                  @case ('total') {
                    {{ money(row.totals.total) }} {{ row.currency }}
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
export class InvoicesTab {
  private readonly api = inject(BillingApi);
  private readonly orderApi = inject(OrdersApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('invoice.manage'));
  protected readonly canIssue = computed(() => this.permissions.can('invoice.issue'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'customer', label: 'Cliente' },
    { key: 'status', label: 'Estado' },
    { key: 'due', label: 'Vencimento' },
    { key: 'total', label: 'Total', align: 'end' },
    { key: 'actions', label: '', align: 'end' },
  ];
  protected readonly modeOptions: readonly SelectOption[] = [
    { value: 'order', label: 'De uma encomenda' },
    { value: 'free', label: 'Linhas livres' },
  ];

  private readonly reload = signal(0);
  private readonly params = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
  };
  protected readonly invoices = rxResource({
    params: this.params,
    stream: () => this.api.invoices({ limit: 100 }),
  });
  private readonly orders = rxResource({
    params: this.params,
    stream: () => this.orderApi.orders({ limit: 200 }),
  });
  private readonly customers = rxResource({
    params: this.params,
    stream: () => this.orderApi.customers(),
  });

  protected readonly creating = signal(false);
  protected readonly mode = signal<Mode>('order');
  protected readonly orderId = signal('');
  protected readonly customerId = signal('');
  protected readonly billable = signal<readonly BillableLine[]>([]);
  protected readonly quantities = signal<Readonly<Record<string, string>>>({});
  protected readonly invoice = signal<InvoiceDto | null>(null);
  protected readonly dueOn = signal('');
  protected readonly line = signal({
    description: '',
    quantity: '1',
    unitPrice: '',
    taxRate: '14',
    exemptionReason: '',
  });
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly orderOptions = computed<readonly SelectOption[]>(() =>
    (this.orders.hasValue() ? this.orders.value().items : [])
      .filter((o) => BILLABLE_ORDERS.has(o.status))
      .map((o) => ({ value: o.id, label: `${o.number} — ${o.totals.total} ${o.currency}` })),
  );
  protected readonly customerOptions = computed<readonly SelectOption[]>(() =>
    (this.customers.hasValue() ? this.customers.value() : []).map((c) => ({
      value: c.id,
      label: `${c.code} — ${c.partyName}`,
    })),
  );

  protected trim = trimQuantity;
  protected money = formatDecimal;
  protected status = (i: InvoiceDto) => INVOICE_STATUS[i.status];
  protected loadError = () => billingError(this.invoices.error(), 'Pedido falhado.');

  protected customerName(inv: InvoiceDto): string {
    if (inv.customerSnapshot) return inv.customerSnapshot.name;
    const found = (this.customers.hasValue() ? this.customers.value() : []).find(
      (c) => c.id === inv.customerId,
    );
    return found?.partyName ?? inv.customerId.slice(0, 8);
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

  private show(inv: InvoiceDto): void {
    this.invoice.set(inv);
    this.dueOn.set(inv.dueOn);
  }

  protected startNew(): void {
    this.reset();
    this.mode.set('order');
    this.orderId.set('');
    this.customerId.set('');
    this.billable.set([]);
    this.quantities.set({});
    this.creating.set(true);
  }

  protected setMode(mode: string | null): void {
    this.mode.set(mode === 'free' ? 'free' : 'order');
    this.clientError.set(null);
  }

  protected chooseOrder(id: string): void {
    this.orderId.set(id);
    this.billable.set([]);
    this.quantities.set({});
    if (!id) return;
    this.run(this.api.billable(id), (lines) => {
      this.billable.set(lines);
      // Por omissão factura-se tudo o que está facturável.
      this.quantities.set(
        Object.fromEntries(
          lines
            .filter((l) => l.billable !== '0.000000')
            .map((l) => [l.orderLineId, trimQuantity(l.billable).replace(',', '.')] as const),
        ),
      );
    });
  }

  protected setQuantity(lineId: string, value: string): void {
    this.quantities.update((q) => ({ ...q, [lineId]: value }));
  }

  protected create(): void {
    this.reset();
    if (this.mode() === 'free') {
      const customer = (this.customers.hasValue() ? this.customers.value() : []).find(
        (c) => c.id === this.customerId(),
      );
      if (!customer) return void this.clientError.set('Escolha o cliente.');
      return this.run(
        this.api.createInvoice({
          organizationId: customer.organizationId,
          customerId: customer.id,
        }),
        (created) => {
          this.creating.set(false);
          this.show(created);
          this.notice.set('Rascunho criado. Acrescente as linhas e emita a factura.');
          this.reload.update((n) => n + 1);
        },
      );
    }
    if (!this.orderId()) return void this.clientError.set('Escolha a encomenda.');
    const lines: { orderLineId: string; quantity: string }[] = [];
    for (const line of this.billable()) {
      const quantity = (this.quantities()[line.orderLineId] ?? '').trim();
      if (quantity === '' || quantity === '0') continue;
      if (!isPositiveQuantity(quantity) || this.exceeds(quantity, line.billable)) {
        return void this.clientError.set(
          `«${line.description}»: quantidade positiva até ${trimQuantity(line.billable)}.`,
        );
      }
      lines.push({ orderLineId: line.orderLineId, quantity });
    }
    if (lines.length === 0)
      return void this.clientError.set('Indique a quantidade de pelo menos uma linha.');
    this.run(this.api.createInvoice({ orderId: this.orderId(), lines }), (created) => {
      this.creating.set(false);
      this.show(created);
      this.notice.set('Rascunho criado. Reveja as linhas e emita a factura.');
      this.reload.update((n) => n + 1);
    });
  }

  /** Compara decimais exactos (6 casas) sem `number`. */
  private exceeds(quantity: string, max: string): boolean {
    const scaled = (value: string): bigint => {
      const [int = '0', frac = ''] = value.trim().split('.');
      return BigInt(int + frac.padEnd(6, '0').slice(0, 6));
    };
    return scaled(quantity) > scaled(max);
  }

  protected open(row: InvoiceDto): void {
    this.reset();
    this.run(this.api.invoice(row.id), (full) => this.show(full));
  }

  protected close(): void {
    this.invoice.set(null);
    this.creating.set(false);
    this.reload.update((n) => n + 1);
  }

  protected patchLine(patch: Partial<ReturnType<typeof this.line>>): void {
    this.line.update((l) => ({ ...l, ...patch }));
  }

  protected addLine(): void {
    const current = this.invoice();
    if (!current) return;
    this.reset();
    const l = this.line();
    if (!l.description.trim()) return void this.clientError.set('Indique a descrição.');
    if (!isPositiveQuantity(l.quantity)) {
      return void this.clientError.set('Quantidade positiva com até 6 casas.');
    }
    if (!isMoney(l.unitPrice)) return void this.clientError.set('Preço com até 4 casas.');
    if (!isTaxRate(l.taxRate))
      return void this.clientError.set('Taxa em percentagem (até 4 casas).');
    if (isZeroRate(l.taxRate) && !l.exemptionReason.trim()) {
      return void this.clientError.set('Uma linha sem imposto exige o motivo da isenção.');
    }
    this.run(
      this.api.addInvoiceLine(current.id, {
        description: l.description.trim(),
        quantity: l.quantity.trim(),
        unitPrice: l.unitPrice.trim(),
        taxRate: l.taxRate.trim(),
        ...(isZeroRate(l.taxRate) ? { exemptionReason: l.exemptionReason.trim() } : {}),
      }),
      (updated) => {
        this.show(updated);
        this.line.update((x) => ({ ...x, description: '', unitPrice: '', exemptionReason: '' }));
      },
    );
  }

  protected removeLine(lineId: string): void {
    const current = this.invoice();
    if (!current) return;
    this.reset();
    this.run(this.api.removeInvoiceLine(current.id, lineId), (updated) => this.show(updated));
  }

  protected issue(): void {
    const current = this.invoice();
    if (!current) return;
    this.reset();
    if (this.dueOn() !== current.dueOn) {
      if (!isIsoDate(this.dueOn())) return void this.clientError.set('Vencimento inválido.');
      return this.run(
        this.api.updateInvoice(current.id, current.version, this.dueOn()),
        (saved) => {
          this.show(saved);
          this.issue();
        },
      );
    }
    this.run(this.api.issueInvoice(current.id), (result) => {
      this.show(result.invoice);
      this.notice.set(
        result.idempotent
          ? 'A factura já estava emitida.'
          : `Factura ${result.invoice.number} emitida.`,
      );
      this.reload.update((n) => n + 1);
    });
  }

  protected remove(): void {
    const current = this.invoice();
    if (!current) return;
    this.reset();
    this.run(this.api.deleteInvoice(current.id), () => {
      this.invoice.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }
}
