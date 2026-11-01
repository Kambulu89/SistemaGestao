import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { CatalogApi, type BrandDto } from './catalog.api';
import { catalogError } from './catalog-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Marca' },
  { key: 'country', label: 'País' },
  { key: 'status', label: 'Estado' },
  { key: 'actions', label: 'Acções', align: 'end' },
];

/** Marcas do catálogo: código único e imutável; inactivar em vez de eliminar (os produtos mantêm a marca). */
@Component({
  selector: 'app-catalog-brands',
  imports: [FormsModule, Alert, Badge, Button, Card, EmptyState, Input, LoadingState, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }
    <app-card [flush]="true">
      @if (brands.isLoading() && !brands.hasValue()) {
        <app-loading-state label="A carregar marcas…" />
      } @else if (brands.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as marcas">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (brands.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="tag" title="Sem marcas" />
        } @else {
          <app-table caption="Marcas" [columns]="columns" [rows]="list" data-testid="brands">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.code }}</span>
                }
                @case ('country') {
                  {{ row.countryCode ?? '—' }}
                }
                @case ('status') {
                  <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                    row.active ? 'Activa' : 'Inactiva'
                  }}</app-badge>
                }
                @case ('actions') {
                  @if (canManage()) {
                    <span class="flex justify-end">
                      <app-button size="sm" variant="secondary" (click)="toggle(row)">
                        {{ row.active ? 'Inactivar' : 'Reactivar' }}
                      </app-button>
                    </span>
                  }
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (canManage()) {
      <app-card class="mt-4 block">
        <h3 class="mb-3 text-sm font-semibold">Nova marca</h3>
        <div class="grid gap-4 sm:grid-cols-3">
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
          <app-input
            label="País de origem (ISO, ex.: PT)"
            [ngModel]="country()"
            (ngModelChange)="country.set($event ?? '')"
          />
        </div>
        <app-button class="mt-4" [loading]="busy()" (click)="create()">Criar marca</app-button>
      </app-card>
    }
  `,
})
export class BrandsTab {
  private readonly api = inject(CatalogApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly canManage = computed(() => this.permissions.can('catalog.manage'));

  private readonly reload = signal(0);
  protected readonly brands = rxResource({
    params: () => ({ reload: this.reload() }),
    stream: () => this.api.brands(),
  });
  protected readonly loadError = computed(() =>
    catalogError(this.brands.error(), 'Tente novamente.'),
  );

  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly country = signal('');
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  private run<T>(call: Observable<T>, message: string, after?: () => void): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        after?.();
        this.notice.set(message);
        this.reload.update((n) => n + 1);
      },
      error: (error: unknown) =>
        this.actionError.set(catalogError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected create(): void {
    const country = this.country().trim().toUpperCase();
    if (!this.code().trim() || !this.name().trim()) {
      this.actionError.set('O código e o nome são obrigatórios.');
      return;
    }
    if (country && !/^[A-Z]{2}$/.test(country)) {
      this.actionError.set('O país usa o código ISO de 2 letras.');
      return;
    }
    this.run(
      this.api.createBrand({
        code: this.code().trim(),
        name: this.name().trim(),
        countryCode: country || null,
      }),
      'Marca criada.',
      () => {
        this.code.set('');
        this.name.set('');
        this.country.set('');
      },
    );
  }

  protected toggle(brand: BrandDto): void {
    this.run(
      this.api.updateBrand(brand, { active: !brand.active }),
      brand.active ? 'Marca inactivada.' : 'Marca reactivada.',
    );
  }
}
