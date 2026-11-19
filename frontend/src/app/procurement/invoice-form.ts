import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { qty } from '../inventory/stock-model';
import { orderLineTotals } from './order-model';
import { plain } from './rfq-model';
import {
  chargeLine,
  declaredDifference,
  type Invoice,
  type InvoiceableOrder,
  invoiceForm,
  type InvoiceLineForm,
  invoicePayload,
  invoiceTotal,
} from './invoice-model';

/**
 * Factura do fornecedor em rascunho: número externo, data, vencimento, total declarado e as linhas da ordem (por omissão
 * o que foi recebido e falta facturar, aos preços da ordem), mais encargos fora da ordem. A conferência faz-se ao validar.
 */
@Component({
  selector: 'app-invoice-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Icon, ErrorAlert],
  template: `
    <app-entity-form-page
      [title]="
        invoice() ? 'Editar factura ' + invoice()!.invoiceNumber : 'Registar factura de fornecedor'
      "
      [subtitle]="
        order()
          ? 'Ordem ' +
            order()!.number +
            ' · ' +
            order()!.supplier.code +
            ' — ' +
            order()!.supplier.name +
            ' · ' +
            order()!.currency
          : ''
      "
      formId="invoice-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="invoice() ? 'Guardar' : 'Registar rascunho'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Factura" description="Os dados do documento do fornecedor.">
        <app-field
          label="Número da factura"
          [required]="true"
          [error]="action.field('invoiceNumber')"
        >
          <input
            appControl
            class="input"
            name="num"
            data-testid="if-number"
            [(ngModel)]="f.invoiceNumber"
          />
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('invoiceDate')">
          <input
            appControl
            class="input w-44"
            type="date"
            name="date"
            data-testid="if-date"
            [(ngModel)]="f.invoiceDate"
          />
        </app-field>
        <app-field
          label="Vencimento"
          [hint]="'Por omissão, a data + ' + (order()?.paymentTermsDays ?? 0) + ' dias.'"
          [error]="action.field('dueDate')"
        >
          <input appControl class="input w-44" type="date" name="due" [(ngModel)]="f.dueDate" />
        </app-field>
        <app-field
          label="Total da factura (com impostos)"
          [required]="true"
          [error]="action.field('declaredTotal')"
        >
          <input
            appControl
            class="input"
            inputmode="decimal"
            name="total"
            data-testid="if-declared"
            [(ngModel)]="f.declaredTotal"
          />
        </app-field>
        <app-field label="Notas" class="sm:col-span-2" [error]="action.field('notes')">
          <input appControl class="input" name="notes" [(ngModel)]="f.notes" />
        </app-field>
        @if (order() && !order()!.invoiceable) {
          <p class="text-sm text-danger-text sm:col-span-2">
            Esta ordem não se factura (não emitida ou anulada).
          </p>
        }
      </app-form-section>

      <app-form-section
        title="Linhas"
        description="Deixe a quantidade vazia nas linhas que esta factura não inclui."
      >
        <div class="space-y-3 sm:col-span-2">
          @for (l of f.lines; track $index; let i = $index) {
            <fieldset
              class="rounded border border-border p-3"
              [attr.data-testid]="l.orderLineId ? 'il-' + l.label.split(' ')[0] : 'il-charge'"
            >
              <legend class="px-1 text-sm font-medium">
                {{ l.label }}
                @if (l.toInvoice !== null) {
                  <span class="text-muted"
                    >· por facturar {{ q(l.toInvoice) }} {{ l.uom ?? '' }}</span
                  >
                }
              </legend>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                @if (!l.orderLineId) {
                  <app-field label="Descrição" [error]="fieldOf(l, 'description')">
                    <input
                      appControl
                      class="input"
                      [name]="'d' + i"
                      data-testid="il-desc"
                      [(ngModel)]="l.description"
                    />
                  </app-field>
                }
                <app-field label="Quantidade" [error]="fieldOf(l, 'quantity')">
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'q' + i"
                    data-testid="il-qty"
                    [(ngModel)]="l.quantity"
                  />
                </app-field>
                <app-field label="Preço unitário" [error]="fieldOf(l, 'unitPrice')">
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'p' + i"
                    data-testid="il-price"
                    [(ngModel)]="l.unitPrice"
                  />
                </app-field>
                <app-field label="Desconto (%)" [error]="fieldOf(l, 'discountRate')">
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'dc' + i"
                    [(ngModel)]="l.discountRate"
                  />
                </app-field>
                <app-field label="Imposto (%)" [error]="fieldOf(l, 'taxRate')">
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'t' + i"
                    data-testid="il-tax"
                    [(ngModel)]="l.taxRate"
                  />
                </app-field>
              </div>
              <div class="mt-2 flex items-center justify-between text-sm">
                <span class="text-muted">Total: {{ lineTotal(l) }}</span>
                @if (!l.orderLineId) {
                  <button type="button" class="link" (click)="f.lines.splice(i, 1)">
                    Remover encargo
                  </button>
                }
              </div>
            </fieldset>
          }
          <div class="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              class="btn-secondary"
              data-testid="if-add-charge"
              (click)="f.lines.push(newCharge())"
            >
              <app-icon name="plus" [size]="16" />Acrescentar encargo
            </button>
            <span class="text-sm" data-testid="if-total">
              Soma das linhas: <strong>{{ computed() }}</strong>
              @if (difference(); as d) {
                · diferença para o declarado:
                <strong [class.text-warning-text]="d !== '0.00'">{{ money(d, null) }}</strong>
              }
            </span>
          </div>
          @if (action.field('lines'); as err) {
            <p class="text-sm text-danger-text">{{ err }}</p>
          }
        </div>
      </app-form-section>
      <app-error-alert [error]="orderError()" />
    </app-entity-form-page>
  `,
})
export class InvoiceForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  readonly orderId = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly invoice = signal<Invoice | null>(null);
  protected readonly order = signal<InvoiceableOrder | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly orderError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly newCharge = chargeLine;
  protected f = this.empty();
  private initial = snapshot(this.f);

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      this.orderId();
      untracked(() => void this.load());
    });
  }

  private empty() {
    return {
      invoiceNumber: '',
      invoiceDate: new Date().toISOString().slice(0, 10),
      dueDate: '',
      declaredTotal: '',
      notes: '',
      lines: [] as InvoiceLineForm[],
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected lineTotal(l: InvoiceLineForm) {
    if (!l.quantity.trim()) return '—';
    const t = orderLineTotals(l.quantity, l.unitPrice, l.discountRate, l.taxRate);
    return t === null ? '—' : money(t.total, this.order()?.currency ?? null);
  }
  protected computed() {
    const t = invoiceTotal(this.f.lines);
    return t === null ? '—' : money(t, this.order()?.currency ?? null);
  }
  protected difference() {
    return this.f.declaredTotal.trim()
      ? declaredDifference(this.f.declaredTotal, invoiceTotal(this.f.lines))
      : null;
  }
  /** Erro do servidor para a linha (o índice é o da lista enviada). */
  protected fieldOf(l: InvoiceLineForm, field: string) {
    const i = invoicePayload(this.f.lines).findIndex((x) =>
      l.orderLineId
        ? x.orderLineId === l.orderLineId
        : x.orderLineId === null && x.description === (l.description.trim() || undefined),
    );
    return i < 0 ? null : this.action.field(`lines.${i}.${field}`);
  }

  protected async load() {
    this.loadError.set(null);
    this.loaded.set(false);
    try {
      const id = this.id();
      if (id && id !== 'nova') {
        const inv = await this.api.get<Invoice>(`procurement/invoices/${id}`);
        this.invoice.set(inv);
        const o = await this.api.get<InvoiceableOrder>(
          `procurement/invoices/orders/${inv.order.id}`,
        );
        this.order.set(o);
        const base = invoiceForm(o).map((l) => {
          const x = inv.lines.find((y) => y.orderLineId === l.orderLineId);
          return x
            ? {
                ...l,
                quantity: plain(x.quantity),
                unitPrice: plain(x.unitPrice),
                discountRate: plain(x.discountRate),
                taxRate: plain(x.taxRate),
              }
            : { ...l, quantity: '' };
        });
        const charges = inv.lines
          .filter((x) => !x.orderLineId)
          .map((x) => ({
            ...chargeLine(),
            description: x.description,
            quantity: plain(x.quantity),
            unitPrice: plain(x.unitPrice),
            discountRate: plain(x.discountRate),
            taxRate: plain(x.taxRate),
          }));
        this.f = {
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          dueDate: inv.dueDate,
          declaredTotal: plain(inv.declaredTotal),
          notes: inv.notes ?? '',
          lines: [...base, ...charges],
        };
        this.breadcrumbs.setCurrent(inv.invoiceNumber);
      } else {
        this.f = this.empty();
        const oid = this.orderId();
        if (!oid)
          throw new ApiError(400, 'ORDER_REQUIRED', 'Abra o registo a partir da ordem de compra.');
        const o = await this.api.get<InvoiceableOrder>(`procurement/invoices/orders/${oid}`);
        this.order.set(o);
        this.f.lines = invoiceForm(o);
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const inv = this.invoice();
    const o = this.order();
    if (!o) return;
    const body = {
      orderId: o.id,
      invoiceNumber: this.f.invoiceNumber,
      invoiceDate: this.f.invoiceDate,
      dueDate: this.f.dueDate || null,
      declaredTotal: this.f.declaredTotal.trim().replace(',', '.'),
      notes: this.f.notes.trim() || null,
      lines: invoicePayload(this.f.lines),
    };
    const saved = await this.action.run(() =>
      inv
        ? this.api.put<Invoice>(`procurement/invoices/${inv.id}`, {
            ...body,
            expectedVersion: inv.version,
          })
        : this.api.post<Invoice>('procurement/invoices', body),
    );
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.toasts.show(inv ? 'Factura guardada.' : 'Factura registada em rascunho.');
    await this.router.navigate(['/compras/facturas', saved.id], { replaceUrl: !inv });
  }

  protected cancel() {
    const inv = this.invoice();
    const o = this.order();
    void this.router.navigate(
      inv ? ['/compras/facturas', inv.id] : o ? ['/compras/ordens', o.id] : ['/compras/facturas'],
    );
  }
}
