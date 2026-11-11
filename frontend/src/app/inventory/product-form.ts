import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  attributesText,
  type Brand,
  type Category,
  categoryPaths,
  conversionLabel,
  decimalText,
  emptyProductForm,
  formFromProduct,
  gtinValid,
  parseAttributes,
  priceLabel,
  type Product,
  PRODUCT_STATUS,
  PRODUCT_TYPE,
  type ProductForm,
  productPayload,
  type Uom,
  type Variant,
} from './inventory-model';

/**
 * Produto ou serviço: identificação, classificação, unidades e conversões, stock e rastreio (só armazenáveis), preço,
 * classe contabilística, componentes (kits), variantes, imagens e histórico. O servidor valida tudo de novo.
 */
@Component({
  selector: 'app-product-form',
  imports: [
    FormsModule,
    EntityFormPage,
    FormSection,
    FormField,
    FieldControl,
    DataTable,
    CellDef,
    Modal,
    ErrorAlert,
    Attachments,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Novo produto' : (product()?.sku ?? '') + ' — ' + (product()?.name ?? '')"
      [subtitle]="
        isNew()
          ? 'Armazenável, serviço (não movimenta stock) ou kit (composto por armazenáveis).'
          : typeLabel()
      "
      formId="product-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar produto' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section
        title="Identificação"
        description="SKU e código de barras únicos na empresa (também nas variantes)."
      >
        <app-field label="SKU" [required]="true" [error]="action.field('sku')">
          <input
            appControl
            class="input"
            data-testid="pf-sku"
            name="sku"
            [(ngModel)]="f.sku"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field
          label="Código de barras"
          hint="EAN/UPC com dígito de controlo, ou código interno."
          [error]="
            action.field('barcode') ?? (barcodeWarning() ? 'Dígito de controlo inválido.' : null)
          "
        >
          <input
            appControl
            class="input"
            data-testid="pf-barcode"
            name="barcode"
            [(ngModel)]="f.barcode"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="pf-name"
            name="name"
            [(ngModel)]="f.name"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field label="Tipo" [required]="true" [error]="action.field('productType')">
          <select
            appControl
            class="input"
            data-testid="pf-type"
            name="productType"
            [(ngModel)]="f.productType"
            [disabled]="!canManage()"
          >
            @for (t of types; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Descrição" [error]="action.field('description')">
          <textarea
            appControl
            class="input min-h-16"
            name="description"
            [(ngModel)]="f.description"
            [disabled]="!canManage()"
          ></textarea>
        </app-field>
        @if (!isNew()) {
          <app-field label="Estado" [error]="action.field('status')">
            <select
              appControl
              class="input"
              data-testid="pf-status"
              name="status"
              [(ngModel)]="f.status"
              [disabled]="!canManage()"
            >
              @for (s of statuses; track s[0]) {
                <option [value]="s[0]">{{ s[1] }}</option>
              }
            </select>
          </app-field>
        }
      </app-form-section>

      <app-form-section
        title="Classificação e contabilização"
        description="A classe contabilística liga o produto às regras de lançamento; sem ela, vale a da categoria."
      >
        <app-field label="Categoria" [error]="action.field('categoryId')">
          <select
            appControl
            class="input"
            data-testid="pf-category"
            name="categoryId"
            [(ngModel)]="f.categoryId"
            [disabled]="!canManage()"
          >
            <option value="">—</option>
            @for (c of categoryOptions(); track c.id) {
              <option [value]="c.id">{{ c.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Marca" [error]="action.field('brandId')">
          <select
            appControl
            class="input"
            name="brandId"
            [(ngModel)]="f.brandId"
            [disabled]="!canManage()"
          >
            <option value="">—</option>
            @for (b of activeBrands(); track b.id) {
              <option [value]="b.id">{{ b.name }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Classe contabilística"
          [hint]="classHint()"
          [error]="action.field('accountingClass')"
        >
          <input
            appControl
            class="input uppercase"
            data-testid="pf-class"
            name="accountingClass"
            [(ngModel)]="f.accountingClass"
            [disabled]="!canManage()"
          />
        </app-field>
      </app-form-section>

      <app-form-section
        title="Unidades"
        description="Quantas unidades base tem 1 unidade alternativa. Compra e venda usam a base ou uma com conversão."
      >
        <app-field label="Unidade base" [required]="true" [error]="action.field('baseUomId')">
          <select
            appControl
            class="input"
            data-testid="pf-base"
            name="baseUomId"
            [(ngModel)]="f.baseUomId"
            [disabled]="!canManage()"
          >
            <option value="">—</option>
            @for (u of activeUoms(); track u.id) {
              <option [value]="u.id">{{ u.code }} — {{ u.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Unidade de compra" [error]="action.field('purchaseUomId')">
          <select
            appControl
            class="input"
            data-testid="pf-purchase"
            name="purchaseUomId"
            [(ngModel)]="f.purchaseUomId"
            [disabled]="!canManage()"
          >
            <option value="">A base</option>
            @for (u of convertible(); track u.id) {
              <option [value]="u.id">{{ u.code }}</option>
            }
          </select>
        </app-field>
        <app-field label="Unidade de venda" [error]="action.field('saleUomId')">
          <select
            appControl
            class="input"
            data-testid="pf-sale-uom"
            name="saleUomId"
            [(ngModel)]="f.saleUomId"
            [disabled]="!canManage()"
          >
            <option value="">A base</option>
            @for (u of convertible(); track u.id) {
              <option [value]="u.id">{{ u.code }}</option>
            }
          </select>
        </app-field>
        <div class="sm:col-span-2">
          <p class="mb-2 text-sm font-medium">Conversões</p>
          @if (action.field('conversions')) {
            <p class="mb-2 text-sm text-danger-text" role="alert">
              {{ action.field('conversions') }}
            </p>
          }
          @for (c of f.conversions; track $index; let i = $index) {
            <div class="mb-2 flex flex-wrap items-end gap-2" [attr.data-testid]="'pf-conv-' + i">
              <label class="text-sm">
                <span class="sr-only">Unidade da conversão {{ i + 1 }}</span>
                <select
                  class="input w-40"
                  [name]="'conv-uom-' + i"
                  [(ngModel)]="c.uomId"
                  [disabled]="!canManage()"
                >
                  <option value="">—</option>
                  @for (u of activeUoms(); track u.id) {
                    @if (u.id !== f.baseUomId) {
                      <option [value]="u.id">{{ u.code }}</option>
                    }
                  }
                </select>
              </label>
              <label class="text-sm">
                <span class="sr-only">Unidades base por 1 (conversão {{ i + 1 }})</span>
                <input
                  class="input w-32"
                  inputmode="decimal"
                  [name]="'conv-factor-' + i"
                  placeholder="Factor"
                  [(ngModel)]="c.factor"
                  [disabled]="!canManage()"
                />
              </label>
              <span class="text-sm text-muted">{{ convLabel(c) }}</span>
              @if (canManage()) {
                <button type="button" class="link" (click)="f.conversions.splice(i, 1)">
                  Remover
                </button>
              }
            </div>
          }
          @if (canManage()) {
            <button
              type="button"
              class="btn-secondary"
              data-testid="pf-add-conv"
              (click)="f.conversions.push({ uomId: '', factor: '' })"
            >
              Adicionar conversão
            </button>
          }
        </div>
      </app-form-section>

      @if (f.productType === 'STOCKABLE') {
        <app-form-section
          title="Stock e rastreabilidade"
          description="Lotes, números de série e validade acompanham o produto em todos os movimentos."
        >
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="pf-lots"
              name="trackLots"
              [(ngModel)]="f.trackLots"
              [disabled]="!canManage()"
            />
            Controlar lotes
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="pf-serials"
              name="trackSerials"
              [(ngModel)]="f.trackSerials"
              [disabled]="!canManage()"
            />
            Números de série
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="pf-expiry"
              name="trackExpiry"
              [(ngModel)]="f.trackExpiry"
              [disabled]="!canManage()"
            />
            Controlar validade
          </label>
          <app-field
            label="Valorização"
            hint="Fica fixo quando o produto tiver movimentos. O custo específico é por lote."
            [error]="action.field('valuationMethod')"
          >
            <select
              appControl
              class="input"
              name="valuationMethod"
              data-testid="pf-valuation"
              [(ngModel)]="f.valuationMethod"
              [disabled]="!canManage()"
            >
              <option value="AVERAGE">Custo médio ponderado</option>
              <option value="FIFO">FIFO (primeiro a entrar, primeiro a sair)</option>
              <option value="SPECIFIC">Custo específico (por lote)</option>
            </select>
          </app-field>
          @if (f.trackExpiry) {
            <app-field label="Prazo de validade (dias)" [error]="action.field('shelfLifeDays')">
              <input
                appControl
                class="input"
                inputmode="numeric"
                data-testid="pf-shelf"
                name="shelfLifeDays"
                [(ngModel)]="f.shelfLifeDays"
                [disabled]="!canManage()"
              />
            </app-field>
          }
          <app-field
            label="Stock mínimo"
            hint="Em unidades base."
            [error]="action.field('minStock')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="pf-min"
              name="minStock"
              [(ngModel)]="f.minStock"
              [disabled]="!canManage()"
            />
          </app-field>
          <app-field
            label="Stock máximo"
            hint="Em unidades base."
            [error]="action.field('maxStock')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="pf-max"
              name="maxStock"
              [(ngModel)]="f.maxStock"
              [disabled]="!canManage()"
            />
          </app-field>
        </app-form-section>
      } @else {
        <p
          class="rounded-card bg-surface-2 p-3 text-sm text-muted"
          role="note"
          data-testid="pf-no-stock"
        >
          {{ f.productType === 'SERVICE' ? 'Os serviços' : 'Os kits' }} não movimentam stock: sem
          lotes, séries, validade nem limites{{
            f.productType === 'KIT' ? ' (os componentes é que movimentam)' : ''
          }}.
        </p>
      }

      @if (f.productType === 'KIT') {
        <app-form-section
          title="Componentes do kit"
          description="Produtos armazenáveis activos, em unidades base do componente."
        >
          <div class="sm:col-span-2">
            @if (action.field('components')) {
              <p class="mb-2 text-sm text-danger-text" role="alert">
                {{ action.field('components') }}
              </p>
            }
            @for (c of f.components; track $index; let i = $index) {
              <div class="mb-2 flex flex-wrap items-end gap-2" [attr.data-testid]="'pf-comp-' + i">
                <label class="text-sm">
                  <span class="sr-only">Componente {{ i + 1 }}</span>
                  <select
                    class="input w-64"
                    [name]="'comp-' + i"
                    [(ngModel)]="c.componentId"
                    [disabled]="!canManage()"
                  >
                    <option value="">—</option>
                    @for (p of componentOptions(); track p.id) {
                      <option [value]="p.id">
                        {{ p.sku }} — {{ p.name }} ({{ p.baseUom.code }})
                      </option>
                    }
                  </select>
                </label>
                <label class="text-sm">
                  <span class="sr-only">Quantidade do componente {{ i + 1 }}</span>
                  <input
                    class="input w-28"
                    inputmode="decimal"
                    [name]="'comp-qty-' + i"
                    placeholder="Qtd."
                    [(ngModel)]="c.quantity"
                    [disabled]="!canManage()"
                  />
                </label>
                @if (action.field('components.' + i)) {
                  <span class="text-sm text-danger-text">{{
                    action.field('components.' + i)
                  }}</span>
                }
                @if (canManage()) {
                  <button type="button" class="link" (click)="f.components.splice(i, 1)">
                    Remover
                  </button>
                }
              </div>
            }
            @if (canManage()) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="pf-add-comp"
                (click)="f.components.push({ componentId: '', quantity: '' })"
              >
                Adicionar componente
              </button>
            }
          </div>
        </app-form-section>
      }

      <app-form-section
        title="Preço comercial"
        description="Preço de venda de referência (até 4 casas decimais); as tabelas de preços ficam para Vendas."
      >
        <app-field label="Preço" [error]="action.field('salePrice')">
          <input
            appControl
            class="input"
            inputmode="decimal"
            data-testid="pf-price"
            name="salePrice"
            [(ngModel)]="f.salePrice"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field label="Moeda" [error]="action.field('currency')">
          <input
            appControl
            class="input uppercase"
            maxlength="3"
            name="currency"
            [(ngModel)]="f.currency"
            [disabled]="!canManage()"
          />
        </app-field>
      </app-form-section>

      @if (product(); as p) {
        @if (p.productType !== 'KIT') {
          <section class="card" aria-labelledby="pf-variants">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="pf-variants" class="font-semibold">Variantes</h2>
              @if (canManage()) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="pf-add-variant"
                  (click)="openVariant(null)"
                >
                  Adicionar variante
                </button>
              }
            </div>
            <app-data-table
              label="Variantes"
              [columns]="variantColumns"
              [rows]="p.variants ?? []"
              [total]="p.variants?.length ?? 0"
              [limit]="200"
              emptyText="Sem variantes."
            >
              <ng-template appCell="actions" let-row>
                @if (canManage()) {
                  <button type="button" class="link" (click)="openVariant(row)">Editar</button>
                }
              </ng-template>
            </app-data-table>
          </section>
        }
        <section class="card" aria-labelledby="pf-images">
          <h2 id="pf-images" class="mb-3 font-semibold">Imagens e fichas técnicas</h2>
          <app-attachments subjectType="product" [subjectId]="p.id" [canWrite]="canManage()" />
        </section>
        <section class="card" aria-labelledby="pf-history">
          <h2 id="pf-history" class="mb-3 font-semibold">Histórico</h2>
          <app-audit-history entityType="product" [entityId]="p.id" [refreshKey]="p.version" />
        </section>
      }
    </app-entity-form-page>

    <app-modal
      [title]="vf.id ? 'Editar variante' : 'Nova variante'"
      [open]="variantOpen()"
      (closed)="variantOpen.set(false)"
    >
      <app-error-alert [error]="variantAction.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="SKU" [required]="true" [error]="variantAction.field('sku')">
          <input
            appControl
            class="input"
            data-testid="pv-sku"
            [(ngModel)]="vf.sku"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Código de barras" [error]="variantAction.field('barcode')">
          <input
            appControl
            class="input"
            data-testid="pv-barcode"
            [(ngModel)]="vf.barcode"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Atributos"
          [required]="true"
          hint="Ex.: Cor=Azul; Tamanho=M"
          [error]="variantAction.field('attributes')"
        >
          <input
            appControl
            class="input"
            data-testid="pv-attrs"
            [(ngModel)]="vf.attributes"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Preço próprio"
          hint="Vazio: o do produto."
          [error]="variantAction.field('salePrice')"
        >
          <input
            appControl
            class="input"
            inputmode="decimal"
            [(ngModel)]="vf.salePrice"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        @if (vf.id) {
          <app-field label="Estado">
            <select
              appControl
              class="input"
              data-testid="pv-status"
              [(ngModel)]="vf.status"
              [ngModelOptions]="{ standalone: true }"
            >
              @for (s of statuses; track s[0]) {
                <option [value]="s[0]">{{ s[1] }}</option>
              }
            </select>
          </app-field>
        }
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="variantOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="pv-save"
          [disabled]="variantAction.busy()"
          (click)="saveVariant()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class ProductFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly product = signal<Product | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly uoms = signal<Uom[]>([]);
  protected readonly categories = signal<Category[]>([]);
  protected readonly brands = signal<Brand[]>([]);
  protected readonly stockables = signal<Product[]>([]);
  protected readonly action = new Action();
  protected readonly variantAction = new Action();
  protected readonly variantOpen = signal(false);
  protected f: ProductForm = emptyProductForm();
  protected vf = {
    id: '',
    version: 0,
    sku: '',
    barcode: '',
    attributes: '',
    salePrice: '',
    status: 'ACTIVE',
  };
  private initial = snapshot(this.f);
  protected readonly types = Object.entries(PRODUCT_TYPE);
  protected readonly statuses = Object.entries(PRODUCT_STATUS);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected readonly canManage = computed(() => this.workspace.can('inventory.products.manage'));
  protected readonly activeUoms = computed(() => this.uoms().filter((u) => u.status === 'ACTIVE'));
  protected readonly activeBrands = computed(() =>
    this.brands().filter((b) => b.status === 'ACTIVE'),
  );
  protected readonly categoryOptions = computed(() =>
    categoryPaths(this.categories().filter((c) => c.status === 'ACTIVE')),
  );
  protected readonly componentOptions = computed(() =>
    this.stockables().filter((p) => p.id !== this.product()?.id),
  );
  protected readonly typeLabel = computed(() => {
    const p = this.product();
    return p ? `${PRODUCT_TYPE[p.productType]} · ${PRODUCT_STATUS[p.status]}` : '';
  });
  protected readonly classHint = computed(() => {
    const p = this.product();
    if (p?.effectiveAccountingClass)
      return `Em vigor: ${p.effectiveAccountingClass} (${p.accountingClassSource === 'PRODUCT' ? 'do produto' : 'da categoria'}).`;
    return 'Ex.: MERCADORIAS. Vazio: a da categoria.';
  });
  protected readonly variantColumns: Column<Variant>[] = [
    { key: 'sku', label: 'SKU', required: true },
    { key: 'attributes', label: 'Atributos', value: (v) => attributesText(v.attributes) },
    { key: 'barcode', label: 'Código de barras', hideOnMobile: true },
    {
      key: 'salePrice',
      label: 'Preço',
      align: 'end',
      hideOnMobile: true,
      value: (v) =>
        v.salePrice ? priceLabel(v.salePrice, this.product()?.currency) : 'O do produto',
    },
    { key: 'status', label: 'Estado', value: (v) => PRODUCT_STATUS[v.status] },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    warnOnUnload(this);
    void this.loadOptions();
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.canManage() && snapshot(this.f) !== this.initial;
  }

  protected barcodeWarning() {
    return !!this.f.barcode.trim() && !gtinValid(this.f.barcode.trim());
  }

  protected convertible() {
    const ids = new Set(this.f.conversions.map((c) => c.uomId).filter(Boolean));
    return this.activeUoms().filter((u) => ids.has(u.id));
  }

  protected convLabel(c: { uomId: string; factor: string }) {
    const u = this.uoms().find((x) => x.id === c.uomId);
    const base = this.uoms().find((x) => x.id === this.f.baseUomId);
    const factor = decimalText(c.factor);
    return u && base && factor ? conversionLabel(u.code, factor, base.code) : '';
  }

  private async loadOptions() {
    const get = <T>(url: string, set: (v: T) => void) =>
      this.api.get<T>(url).then(set, () => undefined);
    await Promise.all([
      get<Uom[]>('inventory/settings/uoms', (v) => this.uoms.set(v)),
      get<Category[]>('inventory/settings/categories', (v) => this.categories.set(v)),
      get<Brand[]>('inventory/settings/brands', (v) => this.brands.set(v)),
      this.api
        .page<Product>('inventory/products', {
          productType: 'STOCKABLE',
          status: 'ACTIVE',
          limit: 200,
        })
        .then(
          (p) => this.stockables.set(p.items),
          () => undefined,
        ),
    ]);
  }

  protected async load() {
    this.loadError.set(null);
    if (this.isNew()) {
      this.product.set(null);
      this.f = emptyProductForm();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const p = await this.api.get<Product>(`inventory/products/${this.id()}`);
      this.apply(p);
      this.breadcrumbs.setCurrent(p.sku);
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(p: Product) {
    this.product.set(p);
    this.f = formFromProduct(p);
    this.initial = snapshot(this.f);
  }

  protected async save() {
    const p = this.product();
    const body = productPayload(this.f);
    const r = await this.action.run(() =>
      p
        ? this.api.patch<Product>(`inventory/products/${p.id}`, {
            ...body,
            expectedVersion: p.version,
          })
        : this.api.post<Product>('inventory/products', body),
    );
    if (!r) return;
    this.apply(r);
    this.toasts.show(p ? 'Produto guardado.' : 'Produto criado.');
    if (!p) await this.router.navigate(['/inventario/produtos', r.id], { replaceUrl: true });
  }

  protected cancel() {
    void this.router.navigate(['/inventario/produtos']);
  }

  protected openVariant(v: Variant | null) {
    this.variantAction.error.set(null);
    this.vf = v
      ? {
          id: v.id,
          version: v.version,
          sku: v.sku,
          barcode: v.barcode ?? '',
          attributes: attributesText(v.attributes),
          salePrice: v.salePrice ?? '',
          status: v.status,
        }
      : {
          id: '',
          version: 0,
          sku: '',
          barcode: '',
          attributes: '',
          salePrice: '',
          status: 'ACTIVE',
        };
    this.variantOpen.set(true);
  }

  protected async saveVariant() {
    const p = this.product()!;
    const body: Record<string, unknown> = {
      sku: this.vf.sku.trim(),
      barcode: this.vf.barcode.trim() || null,
      attributes: parseAttributes(this.vf.attributes),
      salePrice: decimalText(this.vf.salePrice),
    };
    const r = await this.variantAction.run(() =>
      this.vf.id
        ? this.api.patch<Product>(`inventory/product-variants/${this.vf.id}`, {
            ...body,
            status: this.vf.status,
            expectedVersion: this.vf.version,
          })
        : this.api.post<Product>(`inventory/products/${p.id}/variants`, body),
    );
    if (!r) return;
    this.variantOpen.set(false);
    this.apply(r);
    this.toasts.show('Variante guardada.');
  }
}
