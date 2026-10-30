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
import { PurchasingApi, type PartyOption, type SupplierDto } from './purchasing.api';
import { purchasingError, SUPPLIER_STATUS } from './purchasing-model';

/**
 * Fornecedores (M06): as condições de compra sobre uma Party, por organização. Nome e NIF vêm da Party. Um fornecedor
 * bloqueado ou inactivo não recebe novas encomendas (as já confirmadas continuam a receber-se).
 */
@Component({
  selector: 'app-purchasing-suppliers',
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
        <p class="mt-2 text-sm text-fg-muted">NIF: {{ s.taxId ?? '—' }}</p>
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
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4">
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
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
    { key: 'terms', label: 'Prazo' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  private readonly params = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
  };
  protected readonly suppliers = rxResource({
    params: this.params,
    stream: () => this.api.suppliers({ limit: 100 }),
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

  protected status = (s: SupplierDto) => SUPPLIER_STATUS[s.status];
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
        this.supplier.set(created);
        this.notice.set('Fornecedor criado.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: SupplierDto): void {
    this.reset();
    this.supplier.set(row);
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
        this.supplier.set(saved);
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
        this.supplier.set(saved);
        this.notice.set('Fornecedor reactivado.');
      },
    );
  }
}
