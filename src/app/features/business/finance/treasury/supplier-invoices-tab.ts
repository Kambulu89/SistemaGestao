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
  type NewSupplierInvoiceLine,
  type SupplierInvoiceDto,
  type SupplierInvoiceStatus,
} from './finance.api';
import {
  financeError,
  formatDecimal,
  isIsoDate,
  isMoney,
  isTaxRate,
  SUPPLIER_INVOICE_STATUS,
} from './finance-model';

const STATUSES: readonly SelectOption[] = [
  { value: '', label: 'Todos' },
  ...Object.entries(SUPPLIER_INVOICE_STATUS).map(([value, v]) => ({ value, label: v.label })),
];

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

const emptyLine = (): DraftLine => ({
  description: '',
  quantity: '1',
  unitPrice: '',
  taxRate: '0',
});

/**
 * Facturas de fornecedor. Validar confere a factura (com encomenda: não se factura mais do que o recebido nem a preço
 * acima do encomendado) e cria a conta a pagar. Com divergências fica «em disputa» e só avança com justificação, por
 * quem tem a permissão de excepção. Validada é imutável.
 */
@Component({
  selector: 'app-finance-supplier-invoices',
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
        <h2 class="mb-4 text-base font-semibold">Nova factura de fornecedor</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Fornecedor"
            [required]="true"
            [options]="supplierOptions()"
            [ngModel]="supplierId()"
            (ngModelChange)="supplierId.set($event ?? '')"
          />
          <app-input
            label="Número da factura"
            [required]="true"
            [ngModel]="externalNumber()"
            (ngModelChange)="externalNumber.set($event ?? '')"
          />
          <app-input
            label="Data (AAAA-MM-DD)"
            [ngModel]="invoiceDate()"
            (ngModelChange)="invoiceDate.set($event ?? '')"
          />
          <app-input
            label="Vencimento (AAAA-MM-DD)"
            placeholder="Por omissão: data + prazo do fornecedor"
            [ngModel]="dueOn()"
            (ngModelChange)="dueOn.set($event ?? '')"
          />
        </div>
        <h3 class="mb-2 mt-5 text-sm font-semibold">Linhas</h3>
        @for (line of lines(); track $index; let i = $index) {
          <div class="mb-2 grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]" data-testid="draft-line">
            <app-input
              label="Descrição"
              [ngModel]="line.description"
              (ngModelChange)="patchLine(i, { description: $event ?? '' })"
            />
            <app-input
              label="Quantidade"
              [ngModel]="line.quantity"
              (ngModelChange)="patchLine(i, { quantity: $event ?? '' })"
            />
            <app-input
              label="Preço unitário"
              [ngModel]="line.unitPrice"
              (ngModelChange)="patchLine(i, { unitPrice: $event ?? '' })"
            />
            <app-input
              label="Imposto %"
              [ngModel]="line.taxRate"
              (ngModelChange)="patchLine(i, { taxRate: $event ?? '' })"
            />
            <div class="flex items-end">
              <app-button variant="secondary" size="sm" (click)="removeLine(i)">Remover</app-button>
            </div>
          </div>
        }
        <app-button variant="secondary" size="sm" (click)="addLine()">Acrescentar linha</app-button>
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
            {{ inv.externalNumber }} — {{ inv.supplierName }}
            <app-badge class="ms-2" [tone]="status(inv).tone">{{ status(inv).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted" data-testid="invoice-total"
            >Total: {{ money(inv.totals.total) }} {{ inv.currency }}</span
          >
        </div>
        <p class="mt-2 text-sm text-fg-muted">
          Data {{ inv.invoiceDate }} · vence em {{ inv.dueOn }} · líquido
          {{ money(inv.totals.net) }} · imposto {{ money(inv.totals.tax) }}
        </p>
        @if (inv.overrideReason) {
          <p class="mt-2 text-sm" data-testid="override-reason">
            Excepção: {{ inv.overrideReason }}
          </p>
        }
        @if (inv.lines && inv.lines.length > 0) {
          <app-table
            class="mt-4 block"
            caption="Linhas da factura"
            [columns]="lineColumns"
            [rows]="inv.lines"
            data-testid="invoice-lines"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('description') {
                  {{ row.description }}
                }
                @case ('quantity') {
                  {{ row.quantity }}
                }
                @case ('unitPrice') {
                  {{ money(row.unitPrice) }}
                }
                @case ('total') {
                  {{ money(row.total) }}
                }
              }
            </ng-template>
          </app-table>
        }
        @if (inv.matching && inv.matching.length > 0) {
          <app-alert tone="warning" title="Divergências na conferência" class="mt-4 block">
            <ul data-testid="matching">
              @for (d of inv.matching; track $index) {
                <li>{{ d.message }}</li>
              }
            </ul>
          </app-alert>
        }
        @if (inv.status === 'DISPUTED' && canOverride()) {
          <div class="mt-4 max-w-md">
            <app-input
              label="Justificação da excepção"
              [ngModel]="overrideReason()"
              (ngModelChange)="overrideReason.set($event ?? '')"
            />
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap gap-2">
          @if (canValidate() && (inv.status === 'DRAFT' || inv.status === 'DISPUTED')) {
            <app-button [loading]="busy()" (click)="validate(inv, false)">Validar</app-button>
            @if (inv.status === 'DISPUTED' && canOverride()) {
              <app-button variant="secondary" [loading]="busy()" (click)="validate(inv, true)"
                >Validar com excepção</app-button
              >
            }
            <app-button variant="secondary" [loading]="busy()" (click)="voidInvoice(inv)"
              >Anular</app-button
            >
          }
          @if (canManage() && inv.status === 'DRAFT') {
            <app-button variant="secondary" [loading]="busy()" (click)="remove(inv)"
              >Apagar</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-48">
          <app-select
            label="Estado"
            [options]="statuses"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($any($event ?? ''))"
          />
        </div>
        @if (canManage()) {
          <app-button (click)="startNew()">Nova factura</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (list.isLoading() && !list.hasValue()) {
          <app-loading-state label="A carregar facturas…" />
        } @else if (list.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as facturas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (list.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="card" title="Sem facturas de fornecedor" />
          } @else {
            <app-table
              caption="Facturas de fornecedor"
              [columns]="columns"
              [rows]="page.items"
              data-testid="supplier-invoices"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.externalNumber }}</span>
                  }
                  @case ('supplier') {
                    {{ row.supplierName }}
                  }
                  @case ('due') {
                    {{ row.dueOn }}
                  }
                  @case ('total') {
                    {{ money(row.totals.total) }} {{ row.currency }}
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
export class SupplierInvoicesTab {
  private readonly api = inject(FinanceApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly statuses = STATUSES;
  protected readonly canManage = computed(() => this.permissions.can('supplier_invoice.manage'));
  protected readonly canValidate = computed(() =>
    this.permissions.can('supplier_invoice.validate'),
  );
  protected readonly canOverride = computed(() =>
    this.permissions.can('supplier_invoice.override'),
  );
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Factura' },
    { key: 'supplier', label: 'Fornecedor' },
    { key: 'due', label: 'Vencimento' },
    { key: 'total', label: 'Total', align: 'end' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];
  protected readonly lineColumns: readonly TableColumn[] = [
    { key: 'description', label: 'Descrição' },
    { key: 'quantity', label: 'Quantidade', align: 'end' },
    { key: 'unitPrice', label: 'Preço', align: 'end' },
    { key: 'total', label: 'Total', align: 'end' },
  ];

  private readonly reload = signal(0);
  protected readonly statusFilter = signal<SupplierInvoiceStatus | ''>('');
  protected readonly list = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? { tenantId: tenant.id, status: this.statusFilter(), reload: this.reload() }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.supplierInvoices({ status: params.status || undefined, limit: 100 }),
  });
  private readonly suppliers = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant && this.canManage() ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.api.suppliers(),
  });

  protected readonly invoice = signal<SupplierInvoiceDto | null>(null);
  protected readonly creating = signal(false);
  protected readonly supplierId = signal('');
  protected readonly externalNumber = signal('');
  protected readonly invoiceDate = signal('');
  protected readonly dueOn = signal('');
  protected readonly lines = signal<readonly DraftLine[]>([emptyLine()]);
  protected readonly overrideReason = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly supplierOptions = computed<readonly SelectOption[]>(() =>
    (this.suppliers.hasValue() ? this.suppliers.value() : []).map((s) => ({
      value: s.id,
      label: `${s.code} — ${s.partyName}`,
    })),
  );

  protected money = formatDecimal;
  protected status = (i: SupplierInvoiceDto) => SUPPLIER_INVOICE_STATUS[i.status];
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

  protected startNew(): void {
    this.reset();
    this.supplierId.set(this.supplierOptions()[0]?.value ?? '');
    this.externalNumber.set('');
    this.invoiceDate.set('');
    this.dueOn.set('');
    this.lines.set([emptyLine()]);
    this.creating.set(true);
  }

  protected addLine(): void {
    this.lines.update((l) => [...l, emptyLine()]);
  }

  protected removeLine(index: number): void {
    this.lines.update((l) => l.filter((_, i) => i !== index));
  }

  protected patchLine(index: number, patch: Partial<DraftLine>): void {
    this.lines.update((l) => l.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  protected create(): void {
    this.reset();
    if (!this.supplierId()) return void this.clientError.set('Escolha o fornecedor.');
    if (!this.externalNumber().trim()) {
      return void this.clientError.set('Indique o número da factura do fornecedor.');
    }
    const date = this.invoiceDate().trim();
    const due = this.dueOn().trim();
    if (date && !isIsoDate(date)) return void this.clientError.set('Data inválida (AAAA-MM-DD).');
    if (due && !isIsoDate(due))
      return void this.clientError.set('Vencimento inválido (AAAA-MM-DD).');
    const lines: NewSupplierInvoiceLine[] = [];
    for (const [i, line] of this.lines().entries()) {
      const n = i + 1;
      if (!line.description.trim())
        return void this.clientError.set(`Linha ${n}: indique a descrição.`);
      if (!isMoney(line.quantity) || !/[1-9]/.test(line.quantity)) {
        return void this.clientError.set(`Linha ${n}: quantidade positiva.`);
      }
      if (!isMoney(line.unitPrice)) return void this.clientError.set(`Linha ${n}: preço inválido.`);
      if (!isTaxRate(line.taxRate))
        return void this.clientError.set(`Linha ${n}: imposto inválido.`);
      lines.push({
        description: line.description.trim(),
        quantity: line.quantity.trim(),
        unitPrice: line.unitPrice.trim(),
        taxRate: line.taxRate.trim(),
      });
    }
    this.run(
      this.api.createSupplierInvoice({
        supplierId: this.supplierId(),
        externalNumber: this.externalNumber().trim(),
        ...(date ? { invoiceDate: date } : {}),
        ...(due ? { dueOn: due } : {}),
        lines,
      }),
      (created) => {
        this.creating.set(false);
        this.invoice.set(created);
        this.notice.set('Rascunho criado.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: SupplierInvoiceDto): void {
    this.reset();
    this.overrideReason.set('');
    this.api.supplierInvoice(row.id).subscribe({
      next: (inv) => this.invoice.set(inv),
      error: (error: unknown) =>
        this.actionError.set(financeError(error, 'Não foi possível abrir a factura.')),
    });
  }

  protected close(): void {
    this.invoice.set(null);
    this.creating.set(false);
    this.reload.update((n) => n + 1);
  }

  protected validate(inv: SupplierInvoiceDto, override: boolean): void {
    this.reset();
    const reason = this.overrideReason().trim();
    if (override && !reason)
      return void this.clientError.set('Indique a justificação da excepção.');
    this.run(this.api.validateSupplierInvoice(inv.id, override ? reason : undefined), (saved) => {
      this.invoice.set(saved);
      this.notice.set(
        saved.status === 'VALIDATED'
          ? 'Factura validada: a conta a pagar foi criada.'
          : 'A factura tem divergências e ficou em disputa.',
      );
    });
  }

  protected voidInvoice(inv: SupplierInvoiceDto): void {
    this.reset();
    this.run(this.api.voidSupplierInvoice(inv.id), (saved) => {
      this.invoice.set(saved);
      this.notice.set('Factura anulada.');
    });
  }

  protected remove(inv: SupplierInvoiceDto): void {
    this.reset();
    this.run(this.api.deleteSupplierInvoice(inv.id), () => {
      this.invoice.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }
}
