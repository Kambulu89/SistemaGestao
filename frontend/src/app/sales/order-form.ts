import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  emptyOrderForm,
  formFromOrder,
  type Order,
  type OrderForm,
  type OrderOptions,
  orderPayload,
} from './order-model';
import { emptyLine, zeroRate } from './quote-model';

/**
 * Encomenda em rascunho: cliente, armazém, entrega e linhas. Os preços vêm do motor de preços à data da encomenda;
 * numa encomenda vinda de um orçamento aceite, o cliente, as condições e as linhas são as do orçamento.
 */
@Component({
  selector: 'app-order-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete, Icon],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Nova encomenda' : 'Editar encomenda'"
      [subtitle]="
        order()?.quote
          ? 'Do orçamento ' + order()!.quote!.number + ': linhas e preços aceites pelo cliente.'
          : 'Preços da tabela à data da encomenda.'
      "
      formId="order-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar encomenda' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Cliente e entrega">
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            name="le"
            data-testid="of-le"
            [disabled]="!isNew()"
            [(ngModel)]="f.legalEntityId"
            (ngModelChange)="le.set($event)"
          >
            <option value="">—</option>
            @for (e of opts()?.legalEntities ?? []; track e.id) {
              <option [value]="e.id">{{ e.code }} — {{ e.name }}</option>
            }
          </select>
        </app-field>
        <app-field #cf label="Cliente" [required]="true" [error]="action.field('customerId')">
          <app-autocomplete
            name="customer"
            data-testid="of-customer"
            [inputId]="cf.controlId"
            [describedBy]="cf.describedBy()"
            [search]="searchCustomers"
            [initialLabel]="f.customerLabel || null"
            [disabled]="fromQuote()"
            [(ngModel)]="f.customerId"
            (ngModelChange)="customerChanged($event)"
          />
        </app-field>
        <app-field
          label="Armazém"
          hint="Obrigatório se houver produtos de stock."
          [error]="action.field('warehouseId')"
        >
          <select
            appControl
            class="input"
            name="wh"
            data-testid="of-warehouse"
            [(ngModel)]="f.warehouseId"
          >
            <option value="">—</option>
            @for (w of warehouses(); track w.id) {
              <option [value]="w.id">{{ w.code }} — {{ w.name }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Morada de entrega"
          hint="Vazio: a combinar."
          [error]="action.field('deliveryAddressId')"
        >
          <select appControl class="input" name="addr" [(ngModel)]="f.deliveryAddressId">
            <option value="">—</option>
            @for (a of addresses(); track a.id) {
              <option [value]="a.id">{{ a.label }} · {{ a.line }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('orderDate')">
          <input appControl class="input" type="date" name="date" [(ngModel)]="f.orderDate" />
        </app-field>
        <app-field label="Entrega pedida" [error]="action.field('requestedDate')">
          <input
            appControl
            class="input"
            type="date"
            name="req"
            data-testid="of-requested"
            [(ngModel)]="f.requestedDate"
          />
        </app-field>
        <app-field label="Comercial" [error]="action.field('salespersonMembershipId')">
          <select
            appControl
            class="input"
            name="sp"
            [disabled]="opts()?.ownOnly ?? false"
            [(ngModel)]="f.salespersonMembershipId"
          >
            <option value="">Eu</option>
            @for (p of opts()?.salespeople ?? []; track p.membershipId) {
              <option [value]="p.membershipId">{{ p.name }}</option>
            }
          </select>
        </app-field>
        @if (!fromQuote()) {
          <app-field label="Referência do cliente" [error]="action.field('customerReference')">
            <input appControl class="input" name="ref" [(ngModel)]="f.customerReference" />
          </app-field>
          <app-field label="Moeda" hint="Vazio: a do cliente." [error]="action.field('currency')">
            <input
              appControl
              class="input w-24 uppercase"
              name="currency"
              maxlength="3"
              [(ngModel)]="f.currency"
            />
          </app-field>
          <app-field
            label="Prazo de pagamento (dias)"
            hint="Vazio: o do cliente."
            [error]="action.field('paymentTermsDays')"
          >
            <input
              appControl
              class="input w-28"
              type="number"
              min="0"
              max="365"
              name="terms"
              [(ngModel)]="f.paymentTermsDays"
            />
          </app-field>
        }
      </app-form-section>

      @if (!fromQuote()) {
        <section class="card space-y-4" aria-labelledby="of-lines-title">
          <div>
            <h2 id="of-lines-title" class="font-semibold">Linhas</h2>
            <p class="mt-0.5 text-sm text-muted">
              Produtos de stock são reservados e expedidos pelo inventário; serviços são dados por
              prestados.
            </p>
          </div>
          @if (action.field('lines'); as e) {
            <p class="field-error">{{ e }}</p>
          }
          @for (l of f.lines; track l.key; let i = $index) {
            <div
              class="grid gap-3 border-b border-border pb-4 md:grid-cols-6"
              data-testid="of-line"
            >
              <div class="md:col-span-3">
                <app-field
                  #pf
                  label="Produto ou serviço"
                  [required]="true"
                  [error]="action.field('lines.' + i + '.productId')"
                >
                  <app-autocomplete
                    [name]="'product-' + l.key"
                    data-testid="of-product"
                    [inputId]="pf.controlId"
                    [describedBy]="pf.describedBy()"
                    [search]="searchProducts"
                    [initialLabel]="l.productLabel || null"
                    [(ngModel)]="l.productId"
                  />
                </app-field>
              </div>
              <div class="md:col-span-3">
                <app-field
                  label="Descrição"
                  hint="Vazio: o nome do produto."
                  [error]="action.field('lines.' + i + '.description')"
                >
                  <input
                    appControl
                    class="input"
                    [name]="'desc-' + l.key"
                    [(ngModel)]="l.description"
                  />
                </app-field>
              </div>
              <app-field
                label="Quantidade"
                [required]="true"
                [error]="action.field('lines.' + i + '.quantity')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  [name]="'qty-' + l.key"
                  data-testid="of-qty"
                  [(ngModel)]="l.quantity"
                />
              </app-field>
              <app-field
                label="Desconto (%)"
                [error]="action.field('lines.' + i + '.manualDiscountPct')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  [name]="'disc-' + l.key"
                  [(ngModel)]="l.manualDiscountPct"
                />
              </app-field>
              <app-field
                label="Preço manual"
                [error]="action.field('lines.' + i + '.manualUnitPrice')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  [name]="'mp-' + l.key"
                  [(ngModel)]="l.manualUnitPrice"
                />
              </app-field>
              <app-field
                label="Imposto (%)"
                [required]="true"
                [error]="action.field('lines.' + i + '.taxRate')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  [name]="'tax-' + l.key"
                  data-testid="of-tax"
                  [(ngModel)]="l.taxRate"
                />
              </app-field>
              @if (zero(l.taxRate)) {
                <div class="md:col-span-2">
                  <app-field
                    label="Motivo da isenção"
                    [required]="true"
                    [error]="action.field('lines.' + i + '.taxExemptionReason')"
                  >
                    <input
                      appControl
                      class="input"
                      [name]="'ex-' + l.key"
                      data-testid="of-exempt"
                      [(ngModel)]="l.taxExemptionReason"
                    />
                  </app-field>
                </div>
              }
              @if (f.lines.length > 1) {
                <div class="md:col-span-6">
                  <button
                    type="button"
                    class="link text-sm"
                    [attr.aria-label]="'Remover a linha ' + (i + 1)"
                    (click)="removeLine(i)"
                  >
                    Remover linha
                  </button>
                </div>
              }
            </div>
          }
          <button type="button" class="btn-secondary" data-testid="of-add" (click)="addLine()">
            <app-icon name="plus" [size]="16" />Linha
          </button>
        </section>
      }

      <app-form-section title="Notas">
        <app-field label="Notas" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class OrderFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly order = signal<Order | null>(null);
  protected readonly opts = signal<OrderOptions | null>(null);
  protected readonly addresses = signal<
    { id: string; label: string; line: string; isDefault: boolean }[]
  >([]);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly fromQuote = computed(() => !!this.order()?.quote);
  protected readonly zero = zeroRate;
  protected readonly le = signal('');
  protected readonly warehouses = computed(() =>
    (this.opts()?.warehouses ?? []).filter(
      (w) => w.legalEntityId === (this.order()?.legalEntity.id ?? this.le()),
    ),
  );
  protected f: OrderForm = emptyOrderForm(new Date().toISOString().slice(0, 10));
  private initial = snapshot(this.f);

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string; status: string }[]>(
        'sales/orders/search/customers',
        { q },
      )
    )
      .filter((c) => c.status === 'ACTIVE')
      .map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));
  protected readonly searchProducts = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; sku: string; name: string }[]>(
        'sales/orders/search/products',
        { q },
      )
    ).map((p) => ({
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
      const o = await this.api.get<OrderOptions>('sales/orders/options');
      this.opts.set(o);
      if (this.isNew()) {
        this.f = emptyOrderForm(new Date().toISOString().slice(0, 10));
        if (o.legalEntities.length === 1) this.f.legalEntityId = o.legalEntities[0].id;
      } else {
        const x = await this.api.get<Order>(`sales/orders/${this.id()}`);
        this.order.set(x);
        this.f = formFromOrder(x);
        this.breadcrumbs.setCurrent(x.number ?? 'Rascunho');
        await this.loadAddresses(x.customer.id);
      }
      this.le.set(this.f.legalEntityId);
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  private async loadAddresses(customerId: string) {
    this.addresses.set(
      customerId
        ? await this.api
            .get<{ id: string; label: string; line: string; isDefault: boolean }[]>(
              `sales/orders/addresses/${customerId}`,
            )
            .catch(() => [])
        : [],
    );
  }
  protected async customerChanged(id: string) {
    this.f.deliveryAddressId = '';
    await this.loadAddresses(id);
    const d = this.addresses().find((a) => a.isDefault);
    if (d) this.f.deliveryAddressId = d.id;
  }
  protected addLine() {
    this.f.lines = [...this.f.lines, emptyLine()];
  }
  protected removeLine(i: number) {
    const gone = this.f.lines[i];
    this.f.lines = this.f.lines.filter((l) => l !== gone);
  }

  protected async save() {
    const o = this.order();
    this.le.set(this.f.legalEntityId);
    const body = orderPayload(this.f, !o, !o?.quote);
    const r = await this.action.run(() =>
      o
        ? this.api.patch<Order>(`sales/orders/${o.id}`, { ...body, expectedVersion: o.version })
        : this.api.post<Order>('sales/orders', body),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show(o ? 'Encomenda guardada.' : 'Encomenda criada.');
    await this.router.navigate(['/vendas/encomendas', r.id], { replaceUrl: !o });
  }

  protected cancel() {
    const o = this.order();
    void this.router.navigate(o ? ['/vendas/encomendas', o.id] : ['/vendas/encomendas']);
  }
}
