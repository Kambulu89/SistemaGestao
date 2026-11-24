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
  emptyInvoiceLine,
  type Invoice,
  type InvoiceLineForm,
  invoiceLinesPayload,
  type InvoiceOptions,
} from './invoice-model';

interface Form {
  documentKind: 'INVOICE' | 'INVOICE_RECEIPT';
  legalEntityId: string;
  branchId: string;
  customerId: string;
  customerLabel: string;
  invoiceDate: string;
  currency: string;
  paymentTermsDays: string;
  customerReference: string;
  notes: string;
  lines: InvoiceLineForm[];
}

/**
 * Factura em rascunho. Sem encomenda só leva serviços (os produtos de stock facturam-se a partir da encomenda
 * expedida); numa factura de encomenda, as linhas vêm da encomenda e aqui só se ajustam a quantidade e os impostos.
 */
@Component({
  selector: 'app-invoice-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete, Icon],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Nova factura de serviços' : 'Editar factura'"
      [subtitle]="
        inv()?.order
          ? 'Da encomenda ' + inv()!.order!.number + '.'
          : 'Preços da tabela à data; impostos do motor fiscal (valores confirmados).'
      "
      formId="invoice-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar rascunho' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Cabeçalho">
        @if (isNew()) {
          <app-field
            label="Documento"
            [required]="true"
            hint="A factura-recibo só é emitida quando a tesouraria confirma o recebimento."
          >
            <select
              appControl
              class="input"
              name="kind"
              data-testid="if-kind"
              [(ngModel)]="f.documentKind"
            >
              <option value="INVOICE">Factura</option>
              <option value="INVOICE_RECEIPT">Factura-recibo</option>
            </select>
          </app-field>
        }
        <app-field
          label="Entidade emitente"
          [required]="true"
          [error]="action.field('legalEntityId')"
        >
          <select
            appControl
            class="input"
            name="le"
            data-testid="if-le"
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
        <app-field label="Estabelecimento" [error]="action.field('branchId')">
          <select appControl class="input" name="branch" [(ngModel)]="f.branchId">
            <option value="">—</option>
            @for (b of branches(); track b.id) {
              <option [value]="b.id">{{ b.code }} — {{ b.name }}</option>
            }
          </select>
        </app-field>
        <app-field #cf label="Cliente" [required]="true" [error]="action.field('customerId')">
          <app-autocomplete
            name="customer"
            data-testid="if-customer"
            [inputId]="cf.controlId"
            [describedBy]="cf.describedBy()"
            [search]="searchCustomers"
            [initialLabel]="f.customerLabel || null"
            [disabled]="fromOrder()"
            [(ngModel)]="f.customerId"
          />
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('invoiceDate')">
          <input
            appControl
            class="input"
            type="date"
            name="date"
            data-testid="if-date"
            [(ngModel)]="f.invoiceDate"
          />
        </app-field>
        @if (!fromOrder()) {
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
        <app-field label="Referência do cliente" [error]="action.field('customerReference')">
          <input appControl class="input" name="ref" [(ngModel)]="f.customerReference" />
        </app-field>
      </app-form-section>

      <section class="card space-y-4" aria-labelledby="if-lines">
        <h2 id="if-lines" class="font-semibold">Linhas</h2>
        @if (action.field('lines'); as e) {
          <p class="field-error">{{ e }}</p>
        }
        @for (l of f.lines; track l.key; let i = $index) {
          <div class="grid gap-3 border-b border-border pb-4 md:grid-cols-6" data-testid="if-line">
            <div class="md:col-span-3">
              @if (fromOrder()) {
                <p class="text-sm">
                  <strong>{{ l.productLabel }}</strong>
                </p>
              } @else {
                <app-field
                  #pf
                  label="Serviço"
                  [required]="true"
                  [error]="action.field('lines.' + i + '.productId')"
                >
                  <app-autocomplete
                    [name]="'product-' + l.key"
                    data-testid="if-product"
                    [inputId]="pf.controlId"
                    [describedBy]="pf.describedBy()"
                    [search]="searchProducts"
                    [initialLabel]="l.productLabel || null"
                    [(ngModel)]="l.productId"
                  />
                </app-field>
              }
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
                data-testid="if-qty"
                [(ngModel)]="l.quantity"
              />
            </app-field>
            @if (!fromOrder()) {
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
            }
            <fieldset class="text-sm md:col-span-2">
              <legend class="label">
                Impostos <span aria-hidden="true" class="text-danger-text">*</span>
              </legend>
              @for (c of taxCodes(); track c.id) {
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    [name]="'t' + l.key + c.id"
                    [attr.data-testid]="'if-tax-' + c.code"
                    [(ngModel)]="l.taxCodes[c.id]"
                  />
                  {{ c.code }} — {{ c.name }}
                </label>
              }
              @if (action.field('lines.' + i + '.taxCodeIds'); as e) {
                <p class="field-error">{{ e }}</p>
              }
            </fieldset>
            <app-field
              label="Motivo de isenção"
              hint="Para impostos a 0 %."
              [error]="action.field('lines.' + i + '.exemptionCode')"
            >
              <select
                appControl
                class="input"
                [name]="'ex-' + l.key"
                data-testid="if-exempt"
                [(ngModel)]="l.exemptionCode"
              >
                <option value="">—</option>
                @for (x of exemptions(); track x.code) {
                  <option [value]="x.code">{{ x.code }} — {{ x.description }}</option>
                }
              </select>
            </app-field>
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
        @if (!fromOrder()) {
          <button type="button" class="btn-secondary" data-testid="if-add" (click)="addLine()">
            <app-icon name="plus" [size]="16" />Linha
          </button>
        }
      </section>

      <app-form-section title="Notas">
        <app-field label="Notas" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class InvoiceFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly inv = signal<Invoice | null>(null);
  protected readonly opts = signal<InvoiceOptions | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly fromOrder = computed(() => !!this.inv()?.order);
  protected readonly le = signal('');
  private readonly country = computed(
    () =>
      this.opts()?.legalEntities.find((e) => e.id === (this.inv()?.legalEntity.id ?? this.le()))
        ?.countryCode ?? 'AO',
  );
  protected readonly branches = computed(() =>
    (this.opts()?.branches ?? []).filter(
      (b) => b.legalEntityId === (this.inv()?.legalEntity.id ?? this.le()),
    ),
  );
  protected readonly taxCodes = computed(() =>
    (this.opts()?.taxCodes ?? []).filter((c) => c.countryCode === this.country()),
  );
  protected readonly exemptions = computed(() =>
    (this.opts()?.exemptions ?? []).filter((c) => c.countryCode === this.country()),
  );
  protected f: Form = this.blank();
  private initial = snapshot(this.f);

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string; status: string }[]>(
        'sales/invoices/search/customers',
        { q },
      )
    )
      .filter((c) => c.status === 'ACTIVE')
      .map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));
  protected readonly searchProducts = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; sku: string; name: string }[]>(
        'sales/invoices/search/products',
        { q },
      )
    ).map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}` }));

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private blank(): Form {
    return {
      documentKind: 'INVOICE',
      legalEntityId: '',
      branchId: '',
      customerId: '',
      customerLabel: '',
      invoiceDate: new Date().toISOString().slice(0, 10),
      currency: '',
      paymentTermsDays: '',
      customerReference: '',
      notes: '',
      lines: [emptyInvoiceLine()],
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected async load() {
    this.loadError.set(null);
    this.loaded.set(false);
    try {
      const o = await this.api.get<InvoiceOptions>('sales/invoices/options');
      this.opts.set(o);
      if (this.isNew()) {
        this.f = this.blank();
        if (o.legalEntities.length === 1) this.f.legalEntityId = o.legalEntities[0].id;
      } else {
        const x = await this.api.get<Invoice>(`sales/invoices/${this.id()}`);
        this.inv.set(x);
        const plain = (v: string) =>
          v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
        this.f = {
          documentKind: x.documentKind,
          legalEntityId: x.legalEntity.id,
          branchId: x.branch?.id ?? '',
          customerId: x.customer.id,
          customerLabel: `${x.customer.code} — ${x.customer.name}`,
          invoiceDate: x.invoiceDate,
          currency: x.currency,
          paymentTermsDays: String(x.paymentTermsDays),
          customerReference: x.customerReference ?? '',
          notes: x.notes ?? '',
          lines: x.lines.map((l) => ({
            ...emptyInvoiceLine(),
            productId: l.product.id,
            productLabel: `${l.product.sku} — ${l.description}`,
            description: l.description,
            quantity: plain(l.quantity),
            manualDiscountPct: l.manualDiscountPct === null ? '' : plain(l.manualDiscountPct),
            manualUnitPrice: l.manualUnitPrice === null ? '' : plain(l.manualUnitPrice),
            taxCodes: Object.fromEntries(l.taxCodeIds.map((t) => [t, true])),
            exemptionCode: l.exemptionCode ?? '',
            orderLineId: l.orderLineId,
          })),
        };
        this.breadcrumbs.setCurrent(x.number ?? 'Rascunho');
      }
      this.le.set(this.f.legalEntityId);
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected addLine() {
    this.f.lines = [...this.f.lines, emptyInvoiceLine()];
  }
  protected removeLine(i: number) {
    const gone = this.f.lines[i];
    this.f.lines = this.f.lines.filter((l) => l !== gone);
  }

  protected async save() {
    const x = this.inv();
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    const lines = invoiceLinesPayload(this.f.lines).map((l, i) =>
      x?.order
        ? {
            orderLineId: this.f.lines[i].orderLineId,
            quantity: l.quantity,
            description: l.description,
            taxCodeIds: l.taxCodeIds,
            exemptionCode: l.exemptionCode,
          }
        : l,
    );
    const head = {
      branchId: nz(this.f.branchId),
      invoiceDate: this.f.invoiceDate,
      customerReference: nz(this.f.customerReference),
      notes: nz(this.f.notes),
      ...(x?.order
        ? {}
        : {
            customerId: this.f.customerId,
            ...(nz(this.f.currency) ? { currency: this.f.currency.trim().toUpperCase() } : {}),
            ...(nz(this.f.paymentTermsDays)
              ? { paymentTermsDays: Number(this.f.paymentTermsDays) }
              : {}),
          }),
    };
    const r = await this.action.run(() =>
      x
        ? this.api.patch<Invoice>(`sales/invoices/${x.id}`, {
            ...head,
            lines,
            expectedVersion: x.version,
          })
        : this.api.post<Invoice>('sales/invoices', {
            ...head,
            documentKind: this.f.documentKind,
            legalEntityId: this.f.legalEntityId,
            lines,
          }),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show(x ? 'Factura guardada.' : 'Rascunho criado.');
    await this.router.navigate(['/vendas/facturas', r.id], { replaceUrl: !x });
  }

  protected cancel() {
    const x = this.inv();
    void this.router.navigate(x ? ['/vendas/facturas', x.id] : ['/vendas/facturas']);
  }
}
