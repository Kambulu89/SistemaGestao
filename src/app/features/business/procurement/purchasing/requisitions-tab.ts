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
import { OrdersApi } from '../../sales/orders/orders.api';
import { PurchasingApi, type RequisitionDto } from './purchasing.api';
import {
  isIsoDate,
  isMoney,
  isPositiveQuantity,
  isTaxRate,
  purchasingError,
  REQUISITION_STATUS,
  trimQuantity,
} from './purchasing-model';

interface DraftLine {
  readonly variantId: string;
  readonly sku: string;
  readonly quantity: string;
}

/**
 * Requisições de compra (M06): o pedido interno. Submete-se (recebe número) e decide-se por outra pessoa; aprovada,
 * converte-se numa encomenda a fornecedor em rascunho com os custos indicados aqui.
 */
@Component({
  selector: 'app-purchasing-requisitions',
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
        <h2 class="mb-4 text-base font-semibold">Nova requisição</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Organização"
            [required]="true"
            [options]="organizationOptions()"
            [ngModel]="organizationId()"
            (ngModelChange)="organizationId.set($event ?? '')"
          />
          <app-input
            label="Necessária até (AAAA-MM-DD)"
            [ngModel]="neededOn()"
            (ngModelChange)="neededOn.set($event ?? '')"
          />
        </div>
        <ul class="mt-4 divide-y divide-line" data-testid="draft-lines">
          @for (line of lines(); track line.variantId) {
            <li class="flex items-center justify-between py-2 text-sm">
              <span>{{ line.sku }} × {{ line.quantity }}</span>
              <app-button size="sm" variant="secondary" (click)="removeDraftLine(line.variantId)"
                >Remover</app-button
              >
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem linhas.</li>
          }
        </ul>
        <div class="mt-3 grid items-end gap-3 sm:grid-cols-3">
          <app-input label="SKU" [ngModel]="sku()" (ngModelChange)="sku.set($event ?? '')" />
          <app-input
            label="Quantidade"
            [ngModel]="quantity()"
            (ngModelChange)="quantity.set($event ?? '')"
          />
          <app-button variant="secondary" [loading]="busy()" (click)="addDraftLine()"
            >Adicionar linha</app-button
          >
        </div>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (requisition(); as r) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ r.number ?? 'Requisição em rascunho' }}
            <app-badge class="ms-2" [tone]="status(r).tone">{{ status(r).label }}</app-badge>
          </h2>
          @if (r.neededOn) {
            <span class="text-sm text-fg-muted"
              >Necessária até {{ r.neededOn | date: 'dd/MM/yyyy' }}</span
            >
          }
        </div>
        @if (r.decisionReason) {
          <p class="mt-2 text-sm">Decisão: {{ r.decisionReason }}</p>
        }
        <ul class="mt-4 divide-y divide-line" data-testid="requisition-lines">
          @for (line of r.lines ?? []; track line.id) {
            <li class="flex items-center justify-between py-2 text-sm">
              <span>{{ line.description }}</span>
              <strong>{{ trim(line.quantity) }}</strong>
            </li>
          }
        </ul>

        @if (r.status === 'APPROVED' && canConvert()) {
          <div class="mt-4 rounded-lg border border-line p-3" data-testid="convert">
            <app-select
              label="Fornecedor"
              placeholder="Escolha o fornecedor"
              [required]="true"
              [options]="supplierOptions()"
              [ngModel]="supplierId()"
              (ngModelChange)="supplierId.set($event ?? '')"
            />
            <div class="mt-3 grid gap-2">
              @for (line of r.lines ?? []; track line.id) {
                <div class="grid items-end gap-2 sm:grid-cols-3">
                  <span class="text-sm">{{ line.description }}</span>
                  <input
                    class="h-9 rounded-lg border border-line bg-surface px-2 text-sm"
                    [attr.aria-label]="'Custo unitário de ' + line.description"
                    [value]="costs()[line.variantId] ?? ''"
                    (input)="setCost(line.variantId, $any($event.target).value)"
                  />
                  <input
                    class="h-9 rounded-lg border border-line bg-surface px-2 text-sm"
                    [attr.aria-label]="'Taxa (%) de ' + line.description"
                    [value]="rates()[line.variantId] ?? '0'"
                    (input)="setRate(line.variantId, $any($event.target).value)"
                  />
                </div>
              }
            </div>
            <app-button class="mt-3 block" [loading]="busy()" (click)="convert()"
              >Converter em encomenda</app-button
            >
          </div>
        }
        @if (r.status === 'SUBMITTED' && canApprove()) {
          <div class="mt-4 max-w-md">
            <app-input
              label="Motivo da decisão"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event ?? '')"
            />
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap gap-2">
          @if (r.status === 'DRAFT' && canManage()) {
            <app-button [loading]="busy()" (click)="submit()">Submeter</app-button>
            <app-button variant="secondary" [loading]="busy()" (click)="remove()"
              >Apagar rascunho</app-button
            >
          }
          @if (r.status === 'SUBMITTED' && canApprove()) {
            <app-button [loading]="busy()" (click)="approve()">Aprovar</app-button>
            <app-button variant="secondary" [loading]="busy()" (click)="reject()"
              >Rejeitar</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
        @if (canManage()) {
          <app-button (click)="startNew()">Nova requisição</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (requisitions.isLoading() && !requisitions.hasValue()) {
          <app-loading-state label="A carregar requisições…" />
        } @else if (requisitions.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as requisições">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (requisitions.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="truck" title="Sem requisições" />
          } @else {
            <app-table
              caption="Requisições"
              [columns]="columns"
              [rows]="page.items"
              data-testid="requisitions"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  }
                  @case ('needed') {
                    {{ row.neededOn ? (row.neededOn | date: 'dd/MM/yyyy') : '—' }}
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
export class RequisitionsTab {
  private readonly api = inject(PurchasingApi);
  private readonly orderApi = inject(OrdersApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('requisition.manage'));
  protected readonly canApprove = computed(() => this.permissions.can('requisition.approve'));
  protected readonly canConvert = computed(() => this.permissions.can('purchase.manage'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'needed', label: 'Necessária até' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  private readonly params = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
  };
  protected readonly requisitions = rxResource({
    params: this.params,
    stream: () => this.api.requisitions({ limit: 100 }),
  });
  private readonly organizations = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.api.organizations(),
  });
  private readonly suppliers = rxResource({
    params: this.params,
    stream: () => this.api.suppliers({ status: 'ACTIVE', limit: 200 }),
  });

  protected readonly creating = signal(false);
  protected readonly organizationId = signal('');
  protected readonly neededOn = signal('');
  protected readonly lines = signal<readonly DraftLine[]>([]);
  protected readonly sku = signal('');
  protected readonly quantity = signal('1');
  protected readonly requisition = signal<RequisitionDto | null>(null);
  protected readonly supplierId = signal('');
  protected readonly costs = signal<Readonly<Record<string, string>>>({});
  protected readonly rates = signal<Readonly<Record<string, string>>>({});
  protected readonly reason = signal('');
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
  protected readonly supplierOptions = computed<readonly SelectOption[]>(() =>
    (this.suppliers.hasValue() ? this.suppliers.value().items : [])
      .filter((s) => s.organizationId === this.requisition()?.organizationId)
      .map((s) => ({ value: s.id, label: `${s.code} — ${s.partyName}` })),
  );

  protected trim = trimQuantity;
  protected status = (r: RequisitionDto) => REQUISITION_STATUS[r.status];
  protected loadError = () => purchasingError(this.requisitions.error(), 'Pedido falhado.');

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
        this.actionError.set(purchasingError(error, 'Não foi possível concluir a operação.')),
    });
  }

  private show(r: RequisitionDto): void {
    this.requisition.set(r);
    this.supplierId.set('');
    this.costs.set({});
    this.rates.set({});
  }

  protected startNew(): void {
    this.reset();
    this.organizationId.set(this.organizationOptions()[0]?.value ?? '');
    this.neededOn.set('');
    this.lines.set([]);
    this.sku.set('');
    this.quantity.set('1');
    this.creating.set(true);
  }

  protected addDraftLine(): void {
    this.reset();
    const sku = this.sku().trim();
    if (!sku) return void this.clientError.set('Indique o SKU.');
    if (!isPositiveQuantity(this.quantity().trim())) {
      return void this.clientError.set('Quantidade positiva com até 6 casas.');
    }
    this.run(this.orderApi.variantIdBySku(sku), (variantId) => {
      if (this.lines().some((l) => l.variantId === variantId)) {
        return void this.clientError.set('Esta variante já está na requisição.');
      }
      this.lines.update((list) => [...list, { variantId, sku, quantity: this.quantity().trim() }]);
      this.sku.set('');
      this.quantity.set('1');
    });
  }

  protected removeDraftLine(variantId: string): void {
    this.lines.update((list) => list.filter((l) => l.variantId !== variantId));
  }

  protected create(): void {
    this.reset();
    if (!this.organizationId()) return void this.clientError.set('Escolha a organização.');
    if (this.neededOn() && !isIsoDate(this.neededOn())) {
      return void this.clientError.set('Data inválida (AAAA-MM-DD).');
    }
    if (this.lines().length === 0)
      return void this.clientError.set('Acrescente pelo menos uma linha.');
    this.run(
      this.api.createRequisition({
        organizationId: this.organizationId(),
        neededOn: this.neededOn() || null,
        lines: this.lines().map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      }),
      (created) => {
        this.creating.set(false);
        this.show(created);
        this.notice.set('Rascunho criado. Submeta a requisição para ser aprovada.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: RequisitionDto): void {
    this.reset();
    this.run(this.api.requisition(row.id), (full) => this.show(full));
  }

  protected close(): void {
    this.requisition.set(null);
    this.creating.set(false);
    this.reason.set('');
    this.reload.update((n) => n + 1);
  }

  protected submit(): void {
    const current = this.requisition();
    if (!current) return;
    this.reset();
    this.run(this.api.submitRequisition(current.id), (result) => {
      this.show(result.requisition);
      this.notice.set(`Requisição ${result.requisition.number} submetida.`);
    });
  }

  protected approve(): void {
    const current = this.requisition();
    if (!current) return;
    this.reset();
    this.run(
      this.api.approveRequisition(current.id, this.reason().trim() || undefined),
      (result) => {
        this.show(result.requisition);
        this.reason.set('');
        this.notice.set('Requisição aprovada.');
      },
    );
  }

  protected reject(): void {
    const current = this.requisition();
    if (!current) return;
    this.reset();
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo da rejeição.');
    this.run(this.api.rejectRequisition(current.id, this.reason().trim()), (result) => {
      this.show(result.requisition);
      this.reason.set('');
      this.notice.set('Requisição rejeitada.');
    });
  }

  protected remove(): void {
    const current = this.requisition();
    if (!current) return;
    this.reset();
    this.run(this.api.deleteRequisition(current.id), () => {
      this.requisition.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }

  protected setCost(variantId: string, value: string): void {
    this.costs.update((c) => ({ ...c, [variantId]: value }));
  }

  protected setRate(variantId: string, value: string): void {
    this.rates.update((c) => ({ ...c, [variantId]: value }));
  }

  protected convert(): void {
    const current = this.requisition();
    if (!current) return;
    this.reset();
    if (!this.supplierId()) return void this.clientError.set('Escolha o fornecedor.');
    const lines: { variantId: string; unitCost: string; taxRate?: string }[] = [];
    for (const line of current.lines ?? []) {
      const unitCost = (this.costs()[line.variantId] ?? '').trim();
      const taxRate = (this.rates()[line.variantId] ?? '0').trim();
      if (!isMoney(unitCost)) {
        return void this.clientError.set(`«${line.description}»: indique o custo (até 4 casas).`);
      }
      if (!isTaxRate(taxRate)) {
        return void this.clientError.set(
          `«${line.description}»: taxa em percentagem (até 4 casas).`,
        );
      }
      lines.push({ variantId: line.variantId, unitCost, taxRate });
    }
    this.run(
      this.api.convertRequisition(current.id, { supplierId: this.supplierId(), lines }),
      (result) => {
        this.show({ ...current, status: 'CONVERTED', purchaseOrderId: result.order.id });
        this.notice.set(
          result.idempotent
            ? 'A requisição já estava convertida.'
            : 'Encomenda criada em rascunho: confirme-a no separador «Encomendas».',
        );
        this.reload.update((n) => n + 1);
      },
    );
  }
}
