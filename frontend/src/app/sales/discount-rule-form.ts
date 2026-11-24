import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type DiscountRule,
  type PricingOptions,
  type ProductHit,
  qty,
  RULE_TARGET,
  type RuleTarget,
} from './pricing-model';

interface RuleForm {
  code: string;
  name: string;
  targetType: RuleTarget;
  segmentId: string;
  customerId: string;
  customerLabel: string;
  scope: 'ALL' | 'PRODUCT' | 'CATEGORY';
  productId: string;
  productLabel: string;
  categoryId: string;
  minQuantity: string;
  discountPct: string;
  validFrom: string;
  validTo: string;
  priority: string;
  notes: string;
}

const blank = (): RuleForm => ({
  code: '',
  name: '',
  targetType: 'ALL',
  segmentId: '',
  customerId: '',
  customerLabel: '',
  scope: 'ALL',
  productId: '',
  productLabel: '',
  categoryId: '',
  minQuantity: '0',
  discountPct: '',
  validFrom: new Date().toISOString().slice(0, 10),
  validTo: '',
  priority: '100',
  notes: '',
});

/** Regra de desconto automático (só em rascunho). */
@Component({
  selector: 'app-discount-rule-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Nova regra de desconto' : 'Editar ' + (rule()?.code ?? '')"
      subtitle="Só conta depois de aprovada por outra pessoa; numa linha aplica-se uma única regra."
      formId="discount-rule-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar regra' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Regra">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input uppercase"
            name="code"
            data-testid="drf-code"
            [disabled]="!isNew()"
            [(ngModel)]="f.code"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input appControl class="input" name="name" data-testid="drf-name" [(ngModel)]="f.name" />
        </app-field>
        <app-field label="Desconto (%)" [required]="true" [error]="action.field('discountPct')">
          <input
            appControl
            class="input w-28"
            inputmode="decimal"
            name="pct"
            data-testid="drf-pct"
            [(ngModel)]="f.discountPct"
          />
        </app-field>
        <app-field
          label="Prioridade"
          hint="0 a 1000; maior ganha."
          [error]="action.field('priority')"
        >
          <input
            appControl
            class="input w-28"
            type="number"
            min="0"
            max="1000"
            name="priority"
            [(ngModel)]="f.priority"
          />
        </app-field>
      </app-form-section>
      <app-form-section title="A quem e a quê">
        <app-field label="Clientes" [required]="true" [error]="action.field('targetType')">
          <select
            appControl
            class="input"
            name="target"
            data-testid="drf-target"
            [(ngModel)]="f.targetType"
          >
            @for (t of targets; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        @if (f.targetType === 'SEGMENT') {
          <app-field label="Segmento" [required]="true" [error]="action.field('segmentId')">
            <select appControl class="input" name="segment" [(ngModel)]="f.segmentId">
              <option value="">—</option>
              @for (s of opts()?.segments ?? []; track s.id) {
                <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
              }
            </select>
          </app-field>
        }
        @if (f.targetType === 'CUSTOMER') {
          <app-field #cf label="Cliente" [required]="true" [error]="action.field('customerId')">
            <app-autocomplete
              name="customer"
              [inputId]="cf.controlId"
              [describedBy]="cf.describedBy()"
              [search]="searchCustomers"
              [initialLabel]="f.customerLabel || null"
              [(ngModel)]="f.customerId"
            />
          </app-field>
        }
        <app-field label="Produtos" [error]="action.field('productId')">
          <select
            appControl
            class="input"
            name="scope"
            data-testid="drf-scope"
            [(ngModel)]="f.scope"
          >
            <option value="ALL">Todos os produtos</option>
            <option value="CATEGORY">Uma categoria (e subcategorias)</option>
            <option value="PRODUCT">Um produto</option>
          </select>
        </app-field>
        @if (f.scope === 'CATEGORY') {
          <app-field label="Categoria" [required]="true" [error]="action.field('categoryId')">
            <select
              appControl
              class="input"
              name="category"
              data-testid="drf-category"
              [(ngModel)]="f.categoryId"
            >
              <option value="">—</option>
              @for (c of opts()?.categories ?? []; track c.id) {
                <option [value]="c.id">{{ c.code }} — {{ c.name }}</option>
              }
            </select>
          </app-field>
        }
        @if (f.scope === 'PRODUCT') {
          <app-field #pf label="Produto" [required]="true" [error]="action.field('productId')">
            <app-autocomplete
              name="product"
              data-testid="drf-product"
              [inputId]="pf.controlId"
              [describedBy]="pf.describedBy()"
              [search]="searchProducts"
              [initialLabel]="f.productLabel || null"
              [(ngModel)]="f.productId"
            />
          </app-field>
        }
        <app-field
          label="A partir da quantidade"
          hint="0: qualquer quantidade."
          [error]="action.field('minQuantity')"
        >
          <input
            appControl
            class="input w-36"
            inputmode="decimal"
            name="min"
            data-testid="drf-min"
            [(ngModel)]="f.minQuantity"
          />
        </app-field>
      </app-form-section>
      <app-form-section title="Período">
        <app-field label="De" [required]="true" [error]="action.field('validFrom')">
          <input
            appControl
            class="input"
            type="date"
            name="from"
            data-testid="drf-from"
            [(ngModel)]="f.validFrom"
          />
        </app-field>
        <app-field label="Até" hint="Vazio: sem fim." [error]="action.field('validTo')">
          <input appControl class="input" type="date" name="to" [(ngModel)]="f.validTo" />
        </app-field>
        <app-field label="Notas" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class DiscountRuleFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly rule = signal<DiscountRule | null>(null);
  protected readonly opts = signal<PricingOptions | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly targets = Object.entries(RULE_TARGET);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected f = blank();
  private initial = snapshot(this.f);

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string }[]>(
        'sales/pricing/search/customers',
        { q },
      )
    ).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));
  protected readonly searchProducts = async (q: string): Promise<Option[]> =>
    (await this.api.get<ProductHit[]>('sales/pricing/search/products', { q })).map((p) => ({
      id: p.id,
      label: `${p.sku} — ${p.name}`,
    }));

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected async load() {
    this.loadError.set(null);
    this.loaded.set(false);
    try {
      this.opts.set(await this.api.get<PricingOptions>('sales/pricing/options'));
      if (this.isNew()) this.f = blank();
      else {
        const r = await this.api.get<DiscountRule>(`sales/discount-rules/${this.id()}`);
        this.rule.set(r);
        this.f = {
          code: r.code,
          name: r.name,
          targetType: r.targetType,
          segmentId: r.segment?.id ?? '',
          customerId: r.customer?.id ?? '',
          customerLabel: r.customer ? `${r.customer.code} — ${r.customer.name}` : '',
          scope: r.product ? 'PRODUCT' : r.category ? 'CATEGORY' : 'ALL',
          productId: r.product?.id ?? '',
          productLabel: r.product ? `${r.product.sku} — ${r.product.name}` : '',
          categoryId: r.category?.id ?? '',
          minQuantity: qty(r.minQuantity).replace(',', '.'),
          discountPct: r.discountPct,
          validFrom: r.validFrom,
          validTo: r.validTo ?? '',
          priority: String(r.priority),
          notes: r.notes ?? '',
        };
        this.breadcrumbs.setCurrent(r.code);
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const r = this.rule();
    const f = this.f;
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    const body = {
      ...(r ? {} : { code: f.code.trim() }),
      name: f.name.trim(),
      targetType: f.targetType,
      segmentId: f.targetType === 'SEGMENT' ? nz(f.segmentId) : null,
      customerId: f.targetType === 'CUSTOMER' ? nz(f.customerId) : null,
      productId: f.scope === 'PRODUCT' ? nz(f.productId) : null,
      categoryId: f.scope === 'CATEGORY' ? nz(f.categoryId) : null,
      minQuantity: nz(f.minQuantity) ?? '0',
      discountPct: f.discountPct.trim(),
      validFrom: f.validFrom,
      validTo: nz(f.validTo),
      priority: Number(f.priority),
      notes: nz(f.notes),
    };
    const res = await this.action.run(() =>
      r
        ? this.api.patch<DiscountRule>(`sales/discount-rules/${r.id}`, {
            ...body,
            expectedVersion: r.version,
          })
        : this.api.post<DiscountRule>('sales/discount-rules', body),
    );
    if (!res) return;
    this.initial = snapshot(this.f);
    this.toasts.show(r ? 'Regra guardada.' : 'Regra criada.');
    await this.router.navigate(['/vendas/descontos', res.id], { replaceUrl: !r });
  }

  protected cancel() {
    const r = this.rule();
    void this.router.navigate(r ? ['/vendas/descontos', r.id] : ['/vendas/descontos']);
  }
}
