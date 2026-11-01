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
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { PurchasingApi, type SupplierCategoryDto } from './purchasing.api';
import { purchasingError } from './purchasing-model';

/** Categorias de fornecedores: código único e imutável; desactivar em vez de apagar (o histórico fica). */
@Component({
  selector: 'app-purchasing-supplier-categories',
  imports: [FormsModule, Alert, Badge, Button, Card, EmptyState, Input, LoadingState, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (error(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-3 block">
        {{ text }}
      </app-alert>
    }
    @if (canManage()) {
      <app-card class="mb-4 block">
        <h2 class="mb-3 text-base font-semibold">
          {{ editing() ? 'Alterar categoria ' + editing()!.code : 'Nova categoria' }}
        </h2>
        <div class="grid gap-3 sm:grid-cols-3">
          @if (!editing()) {
            <app-input
              label="Código"
              [required]="true"
              [ngModel]="code()"
              (ngModelChange)="code.set($event ?? '')"
            />
          }
          <app-input
            label="Designação"
            [required]="true"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <app-input
            label="Descrição"
            [ngModel]="description()"
            (ngModelChange)="description.set($event ?? '')"
          />
        </div>
        <div class="mt-3 flex gap-2">
          <app-button [loading]="busy()" (click)="save()">{{
            editing() ? 'Guardar' : 'Criar categoria'
          }}</app-button>
          @if (editing()) {
            <app-button variant="secondary" (click)="cancel()">Cancelar</app-button>
          }
        </div>
      </app-card>
    }
    <app-card [flush]="true">
      @if (categories.isLoading() && !categories.hasValue()) {
        <app-loading-state label="A carregar categorias…" />
      } @else if (categories.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as categorias">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (categories.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="folder" title="Sem categorias de fornecedores" />
        } @else {
          <app-table
            caption="Categorias de fornecedores"
            [columns]="columns"
            [rows]="list"
            data-testid="supplier-categories"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('code') {
                  {{ row.code }}
                }
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  @if (row.description) {
                    <span class="block text-xs text-fg-muted">{{ row.description }}</span>
                  }
                }
                @case ('active') {
                  <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                    row.active ? 'Activa' : 'Inactiva'
                  }}</app-badge>
                }
                @case ('actions') {
                  @if (canManage()) {
                    <div class="flex justify-end gap-2">
                      <app-button size="sm" variant="secondary" (click)="edit(row)"
                        >Alterar</app-button
                      >
                      <app-button size="sm" variant="ghost" (click)="toggle(row)">{{
                        row.active ? 'Desactivar' : 'Activar'
                      }}</app-button>
                    </div>
                  }
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>
  `,
})
export class SupplierCategoriesTab {
  private readonly api = inject(PurchasingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('supplier_category.manage'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'code', label: 'Código' },
    { key: 'name', label: 'Categoria' },
    { key: 'active', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  protected readonly categories = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
    },
    stream: () => this.api.supplierCategories(),
  });

  protected readonly editing = signal<SupplierCategoryDto | null>(null);
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected loadError = () => purchasingError(this.categories.error(), 'Pedido falhado.');

  private run<T>(call: Observable<T>, message: string): void {
    this.error.set(null);
    this.notice.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.notice.set(message);
        this.cancel();
        this.reload.update((n) => n + 1);
      },
      error: (error: unknown) =>
        this.error.set(purchasingError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected edit(row: SupplierCategoryDto): void {
    this.editing.set(row);
    this.name.set(row.name);
    this.description.set(row.description ?? '');
  }

  protected cancel(): void {
    this.editing.set(null);
    this.code.set('');
    this.name.set('');
    this.description.set('');
  }

  protected save(): void {
    const current = this.editing();
    const name = this.name().trim();
    const description = this.description().trim() || null;
    if (!current && !this.code().trim()) return void this.error.set('Indique o código.');
    if (!name) return void this.error.set('Indique a designação.');
    this.run(
      current
        ? this.api.updateSupplierCategory(current.id, current.version, { name, description })
        : this.api.createSupplierCategory({ code: this.code().trim(), name, description }),
      current ? 'Categoria actualizada.' : 'Categoria criada.',
    );
  }

  protected toggle(row: SupplierCategoryDto): void {
    this.run(
      this.api.updateSupplierCategory(row.id, row.version, { active: !row.active }),
      row.active ? 'Categoria desactivada.' : 'Categoria activada.',
    );
  }
}
