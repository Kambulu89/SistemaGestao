import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { SettingsApi } from '../../../tenant/data-access/settings.api';
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
  CatalogApi,
  type ProductBody,
  type ProductDto,
  type ProductType,
  type TrackingMode,
  type VariantDto,
} from './catalog.api';
import {
  catalogError,
  formatAttributes,
  parseAttributes,
  stockIssue,
  TRACKING_LABEL,
} from './catalog-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Produto' },
  { key: 'type', label: 'Tipo' },
  { key: 'status', label: 'Estado' },
  { key: 'actions', label: '', align: 'end' },
];

const VARIANT_COLUMNS: readonly TableColumn[] = [
  { key: 'sku', label: 'SKU' },
  { key: 'barcode', label: 'Código de barras' },
  { key: 'attributes', label: 'Atributos' },
  { key: 'status', label: 'Estado' },
];

const TYPES: readonly SelectOption[] = [
  { value: 'GOODS', label: 'Bem' },
  { value: 'SERVICE', label: 'Serviço' },
];

const TRACKING: readonly SelectOption[] = (Object.keys(TRACKING_LABEL) as TrackingMode[]).map(
  (value) => ({ value, label: TRACKING_LABEL[value] }),
);

/** Produtos e variantes (M03): criação com variante por omissão, edição e novas variantes. */
@Component({
  selector: 'app-catalog-products',
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
    Table,
  ],
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

    @if (!editing()) {
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="min-w-56 flex-1">
          <app-input
            label="Pesquisar"
            placeholder="Código, nome, SKU ou código de barras"
            [ngModel]="query()"
            (ngModelChange)="query.set($event ?? '')"
          />
        </div>
        <app-select
          label="Tipo"
          placeholder="Todos"
          [options]="types"
          [ngModel]="type()"
          (ngModelChange)="type.set($event ?? '')"
        />
        @if (canManage()) {
          <app-button (click)="startNew()">Novo produto</app-button>
        }
      </div>

      <app-card [flush]="true">
        @if (products.isLoading() && !products.hasValue()) {
          <app-loading-state label="A carregar produtos…" />
        } @else if (products.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar os produtos">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (products.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="tag" title="Sem produtos" />
          } @else {
            <app-table
              caption="Produtos"
              [columns]="columns"
              [rows]="page.items"
              data-testid="products"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                    <span class="block text-xs text-fg-muted">{{ row.code }}</span>
                  }
                  @case ('type') {
                    {{ row.type === 'SERVICE' ? 'Serviço' : 'Bem' }}
                    @if (row.trackStock) {
                      <span class="block text-xs text-fg-muted">{{ tracking(row) }}</span>
                    }
                  }
                  @case ('status') {
                    <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                      row.active ? 'Activo' : 'Inactivo'
                    }}</app-badge>
                  }
                  @case ('actions') {
                    <app-button size="sm" variant="secondary" (click)="openRow(row)">{{
                      canManage() ? 'Editar' : 'Ver'
                    }}</app-button>
                  }
                }
              </ng-template>
            </app-table>
            <p class="px-5 py-3 text-xs text-fg-muted">
              {{ page.items.length }} de {{ page.total }} produtos
            </p>
          }
        }
      </app-card>
    } @else {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">
          {{ editing()!.id ? 'Produto ' + code() : 'Novo produto' }}
        </h2>
        @if (clientError(); as text) {
          <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
        }
        <div class="grid gap-4 sm:grid-cols-2">
          @if (!editing()!.id) {
            <app-input
              label="Código"
              [required]="true"
              hint="Imutável depois de criado."
              [ngModel]="code()"
              (ngModelChange)="code.set($event ?? '')"
            />
          }
          <app-input
            label="Nome"
            [required]="true"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <app-select
            label="Tipo"
            [options]="types"
            [ngModel]="productType()"
            (ngModelChange)="changeType($event)"
          />
          <app-select
            label="Unidade de base"
            [required]="true"
            [options]="unitOptions()"
            [ngModel]="unitId()"
            (ngModelChange)="unitId.set($event ?? '')"
          />
          <app-select
            label="Categoria"
            placeholder="Sem categoria"
            [options]="categoryOptions()"
            [ngModel]="categoryId()"
            (ngModelChange)="categoryId.set($event ?? '')"
          />
          <app-input
            label="Descrição"
            [ngModel]="description()"
            (ngModelChange)="description.set($event ?? '')"
          />
          @if (productType() === 'GOODS') {
            <app-checkbox
              label="Controlar stock"
              [ngModel]="trackStock()"
              (ngModelChange)="trackStock.set(!!$event)"
            />
            <app-select
              label="Rastreio"
              [options]="trackingOptions"
              [ngModel]="trackingMode()"
              (ngModelChange)="trackingMode.set(asTracking($event))"
            />
          }
          @if (!editing()!.id) {
            <app-input
              label="SKU da variante por omissão"
              hint="Vazio = o código do produto."
              [ngModel]="sku()"
              (ngModelChange)="sku.set($event ?? '')"
            />
            <app-input
              label="Código de barras"
              [ngModel]="barcode()"
              (ngModelChange)="barcode.set($event ?? '')"
            />
          } @else {
            <app-checkbox
              label="Activo"
              [ngModel]="active()"
              (ngModelChange)="active.set(!!$event)"
            />
          }
        </div>
        <div class="mt-5 flex gap-2">
          @if (canManage()) {
            <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>

      @if (editing()!.id) {
        <h3 class="mb-3 mt-8 text-base font-semibold">Variantes</h3>
        <app-card [flush]="true">
          <app-table
            caption="Variantes"
            [columns]="variantColumns"
            [rows]="variants()"
            data-testid="variants"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('sku') {
                  <span class="font-medium">{{ row.sku }}</span>
                  @if (row.isDefault) {
                    <app-badge class="ms-1">Por omissão</app-badge>
                  }
                }
                @case ('barcode') {
                  {{ row.barcode ?? '—' }}
                }
                @case ('attributes') {
                  {{ attributesText(row) || '—' }}
                }
                @case ('status') {
                  <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                    row.active ? 'Activa' : 'Inactiva'
                  }}</app-badge>
                }
              }
            </ng-template>
          </app-table>
        </app-card>
        @if (canManage()) {
          <app-card class="mt-4 block">
            <h4 class="mb-3 text-sm font-semibold">Nova variante</h4>
            <div class="grid gap-4 sm:grid-cols-3">
              <app-input
                label="SKU"
                [required]="true"
                hint="Imutável depois de criada."
                [ngModel]="variantSku()"
                (ngModelChange)="variantSku.set($event ?? '')"
              />
              <app-input
                label="Código de barras"
                [ngModel]="variantBarcode()"
                (ngModelChange)="variantBarcode.set($event ?? '')"
              />
              <app-input
                label="Atributos"
                hint="tamanho=M, cor=azul"
                [ngModel]="variantAttributes()"
                (ngModelChange)="variantAttributes.set($event ?? '')"
              />
            </div>
            <app-button class="mt-4" [loading]="busy()" (click)="addVariant()"
              >Acrescentar variante</app-button
            >
          </app-card>
        }
      }
    }
  `,
})
export class ProductsTab {
  private readonly api = inject(CatalogApi);
  private readonly settings = inject(SettingsApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly variantColumns = VARIANT_COLUMNS;
  protected readonly types = TYPES;
  protected readonly trackingOptions = TRACKING;
  protected readonly canManage = computed(() => this.permissions.can('catalog.manage'));

  protected readonly query = signal('');
  protected readonly type = signal('');
  private readonly reload = signal(0);

  protected readonly products = rxResource({
    params: () => ({ q: this.query().trim(), type: this.type(), reload: this.reload() }),
    stream: ({ params }) =>
      this.api.products({
        q: params.q || undefined,
        type: (params.type || undefined) as ProductType | undefined,
        limit: 100,
      }),
  });
  protected readonly loadError = computed(() =>
    catalogError(this.products.error(), 'Tente novamente.'),
  );

  private readonly units = rxResource({ stream: () => this.settings.listUnits() });
  private readonly categories = rxResource({ stream: () => this.api.categories() });
  protected readonly unitOptions = computed<readonly SelectOption[]>(() =>
    (this.units.hasValue() ? this.units.value() : []).map((u) => ({
      value: u.id,
      label: `${u.name} (${u.code})`,
    })),
  );
  protected readonly categoryOptions = computed<readonly SelectOption[]>(() =>
    (this.categories.hasValue() ? this.categories.value() : []).map((c) => ({
      value: c.id,
      label: c.name,
    })),
  );

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly editing = signal<{ id: string | null; version: number } | null>(null);
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly productType = signal<ProductType>('GOODS');
  protected readonly unitId = signal('');
  protected readonly categoryId = signal('');
  protected readonly trackStock = signal(true);
  protected readonly trackingMode = signal<TrackingMode>('NONE');
  protected readonly active = signal(true);
  protected readonly sku = signal('');
  protected readonly barcode = signal('');
  protected readonly variants = signal<readonly VariantDto[]>([]);
  protected readonly variantSku = signal('');
  protected readonly variantBarcode = signal('');
  protected readonly variantAttributes = signal('');

  protected tracking(row: ProductDto): string {
    return TRACKING_LABEL[row.trackingMode];
  }

  protected attributesText(row: VariantDto): string {
    return formatAttributes(row.attributes);
  }

  protected asTracking(value: string | null): TrackingMode {
    return value === 'LOT' || value === 'SERIAL' ? value : 'NONE';
  }

  protected changeType(value: string | null): void {
    const type: ProductType = value === 'SERVICE' ? 'SERVICE' : 'GOODS';
    this.productType.set(type);
    this.trackStock.set(type === 'GOODS');
    if (type === 'SERVICE') this.trackingMode.set('NONE');
  }

  private reset(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
  }

  protected startNew(): void {
    this.reset();
    this.code.set('');
    this.name.set('');
    this.description.set('');
    this.productType.set('GOODS');
    this.unitId.set('');
    this.categoryId.set('');
    this.trackStock.set(true);
    this.trackingMode.set('NONE');
    this.active.set(true);
    this.sku.set('');
    this.barcode.set('');
    this.variants.set([]);
    this.editing.set({ id: null, version: 0 });
  }

  /** A listagem não traz variantes: abre-se o produto completo. */
  protected openRow(row: ProductDto): void {
    this.reset();
    this.run(this.api.product(row.id), (full) => this.open(full));
  }

  private open(row: ProductDto): void {
    this.reset();
    this.code.set(row.code);
    this.name.set(row.name);
    this.description.set(row.description ?? '');
    this.productType.set(row.type);
    this.unitId.set(row.baseUnitId);
    this.categoryId.set(row.categoryId ?? '');
    this.trackStock.set(row.trackStock);
    this.trackingMode.set(row.trackingMode);
    this.active.set(row.active);
    this.variants.set(row.variants ?? []);
    this.editing.set({ id: row.id, version: row.version });
  }

  protected close(): void {
    this.editing.set(null);
    this.reload.update((n) => n + 1);
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: done,
      error: (error: unknown) =>
        this.actionError.set(catalogError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected save(): void {
    const state = this.editing();
    if (!state) return;
    this.reset();
    if (!this.name().trim()) return void this.clientError.set('O nome é obrigatório.');
    if (!this.unitId()) return void this.clientError.set('Escolha a unidade de base.');
    if (!state.id && !this.code().trim()) {
      return void this.clientError.set('O código é obrigatório.');
    }
    const problem = stockIssue(this.productType(), this.trackStock(), this.trackingMode());
    if (problem) return void this.clientError.set(problem);

    const body: ProductBody = {
      name: this.name().trim(),
      description: this.description().trim() || null,
      type: this.productType(),
      categoryId: this.categoryId() || null,
      baseUnitId: this.unitId(),
      trackStock: this.trackStock(),
      trackingMode: this.trackingMode(),
    };
    if (state.id) {
      this.run(
        this.api.updateProduct(state.id, state.version, { ...body, active: this.active() }),
        (saved) => {
          this.editing.set({ id: saved.id, version: saved.version });
          this.notice.set('Produto guardado.');
        },
      );
    } else {
      this.run(
        this.api.createProduct({
          ...body,
          code: this.code().trim(),
          sku: this.sku().trim() || undefined,
          barcode: this.barcode().trim() || null,
        }),
        (saved) => {
          this.open(saved);
          this.notice.set('Produto criado com a variante por omissão.');
        },
      );
    }
  }

  protected addVariant(): void {
    const state = this.editing();
    if (!state?.id) return;
    this.reset();
    const attributes = parseAttributes(this.variantAttributes());
    if (!this.variantSku().trim()) return void this.clientError.set('O SKU é obrigatório.');
    if (!attributes) {
      return void this.clientError.set('Atributos: use pares chave=valor separados por vírgulas.');
    }
    this.run(
      this.api.createVariant(state.id, {
        sku: this.variantSku().trim(),
        barcode: this.variantBarcode().trim() || null,
        attributes,
      }),
      (created) => {
        this.variants.update((list) => [...list, created]);
        this.variantSku.set('');
        this.variantBarcode.set('');
        this.variantAttributes.set('');
        this.notice.set('Variante acrescentada.');
      },
    );
  }
}
