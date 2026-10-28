import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { detailedErrorMessage } from '../../../../core/api/error-message';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { Dialog } from '../../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import { InventoryApi, type LocationDto, type WarehouseDto } from './inventory.api';

/** Armazéns e locais. O armazém «de vendas» é onde a confirmação de encomendas verifica e reserva o stock. */
@Component({
  selector: 'app-inventory-warehouses',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex items-center justify-between">
      <p class="text-sm text-fg-muted">
        O armazém de vendas reserva o stock das encomendas ao confirmar. Sem ele, as vendas não
        mexem no stock.
      </p>
      @if (canManage()) {
        <app-button (click)="openCreate()">Novo armazém</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (warehouses.isLoading() && !warehouses.hasValue()) {
        <app-loading-state label="A carregar armazéns…" />
      } @else if (warehouses.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os armazéns">
            {{ describe(warehouses.error()) }}
          </app-alert>
        </div>
      } @else if (warehouses.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="archive" title="Ainda não há armazéns" />
        } @else {
          <app-table caption="Armazéns" [columns]="columns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.code }}</span>
                }
                @case ('policies') {
                  <span class="flex flex-wrap gap-1">
                    @if (row.salesDefault) {
                      <app-badge tone="success">Armazém de vendas</app-badge>
                    }
                    @if (row.allowNegative) {
                      <app-badge tone="brand">Saldo negativo</app-badge>
                    }
                    @if (row.allowBackorder) {
                      <app-badge tone="brand">Encomendas em falta</app-badge>
                    }
                  </span>
                }
                @case ('active') {
                  <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                    row.active ? 'Activo' : 'Inactivo'
                  }}</app-badge>
                }
                @case ('actions') {
                  <span class="flex flex-wrap justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="select(row)"
                      >Locais</app-button
                    >
                    @if (canManage()) {
                      <app-button size="sm" variant="secondary" (click)="toggleSales(row)">
                        {{ row.salesDefault ? 'Deixar de ser de vendas' : 'Usar nas vendas' }}
                      </app-button>
                      <app-button
                        size="sm"
                        variant="secondary"
                        (click)="toggle(row, 'allowBackorder')"
                      >
                        {{ row.allowBackorder ? 'Recusar em falta' : 'Aceitar em falta' }}
                      </app-button>
                      <app-button
                        size="sm"
                        variant="secondary"
                        (click)="toggle(row, 'allowNegative')"
                      >
                        {{
                          row.allowNegative ? 'Proibir saldo negativo' : 'Permitir saldo negativo'
                        }}
                      </app-button>
                      <app-button size="sm" variant="secondary" (click)="toggle(row, 'active')">
                        {{ row.active ? 'Desactivar' : 'Reactivar' }}
                      </app-button>
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (detail.value(); as warehouse) {
      <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="locations-title">
        Locais de {{ warehouse.name }}
      </h3>
      <app-card [flush]="true">
        <ul class="divide-y divide-line" data-testid="locations">
          @for (l of warehouse.locations ?? []; track l.id) {
            <li class="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span>
                <strong>{{ l.code }}</strong> · {{ l.name }}
                @if (!l.active) {
                  <app-badge tone="neutral">Inactivo</app-badge>
                }
              </span>
              @if (canManage()) {
                <app-button size="sm" variant="secondary" (click)="toggleLocation(l)">
                  {{ l.active ? 'Desactivar' : 'Reactivar' }}
                </app-button>
              }
            </li>
          }
        </ul>
      </app-card>
      @if (canManage()) {
        <div class="mt-3 flex flex-wrap items-end gap-3" data-testid="location-form">
          <div class="w-40">
            <app-input
              label="Código"
              [ngModel]="locCode()"
              (ngModelChange)="locCode.set($event ?? '')"
            />
          </div>
          <div class="min-w-48 flex-1">
            <app-input
              label="Nome"
              [ngModel]="locName()"
              (ngModelChange)="locName.set($event ?? '')"
            />
          </div>
          <app-button variant="secondary" [loading]="busy()" (click)="addLocation(warehouse)"
            >Adicionar local</app-button
          >
        </div>
      }
    }

    <app-dialog [open]="creating()" title="Novo armazém" (closed)="creating.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="warehouse-form">
        <app-select
          label="Organização"
          placeholder="Escolha a organização"
          [options]="organizationOptions()"
          [ngModel]="orgId()"
          (ngModelChange)="orgId.set($event ?? '')"
        />
        <app-input label="Código" [ngModel]="code()" (ngModelChange)="code.set($event ?? '')" />
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" [checked]="negative()" (change)="negative.set(!negative())" />
          Permitir saldo negativo
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" [checked]="backorder()" (change)="backorder.set(!backorder())" />
          Aceitar encomendas em falta (reserva o que há)
        </label>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class WarehousesTab {
  private readonly api = inject(InventoryApi);
  private readonly organizations = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('warehouse.manage'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Armazém' },
    { key: 'policies', label: 'Políticas' },
    { key: 'active', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly tick = signal(0);
  protected readonly warehouses = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.warehouses(),
  });
  private readonly selectedId = signal<string | null>(null);
  protected readonly detail = rxResource({
    params: () => {
      const id = this.selectedId();
      return id ? { id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.warehouse(params.id),
  });
  private readonly orgs = rxResource({
    params: () => (this.creating() ? true : undefined),
    stream: () => this.organizations.listOrganizations(),
  });

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly creating = signal(false);
  protected readonly orgId = signal('');
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly negative = signal(false);
  protected readonly backorder = signal(false);
  protected readonly locCode = signal('');
  protected readonly locName = signal('');

  protected readonly organizationOptions = computed<readonly SelectOption[]>(() =>
    (this.orgs.hasValue() ? this.orgs.value() : []).map((o) => ({
      value: o.id,
      label: `${o.code} — ${o.legalName}`,
    })),
  );

  protected describe = (e: unknown) => detailedErrorMessage(e, 'Pedido falhado.');

  protected select(warehouse: WarehouseDto): void {
    this.selectedId.set(warehouse.id);
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.orgId.set('');
    this.code.set('');
    this.name.set('');
    this.negative.set(false);
    this.backorder.set(false);
    this.creating.set(true);
  }

  protected create(): void {
    if (!this.orgId() || !this.code().trim() || !this.name().trim()) {
      this.formError.set('Indique a organização, o código e o nome.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .createWarehouse({
        organizationId: this.orgId(),
        code: this.code().trim(),
        name: this.name().trim(),
        allowNegative: this.negative(),
        allowBackorder: this.backorder(),
      })
      .subscribe({
        next: (created) => {
          this.busy.set(false);
          this.creating.set(false);
          this.notice.set('Armazém criado com o local PRINCIPAL.');
          this.selectedId.set(created.id);
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(detailedErrorMessage(e, 'Não foi possível criar o armazém.'));
        },
      });
  }

  protected toggleSales(w: WarehouseDto): void {
    this.run(
      this.api.updateWarehouse(w, { salesDefault: !w.salesDefault }),
      'Armazém actualizado.',
    );
  }

  protected toggle(w: WarehouseDto, key: 'allowNegative' | 'allowBackorder' | 'active'): void {
    this.run(this.api.updateWarehouse(w, { [key]: !w[key] }), 'Armazém actualizado.');
  }

  protected toggleLocation(l: LocationDto): void {
    this.run(this.api.updateLocation(l, { active: !l.active }), 'Local actualizado.');
  }

  protected addLocation(w: WarehouseDto): void {
    if (!this.locCode().trim() || !this.locName().trim()) {
      this.actionError.set('Indique o código e o nome do local.');
      return;
    }
    this.run(
      this.api.createLocation(w.id, { code: this.locCode().trim(), name: this.locName().trim() }),
      'Local criado.',
      () => {
        this.locCode.set('');
        this.locName.set('');
      },
    );
  }

  private run(call: Observable<unknown>, message: string, done?: () => void): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        this.notice.set(message);
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        // Conflito de versão ou de regra (p. ex. já existe um armazém de vendas): mostra o estado actual.
        this.actionError.set(detailedErrorMessage(e, 'Não foi possível concluir a operação.'));
        this.tick.update((n) => n + 1);
      },
    });
  }
}
