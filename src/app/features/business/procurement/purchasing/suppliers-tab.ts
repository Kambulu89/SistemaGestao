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
import { Checkbox } from '../../../../shared/ui/checkbox/checkbox';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import {
  PurchasingApi,
  type ApprovalStatus,
  type PartyOption,
  type SupplierDto,
  type SupplierRating,
  type SupplyType,
} from './purchasing.api';
import {
  APPROVAL_STATUS,
  leadTimeValue,
  purchasingError,
  SUPPLIER_STATUS,
  SUPPLY_TYPE,
} from './purchasing-model';
import { SupplierApprovalPanel } from './supplier-approval-panel';

/**
 * Fornecedores (M06): as condições de compra sobre uma Party, por organização. Nome e NIF vêm da Party. Um fornecedor
 * bloqueado ou inactivo, com homologação rejeitada, suspensa ou caducada, ou crítico sem homologação em vigor, não recebe
 * novas encomendas (as já confirmadas continuam a receber-se). Classificação e homologação: bloco 9.1.
 */
@Component({
  selector: 'app-purchasing-suppliers',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    EmptyState,
    Input,
    LoadingState,
    Select,
    SupplierApprovalPanel,
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
        <h2 class="mb-4 text-base font-semibold">Novo fornecedor</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Organização"
            [required]="true"
            [options]="organizationOptions()"
            [ngModel]="organizationId()"
            (ngModelChange)="organizationId.set($event ?? '')"
          />
          <app-input
            label="Procurar pessoa ou organização"
            placeholder="Nome (mínimo 2 letras)"
            [ngModel]="partyQuery()"
            (ngModelChange)="searchParties($event ?? '')"
          />
          <app-select
            label="Pessoa ou organização"
            placeholder="Escolha a Party"
            [required]="true"
            [options]="partyOptions()"
            [ngModel]="partyId()"
            (ngModelChange)="partyId.set($event ?? '')"
          />
          <app-input
            label="Código"
            [required]="true"
            [ngModel]="code()"
            (ngModelChange)="code.set($event ?? '')"
          />
          <app-input
            label="Prazo de pagamento (dias)"
            [ngModel]="terms()"
            (ngModelChange)="terms.set($any($event ?? ''))"
          />
        </div>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar fornecedor</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (supplier(); as s) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ s.partyName }}
            <app-badge class="ms-2" [tone]="status(s).tone">{{ status(s).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted"
            >{{ s.code }} · {{ s.currency }} · {{ s.paymentTermDays }} dias</span
          >
        </div>
        <p class="mt-2 text-sm text-fg-muted">
          NIF: {{ s.taxId ?? '—' }} · {{ supplyLabel(s.supplyType) }}
          @if (s.categoryName) {
            · {{ s.categoryName }}
          }
          @if (s.critical) {
            · <strong>crítico</strong>
          }
          @if (s.rating) {
            · avaliação {{ s.rating }}
          }
          @if (s.leadTimeDays !== null) {
            · entrega em {{ s.leadTimeDays }} dias
          }
        </p>
        @if (s.notes) {
          <p class="mt-1 text-sm">{{ s.notes }}</p>
        }
        @if (s.statusReason) {
          <p class="mt-2 text-sm" data-testid="supplier-reason">Motivo: {{ s.statusReason }}</p>
        }
        @if (canManage()) {
          <div class="mt-4 flex flex-wrap items-end gap-2">
            @if (s.status === 'ACTIVE') {
              <div class="min-w-56">
                <app-input
                  label="Motivo do bloqueio"
                  [ngModel]="reason()"
                  (ngModelChange)="reason.set($event ?? '')"
                />
              </div>
              <app-button variant="secondary" [loading]="busy()" (click)="block()"
                >Bloquear</app-button
              >
            } @else {
              <app-button [loading]="busy()" (click)="activate()">Reactivar</app-button>
            }
          </div>
          <div class="mt-5 border-t border-line pt-4" data-testid="supplier-classification">
            <h3 class="mb-3 text-sm font-semibold">Classificação</h3>
            <div class="grid gap-3 sm:grid-cols-3">
              <app-select
                label="Categoria"
                placeholder="Sem categoria"
                [options]="categoryOptions()"
                [ngModel]="categoryId()"
                (ngModelChange)="categoryId.set($event ?? '')"
              />
              <app-select
                label="Fornece"
                [options]="supplyOptions"
                [ngModel]="supplyType()"
                (ngModelChange)="supplyType.set($event ?? 'GOODS')"
              />
              <app-select
                label="Avaliação"
                placeholder="Sem avaliação"
                [options]="ratingOptions"
                [ngModel]="rating()"
                (ngModelChange)="rating.set($event ?? '')"
              />
              <app-input
                label="Prazo de entrega (dias)"
                [ngModel]="leadTime()"
                (ngModelChange)="leadTime.set($any($event ?? ''))"
              />
              <app-input
                label="Observações"
                [ngModel]="notes()"
                (ngModelChange)="notes.set($event ?? '')"
              />
              <app-checkbox
                label="Fornecedor crítico (exige homologação para encomendar)"
                [ngModel]="critical()"
                (ngModelChange)="critical.set(!!$event)"
              />
            </div>
            <div class="mt-3">
              <app-button variant="secondary" [loading]="busy()" (click)="classify()"
                >Guardar classificação</app-button
              >
            </div>
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <app-supplier-approval-panel [supplier]="s" (changed)="approvalChanged($event)" />
        <div class="mt-4">
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-56">
          <app-select
            label="Homologação"
            placeholder="Todas"
            [options]="approvalOptions"
            [ngModel]="approvalFilter()"
            (ngModelChange)="approvalFilter.set($event ?? '')"
          />
        </div>
        @if (canManage()) {
          <app-button (click)="startNew()">Novo fornecedor</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (suppliers.isLoading() && !suppliers.hasValue()) {
          <app-loading-state label="A carregar fornecedores…" />
        } @else if (suppliers.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar os fornecedores">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (suppliers.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="truck" title="Sem fornecedores" />
          } @else {
            <app-table
              caption="Fornecedores"
              [columns]="columns"
              [rows]="page.items"
              data-testid="suppliers"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.partyName }}</span>
                  }
                  @case ('code') {
                    {{ row.code }}
                  }
                  @case ('taxId') {
                    {{ row.taxId ?? '—' }}
                  }
                  @case ('terms') {
                    {{ row.paymentTermDays }} dias
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('approval') {
                    <app-badge [tone]="approval(row).tone">{{ approval(row).label }}</app-badge>
                    @if (row.critical) {
                      <span class="ms-1 text-xs text-fg-muted">crítico</span>
                    }
                  }
                  @case ('category') {
                    {{ row.categoryName ?? '—' }}
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
export class SuppliersTab {
  private readonly api = inject(PurchasingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('supplier.manage'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Fornecedor' },
    { key: 'code', label: 'Código' },
    { key: 'taxId', label: 'NIF' },
    { key: 'category', label: 'Categoria' },
    { key: 'terms', label: 'Prazo' },
    { key: 'status', label: 'Estado' },
    { key: 'approval', label: 'Homologação' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly supplyOptions: readonly SelectOption[] = (
    Object.keys(SUPPLY_TYPE) as SupplyType[]
  ).map((value) => ({ value, label: SUPPLY_TYPE[value] }));
  protected readonly ratingOptions: readonly SelectOption[] = ['A', 'B', 'C', 'D'].map((v) => ({
    value: v,
    label: v,
  }));
  protected readonly approvalOptions: readonly SelectOption[] = (
    Object.keys(APPROVAL_STATUS) as ApprovalStatus[]
  ).map((value) => ({ value, label: APPROVAL_STATUS[value].label }));

  private readonly reload = signal(0);
  protected readonly approvalFilter = signal('');
  private readonly params = () => {
    const tenant = this.tenantId();
    return tenant
      ? { tenantId: tenant.id, reload: this.reload(), approval: this.approvalFilter() }
      : undefined;
  };
  protected readonly suppliers = rxResource({
    params: this.params,
    stream: ({ params }) =>
      this.api.suppliers({
        limit: 100,
        approvalStatus: (params.approval || undefined) as ApprovalStatus | undefined,
      }),
  });
  private readonly categories = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.api.supplierCategories(),
  });
  private readonly organizations = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.api.organizations(),
  });

  protected readonly creating = signal(false);
  protected readonly organizationId = signal('');
  protected readonly partyId = signal('');
  protected readonly partyQuery = signal('');
  protected readonly parties = signal<readonly PartyOption[]>([]);
  protected readonly code = signal('');
  protected readonly terms = signal<string | number>('0');
  protected readonly supplier = signal<SupplierDto | null>(null);
  protected readonly reason = signal('');
  protected readonly categoryId = signal('');
  protected readonly supplyType = signal<SupplyType>('GOODS');
  protected readonly rating = signal('');
  protected readonly leadTime = signal<string | number>('');
  protected readonly notes = signal('');
  protected readonly critical = signal(false);
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
  protected readonly partyOptions = computed<readonly SelectOption[]>(() =>
    this.parties().map((p) => ({ value: p.id, label: p.displayName })),
  );

  /** Activas, mais a actual do fornecedor aberto (mesmo inactiva, para não a perder ao guardar). */
  protected readonly categoryOptions = computed<readonly SelectOption[]>(() => {
    const current = this.supplier()?.categoryId;
    return (this.categories.hasValue() ? this.categories.value() : [])
      .filter((c) => c.active || c.id === current)
      .map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));
  });

  protected status = (s: SupplierDto) => SUPPLIER_STATUS[s.status];
  protected approval = (s: SupplierDto) => APPROVAL_STATUS[s.approvalStatus];
  protected supplyLabel = (t: SupplyType) => SUPPLY_TYPE[t];
  protected loadError = () => purchasingError(this.suppliers.error(), 'Pedido falhado.');

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
    this.organizationId.set(this.organizationOptions()[0]?.value ?? '');
    this.partyId.set('');
    this.partyQuery.set('');
    this.parties.set([]);
    this.code.set('');
    this.terms.set('0');
    this.creating.set(true);
  }

  protected create(): void {
    this.reset();
    if (!this.organizationId()) return void this.clientError.set('Escolha a organização.');
    if (!this.partyId()) return void this.clientError.set('Escolha a pessoa ou organização.');
    if (!this.code().trim()) return void this.clientError.set('Indique o código.');
    const days = Number(this.terms());
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      return void this.clientError.set('Prazo: inteiro entre 0 e 3650 dias.');
    }
    this.run(
      this.api.createSupplier({
        partyId: this.partyId(),
        organizationId: this.organizationId(),
        code: this.code().trim(),
        paymentTermDays: days,
      }),
      (created) => {
        this.creating.set(false);
        this.show(created);
        this.notice.set('Fornecedor criado.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: SupplierDto): void {
    this.reset();
    this.show(row);
  }

  /** Mostra o fornecedor e preenche o editor de classificação com os valores do servidor. */
  private show(row: SupplierDto): void {
    this.supplier.set(row);
    this.categoryId.set(row.categoryId ?? '');
    this.supplyType.set(row.supplyType);
    this.rating.set(row.rating ?? '');
    this.leadTime.set(row.leadTimeDays ?? '');
    this.notes.set(row.notes ?? '');
    this.critical.set(row.critical);
  }

  protected classify(): void {
    const current = this.supplier();
    if (!current) return;
    this.reset();
    const leadTimeDays = leadTimeValue(this.leadTime());
    if (leadTimeDays === undefined) {
      return void this.clientError.set('Prazo de entrega: inteiro entre 0 e 3650 dias.');
    }
    this.run(
      this.api.updateSupplier(current.id, current.version, {
        categoryId: this.categoryId() || null,
        supplyType: this.supplyType(),
        rating: (this.rating() || null) as SupplierRating | null,
        leadTimeDays,
        notes: this.notes().trim() || null,
        critical: this.critical(),
      }),
      (saved) => {
        this.show(saved);
        this.notice.set('Classificação guardada.');
      },
    );
  }

  protected approvalChanged(saved: SupplierDto): void {
    this.reset();
    this.show(saved);
    this.notice.set(`Homologação: ${APPROVAL_STATUS[saved.approvalStatus].label}.`);
  }

  protected close(): void {
    this.supplier.set(null);
    this.creating.set(false);
    this.reason.set('');
    this.reload.update((n) => n + 1);
  }

  protected block(): void {
    const current = this.supplier();
    if (!current) return;
    this.reset();
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo do bloqueio.');
    this.run(
      this.api.updateSupplier(current.id, current.version, {
        status: 'BLOCKED',
        statusReason: this.reason().trim(),
      }),
      (saved) => {
        this.show(saved);
        this.reason.set('');
        this.notice.set('Fornecedor bloqueado: não recebe novas encomendas.');
      },
    );
  }

  protected activate(): void {
    const current = this.supplier();
    if (!current) return;
    this.reset();
    this.run(
      this.api.updateSupplier(current.id, current.version, {
        status: 'ACTIVE',
        statusReason: null,
      }),
      (saved) => {
        this.show(saved);
        this.notice.set('Fornecedor reactivado.');
      },
    );
  }
}
