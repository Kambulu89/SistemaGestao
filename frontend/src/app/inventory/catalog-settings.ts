import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { type TabItem, Tabs } from '../ui/tabs';
import { ToastService } from '../ui/toasts';
import {
  type Brand,
  type Category,
  categoryPaths,
  type Uom,
  UOM_CATEGORY,
} from './inventory-model';

type Kind = 'uoms' | 'categories' | 'brands';
type Row = Uom | Category | Brand;

const LABEL: Record<Kind, string> = { uoms: 'unidade', categories: 'categoria', brands: 'marca' };

/** Configuração do catálogo: unidades de medida, categorias (hierarquia e classe contabilística) e marcas. */
@Component({
  selector: 'app-catalog-settings',
  imports: [
    FormsModule,
    PageHeader,
    Tabs,
    DataTable,
    CellDef,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Icon,
  ],
  template: `
    <app-page-header
      title="Configuração do catálogo"
      subtitle="Unidades de medida, categorias e marcas. Nada se apaga: inactiva-se."
    />
    <app-tabs label="Configuração do catálogo" [tabs]="tabs" [(active)]="tab" />
    <div
      class="mt-4"
      role="tabpanel"
      [id]="'panel-' + tab()"
      [attr.aria-labelledby]="'tab-' + tab()"
    >
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="load()" />
      } @else {
        @if (canEdit()) {
          <div class="mb-3 flex justify-end">
            <button type="button" class="btn-primary" data-testid="cs-new" (click)="open(null)">
              <app-icon name="plus" [size]="16" />Nova {{ label() }}
            </button>
          </div>
        }
        <app-data-table
          [label]="tabLabel()"
          [columns]="columns()"
          [rows]="rows()"
          [total]="rows().length"
          [limit]="1000"
          [emptyText]="'Sem registos.'"
        >
          <ng-template appCell="status" let-row>
            <span
              class="badge"
              [class]="
                row.status === 'ACTIVE'
                  ? 'bg-success-soft text-success-text'
                  : 'bg-surface-2 text-muted'
              "
              >{{ row.status === 'ACTIVE' ? 'Activo' : 'Inactivo' }}</span
            >
          </ng-template>
          <ng-template appCell="actions" let-row>
            @if (canEdit()) {
              <button
                type="button"
                class="link"
                [attr.aria-label]="'Editar ' + row.code"
                (click)="open(row)"
              >
                Editar
              </button>
            }
          </ng-template>
        </app-data-table>
      }
    </div>

    <app-modal
      [title]="(form.id ? 'Editar ' : 'Nova ') + label()"
      [open]="opened()"
      (closed)="opened.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input uppercase"
            data-testid="cs-code"
            [(ngModel)]="form.code"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="cs-name"
            [(ngModel)]="form.name"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        @if (tab() === 'uoms') {
          <app-field label="Grandeza" [required]="true" [error]="action.field('category')">
            <select
              appControl
              class="input"
              data-testid="cs-category"
              [(ngModel)]="form.category"
              [ngModelOptions]="{ standalone: true }"
            >
              @for (c of uomCategories; track c[0]) {
                <option [value]="c[0]">{{ c[1] }}</option>
              }
            </select>
          </app-field>
          <app-field
            label="Casas decimais"
            hint="0 para unidades inteiras (obrigatório com números de série)."
            [error]="action.field('decimals')"
          >
            <input
              appControl
              class="input"
              type="number"
              min="0"
              max="6"
              data-testid="cs-decimals"
              [(ngModel)]="form.decimals"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        @if (tab() === 'categories') {
          <app-field label="Categoria superior" [error]="action.field('parentId')">
            <select
              appControl
              class="input"
              data-testid="cs-parent"
              [(ngModel)]="form.parentId"
              [ngModelOptions]="{ standalone: true }"
            >
              <option value="">— (topo)</option>
              @for (c of parentOptions(); track c.id) {
                <option [value]="c.id">{{ c.label }}</option>
              }
            </select>
          </app-field>
          <app-field
            label="Classe contabilística"
            hint="Liga os produtos às regras de lançamento (ex.: MERCADORIAS)."
            [error]="action.field('accountingClass')"
          >
            <input
              appControl
              class="input uppercase"
              data-testid="cs-class"
              [(ngModel)]="form.accountingClass"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        @if (form.id) {
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="cs-active"
              [(ngModel)]="form.active"
              [ngModelOptions]="{ standalone: true }"
            />
            Activo
          </label>
        }
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="cs-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class CatalogSettings {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly tabs: TabItem[] = [
    { id: 'uoms', label: 'Unidades de medida' },
    { id: 'categories', label: 'Categorias' },
    { id: 'brands', label: 'Marcas' },
  ];
  protected readonly tab = signal<string>('uoms');
  protected readonly data = signal<Record<Kind, Row[]>>({ uoms: [], categories: [], brands: [] });
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly canEdit = computed(() => this.workspace.can('inventory.settings'));
  protected readonly uomCategories = Object.entries(UOM_CATEGORY);
  protected form = this.empty();
  protected readonly rows = computed(() => this.data()[this.tab() as Kind]);
  protected readonly label = computed(() => LABEL[this.tab() as Kind]);
  protected readonly tabLabel = computed(() => this.tabs.find((t) => t.id === this.tab())!.label);
  protected readonly parentOptions = computed(() =>
    categoryPaths(this.data().categories as Category[]).filter((c) => c.id !== this.form.id),
  );
  private readonly paths = computed(
    () => new Map(categoryPaths(this.data().categories as Category[]).map((c) => [c.id, c.label])),
  );
  protected readonly columns = computed<Column<Row>[]>(() => {
    const base: Column<Row>[] = [
      { key: 'code', label: 'Código', required: true },
      { key: 'name', label: 'Nome' },
    ];
    const extra: Column<Row>[] =
      this.tab() === 'uoms'
        ? [
            { key: 'category', label: 'Grandeza', value: (r) => UOM_CATEGORY[(r as Uom).category] },
            { key: 'decimals', label: 'Casas', value: (r) => String((r as Uom).decimals) },
          ]
        : this.tab() === 'categories'
          ? [
              {
                key: 'path',
                label: 'Caminho',
                hideOnMobile: true,
                value: (r) => this.paths().get(r.id) ?? '',
              },
              {
                key: 'accountingClass',
                label: 'Classe contabilística',
                value: (r) => (r as Category).accountingClass,
              },
            ]
          : [];
    return [
      ...base,
      ...extra,
      { key: 'status', label: 'Estado' },
      { key: 'actions', label: 'Acções', required: true },
    ];
  });

  constructor() {
    void this.load();
  }

  private empty() {
    return {
      id: '',
      version: 0,
      code: '',
      name: '',
      category: 'UNIT',
      decimals: 0,
      parentId: '',
      accountingClass: '',
      active: true,
    };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [uoms, categories, brands] = await Promise.all([
        this.api.get<Uom[]>('inventory/settings/uoms'),
        this.api.get<Category[]>('inventory/settings/categories'),
        this.api.get<Brand[]>('inventory/settings/brands'),
      ]);
      this.data.set({ uoms, categories, brands });
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected open(r: Row | null) {
    this.action.error.set(null);
    this.form = r
      ? {
          ...this.empty(),
          id: r.id,
          version: r.version,
          code: r.code,
          name: r.name,
          category: (r as Uom).category ?? 'UNIT',
          decimals: (r as Uom).decimals ?? 0,
          parentId: (r as Category).parentId ?? '',
          accountingClass: (r as Category).accountingClass ?? '',
          active: r.status === 'ACTIVE',
        }
      : this.empty();
    this.opened.set(true);
  }

  protected async save() {
    const kind = this.tab() as Kind;
    const f = this.form;
    const body: Record<string, unknown> = { code: f.code.trim(), name: f.name.trim() };
    if (kind === 'uoms')
      Object.assign(body, { category: f.category, decimals: Number(f.decimals) });
    if (kind === 'categories')
      Object.assign(body, {
        parentId: f.parentId || null,
        accountingClass: f.accountingClass.trim().toUpperCase() || null,
      });
    if (f.id)
      Object.assign(body, { status: f.active ? 'ACTIVE' : 'INACTIVE', expectedVersion: f.version });
    const r = await this.action.run(() =>
      f.id
        ? this.api.patch(`inventory/settings/${kind}/${f.id}`, body)
        : this.api.post(`inventory/settings/${kind}`, body),
    );
    if (!r) return;
    this.opened.set(false);
    this.toasts.show('Guardado.');
    await this.load();
  }
}
