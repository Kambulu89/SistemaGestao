import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { qty } from '../inventory/stock-model';
import type { DemandGroup } from './requisition-model';
import { plain } from './rfq-model';
import {
  emptyOrderLine,
  type Order,
  orderGrandTotal,
  type OrderLineForm,
  orderLinePayload,
  orderLineTotals,
  type OrderOptions,
  PAYMENT_METHOD,
} from './order-model';

/**
 * Ordem de compra em rascunho (ou recusada, ou numa revisão aberta): fornecedor homologado, entidade, filial, centro de
 * custo, armazém de entrega, moeda, datas e condições; linhas das requisições aprovadas, do catálogo ou livres, com
 * preço, desconto e imposto. O total é recalculado no servidor.
 */
@Component({
  selector: 'app-purchase-order-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Icon],
  template: `
    <app-entity-form-page
      [title]="
        isNew() ? 'Nova ordem de compra' : 'Editar ordem ' + (order()?.number ?? '(rascunho)')
      "
      [subtitle]="
        order()?.revision
          ? 'Revisão ' +
            order()!.revision +
            ': depois de guardar, peça de novo a aprovação e volte a emitir.'
          : 'Fica em rascunho até pedir a aprovação; o total em moeda funcional decide as etapas.'
      "
      formId="purchase-order-form"
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
      <app-form-section
        title="Fornecedor e entrega"
        description="A quem se encomenda, para onde e quando."
      >
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            name="le"
            data-testid="of-le"
            [disabled]="!isNew()"
            [(ngModel)]="f.legalEntityId"
            (ngModelChange)="tick.set(tick() + 1)"
          >
            <option value="">Escolher…</option>
            @for (l of opts()?.legalEntities ?? []; track l.id) {
              <option [value]="l.id">{{ l.code }}</option>
            }
          </select>
        </app-field>
        <app-field label="Fornecedor" [required]="true" [error]="action.field('supplierId')">
          <select
            appControl
            class="input"
            name="sup"
            data-testid="of-supplier"
            [disabled]="!!order()?.number"
            [(ngModel)]="f.supplierId"
            (ngModelChange)="supplierChanged()"
          >
            <option value="">Escolher…</option>
            @for (s of opts()?.suppliers ?? []; track s.id) {
              <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Filial" [error]="action.field('branchId')">
          <select appControl class="input" name="branch" [(ngModel)]="f.branchId">
            <option value="">—</option>
            @for (b of ofLe('branches'); track b.id) {
              <option [value]="b.id">{{ b.code }} — {{ b.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Centro de custo" [error]="action.field('costCenterId')">
          <select
            appControl
            class="input"
            name="cc"
            data-testid="of-cc"
            [(ngModel)]="f.costCenterId"
          >
            <option value="">—</option>
            @for (c of ofLe('costCenters'); track c.id) {
              <option [value]="c.id">{{ c.code }} — {{ c.name }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Armazém de entrega"
          hint="Obrigatório com produtos armazenáveis."
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
            @for (w of ofLe('warehouses'); track w.id) {
              <option [value]="w.id">{{ w.code }} — {{ w.name }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Moeda"
          hint="Por omissão, a do fornecedor."
          [error]="action.field('currency')"
        >
          <input
            appControl
            class="input w-24"
            name="currency"
            maxlength="3"
            [disabled]="!!order()?.number"
            [(ngModel)]="f.currency"
          />
        </app-field>
        <app-field label="Data da ordem" [error]="action.field('orderDate')">
          <input appControl class="input w-44" type="date" name="od" [(ngModel)]="f.orderDate" />
        </app-field>
        <app-field label="Entrega prevista" [error]="action.field('expectedDate')">
          <input
            appControl
            class="input w-44"
            type="date"
            name="ed"
            data-testid="of-expected"
            [(ngModel)]="f.expectedDate"
          />
        </app-field>
        <app-field label="Condições de entrega" [error]="action.field('deliveryTerms')">
          <input appControl class="input" name="dt" [(ngModel)]="f.deliveryTerms" />
        </app-field>
        <app-field label="Incoterm" [error]="action.field('incoterm')">
          <input appControl class="input w-24" name="inco" maxlength="3" [(ngModel)]="f.incoterm" />
        </app-field>
        <app-field
          label="Morada de entrega"
          class="sm:col-span-2"
          [error]="action.field('deliveryAddress')"
        >
          <input appControl class="input" name="addr" [(ngModel)]="f.deliveryAddress" />
        </app-field>
      </app-form-section>

      <app-form-section title="Pagamento e referências">
        <app-field label="Prazo de pagamento (dias)" [error]="action.field('paymentTermsDays')">
          <input
            appControl
            class="input w-28"
            inputmode="numeric"
            name="terms"
            data-testid="of-terms"
            [(ngModel)]="f.paymentTermsDays"
          />
        </app-field>
        <app-field label="Meio de pagamento" [error]="action.field('paymentMethod')">
          <select appControl class="input" name="pm" [(ngModel)]="f.paymentMethod">
            <option value="">—</option>
            @for (m of methods; track m[0]) {
              <option [value]="m[0]">{{ m[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Referência do fornecedor" [error]="action.field('supplierReference')">
          <input appControl class="input" name="sref" [(ngModel)]="f.supplierReference" />
        </app-field>
        <app-field label="Notas" class="sm:col-span-2" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>

      <app-form-section
        title="Linhas"
        description="Das requisições aprovadas (quantidade em aberto), do catálogo ou descrição livre."
      >
        <div class="space-y-3 sm:col-span-2">
          @if (demandLines().length) {
            <div class="flex flex-wrap items-end gap-2">
              <app-field label="Acrescentar da requisição">
                <select
                  appControl
                  class="input"
                  name="fromReq"
                  data-testid="of-from-req"
                  [(ngModel)]="pick"
                >
                  <option value="">Escolher linha em aberto…</option>
                  @for (d of demandLines(); track d.lineId) {
                    <option [value]="d.lineId">{{ d.label }}</option>
                  }
                </select>
              </app-field>
              <button
                type="button"
                class="btn-secondary"
                data-testid="of-add-req"
                [disabled]="!pick"
                (click)="addFromRequisition()"
              >
                Acrescentar
              </button>
            </div>
          }
          @for (l of f.lines; track $index; let i = $index) {
            <fieldset class="rounded border border-border p-3" [attr.data-testid]="'ol-' + i">
              <legend class="px-1 text-sm font-medium">
                Linha {{ i + 1 }}
                @if (l.requisitionLabel) {
                  <span class="text-muted">· {{ l.requisitionLabel }}</span>
                }
                @if (l.received !== '0') {
                  <span class="text-muted">· recebido {{ q(l.received) }}</span>
                }
              </legend>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                @if (!l.requisitionLineId && !l.id) {
                  <app-field label="Produto" [error]="action.field('lines.' + i + '.productId')">
                    <select
                      appControl
                      class="input"
                      [name]="'prod' + i"
                      data-testid="ol-product"
                      [(ngModel)]="l.productId"
                      (ngModelChange)="productChanged(l)"
                    >
                      <option value="">Descrição livre</option>
                      @for (p of opts()?.products ?? []; track p.id) {
                        <option [value]="p.id">{{ p.sku }} — {{ p.name }}</option>
                      }
                    </select>
                  </app-field>
                }
                <app-field label="Descrição" [error]="action.field('lines.' + i + '.description')">
                  <input
                    appControl
                    class="input"
                    [name]="'desc' + i"
                    data-testid="ol-desc"
                    [(ngModel)]="l.description"
                  />
                </app-field>
                <app-field
                  label="Quantidade"
                  [required]="true"
                  [error]="action.field('lines.' + i + '.quantity')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'qty' + i"
                    data-testid="ol-qty"
                    [(ngModel)]="l.quantity"
                  />
                </app-field>
                @if (!l.requisitionLineId && !l.id) {
                  <app-field label="Unidade" [error]="action.field('lines.' + i + '.uomId')">
                    <select appControl class="input" [name]="'uom' + i" [(ngModel)]="l.uomId">
                      <option value="">—</option>
                      @for (u of opts()?.uoms ?? []; track u.id) {
                        <option [value]="u.id">{{ u.code }}</option>
                      }
                    </select>
                  </app-field>
                }
                <app-field
                  label="Preço unitário"
                  [required]="true"
                  [error]="action.field('lines.' + i + '.unitPrice')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'price' + i"
                    data-testid="ol-price"
                    [(ngModel)]="l.unitPrice"
                  />
                </app-field>
                <app-field
                  label="Desconto (%)"
                  [error]="action.field('lines.' + i + '.discountRate')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'disc' + i"
                    data-testid="ol-discount"
                    [(ngModel)]="l.discountRate"
                  />
                </app-field>
                <app-field label="Imposto (%)" [error]="action.field('lines.' + i + '.taxRate')">
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'tax' + i"
                    data-testid="ol-tax"
                    [(ngModel)]="l.taxRate"
                  />
                </app-field>
                <app-field label="Entrega" [error]="action.field('lines.' + i + '.expectedDate')">
                  <input
                    appControl
                    class="input"
                    type="date"
                    [name]="'led' + i"
                    [(ngModel)]="l.expectedDate"
                  />
                </app-field>
              </div>
              @if (action.field('lines.' + i + '.requisitionLineId'); as err) {
                <p class="mt-2 text-sm text-danger-text">{{ err }}</p>
              }
              <div class="mt-2 flex items-center justify-between text-sm">
                <span class="text-muted" data-testid="ol-total">Total: {{ total(l) }}</span>
                @if (f.lines.length > 1 && l.received === '0') {
                  <button type="button" class="link" (click)="removeLine(i)">Remover linha</button>
                }
              </div>
            </fieldset>
          }
          @if (action.field('lines'); as err) {
            <p class="text-sm text-danger-text">{{ err }}</p>
          }
          <div class="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              class="btn-secondary"
              data-testid="of-add-line"
              (click)="addLine()"
            >
              <app-icon name="plus" [size]="16" />Acrescentar linha
            </button>
            <strong data-testid="of-total">Total: {{ grandTotal() }}</strong>
          </div>
        </div>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class PurchaseOrderForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  /** Vindo das necessidades consolidadas: entidade e linhas de requisição (ids separados por vírgula). */
  readonly legalEntityId = input<string | null>(null);
  readonly requisitionLines = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly opts = signal<OrderOptions | null>(null);
  protected readonly demand = signal<DemandGroup[]>([]);
  protected readonly order = signal<Order | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly methods = Object.entries(PAYMENT_METHOD);
  protected readonly q = qty;
  protected readonly tick = signal(0);
  protected f = this.empty();
  protected pick = '';
  private initial = snapshot(this.f);
  protected readonly demandLines = computed(() => {
    this.tick();
    const used = new Set(this.f.lines.map((l) => l.requisitionLineId));
    return this.demand()
      .filter((g) => g.legalEntity.id === this.f.legalEntityId)
      .flatMap((g) =>
        g.lines
          .filter((l) => !used.has(l.lineId))
          .map((l) => ({
            lineId: l.lineId,
            open: l.open,
            group: g,
            label: `${l.number} · ${g.product ? g.product.sku + ' — ' : ''}${g.description} (${qty(l.open)} ${g.uom ?? ''})`,
          })),
      );
  });

  constructor() {
    warnOnUnload(this);
    void this.boot();
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private async boot() {
    try {
      this.opts.set(await this.api.get<OrderOptions>('procurement/orders/options'));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
      return;
    }
    try {
      this.demand.set(await this.api.get<DemandGroup[]>('procurement/requisitions/demand'));
    } catch {
      this.demand.set([]);
    }
    if (this.isNew()) this.prefill();
  }

  private empty() {
    return {
      legalEntityId: '',
      supplierId: '',
      branchId: '',
      costCenterId: '',
      warehouseId: '',
      currency: '',
      orderDate: new Date().toISOString().slice(0, 10),
      expectedDate: '',
      deliveryTerms: '',
      deliveryAddress: '',
      incoterm: '',
      paymentTermsDays: '',
      paymentMethod: '',
      supplierReference: '',
      notes: '',
      lines: [emptyOrderLine()] as OrderLineForm[],
    };
  }

  protected ofLe(kind: 'branches' | 'costCenters' | 'warehouses') {
    return (this.opts()?.[kind] ?? []).filter((x) => x.legalEntityId === this.f.legalEntityId);
  }

  private prefill() {
    const le = this.legalEntityId();
    const ids = (this.requisitionLines() ?? '').split(',').filter(Boolean);
    if (!le && !ids.length) return;
    if (le) this.f.legalEntityId = le;
    this.tick.update((n) => n + 1);
    const lines = ids
      .map((id) => this.demandLines().find((d) => d.lineId === id))
      .filter((d) => !!d)
      .map((d) => this.fromDemand(d!));
    if (lines.length) this.f.lines = lines;
    this.initial = snapshot(this.f);
    this.tick.update((n) => n + 1);
  }

  private fromDemand(d: {
    lineId: string;
    open: string;
    group: DemandGroup;
    label: string;
  }): OrderLineForm {
    return {
      ...emptyOrderLine(),
      requisitionLineId: d.lineId,
      requisitionLabel: d.label.split(' · ')[0],
      productId: d.group.product?.id ?? '',
      description: d.group.description,
      quantity: plain(d.open),
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected supplierChanged() {
    const s = this.opts()?.suppliers.find((x) => x.id === this.f.supplierId);
    if (!s) return;
    if (!this.order()?.number) this.f.currency = s.currency;
    if (this.f.paymentTermsDays === '' && s.paymentTermsDays !== null)
      this.f.paymentTermsDays = String(s.paymentTermsDays);
  }

  protected productChanged(l: OrderLineForm) {
    const p = this.opts()?.products.find((x) => x.id === l.productId);
    if (!p) return;
    l.description = p.name;
    l.uomId = p.uomId;
  }

  protected total(l: OrderLineForm) {
    const t = orderLineTotals(l.quantity, l.unitPrice, l.discountRate, l.taxRate);
    return t === null ? '—' : money(t.total, this.f.currency || null);
  }
  protected grandTotal() {
    const t = orderGrandTotal(this.f.lines);
    return t === null ? '—' : money(t, this.f.currency || null);
  }

  protected addLine() {
    this.f.lines.push(emptyOrderLine());
  }
  protected removeLine(i: number) {
    this.f.lines.splice(i, 1);
    this.tick.update((n) => n + 1);
  }
  protected addFromRequisition() {
    const d = this.demandLines().find((x) => x.lineId === this.pick);
    if (!d) return;
    const line = this.fromDemand(d);
    const only =
      this.f.lines.length === 1 && !this.f.lines[0].description && !this.f.lines[0].productId;
    if (only) this.f.lines = [line];
    else this.f.lines.push(line);
    this.pick = '';
    this.tick.update((n) => n + 1);
  }

  protected async load() {
    this.loadError.set(null);
    if (this.isNew()) {
      this.f = this.empty();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      if (this.opts()) this.prefill();
      return;
    }
    this.loaded.set(false);
    try {
      const o = await this.api.get<Order>(`procurement/orders/${this.id()}`);
      this.order.set(o);
      this.f = {
        legalEntityId: o.legalEntity.id,
        supplierId: o.supplier.id,
        branchId: o.branch?.id ?? '',
        costCenterId: o.costCenter?.id ?? '',
        warehouseId: o.warehouse?.id ?? '',
        currency: o.currency,
        orderDate: o.orderDate,
        expectedDate: o.expectedDate ?? '',
        deliveryTerms: o.deliveryTerms ?? '',
        deliveryAddress: o.deliveryAddress ?? '',
        incoterm: o.incoterm ?? '',
        paymentTermsDays: o.paymentTermsDays === null ? '' : String(o.paymentTermsDays),
        paymentMethod: o.paymentMethod ?? '',
        supplierReference: o.supplierReference ?? '',
        notes: o.notes ?? '',
        lines: o.lines.map((l) => ({
          id: l.id,
          requisitionLineId: l.requisition?.lineId ?? '',
          requisitionLabel: l.requisition?.number ?? '',
          productId: l.product?.id ?? '',
          description: l.description,
          uomId: l.uom?.id ?? '',
          quantity: plain(l.quantity),
          unitPrice: plain(l.unitPrice),
          discountRate: plain(l.discountRate),
          taxRate: plain(l.taxRate),
          expectedDate: l.expectedDate ?? '',
          received: plain(l.receivedQuantity),
        })),
      };
      this.initial = snapshot(this.f);
      this.tick.update((n) => n + 1);
      this.breadcrumbs.setCurrent(o.number ?? 'Rascunho');
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected async save() {
    const o = this.order();
    const t = (v: string) => v.trim() || null;
    const body = {
      legalEntityId: this.f.legalEntityId,
      supplierId: this.f.supplierId,
      branchId: t(this.f.branchId),
      costCenterId: t(this.f.costCenterId),
      warehouseId: t(this.f.warehouseId),
      currency: this.f.currency.trim().toUpperCase() || undefined,
      orderDate: this.f.orderDate,
      expectedDate: t(this.f.expectedDate),
      deliveryTerms: t(this.f.deliveryTerms),
      deliveryAddress: t(this.f.deliveryAddress),
      incoterm: t(this.f.incoterm),
      paymentTermsDays:
        this.f.paymentTermsDays.trim() === '' ? null : Number(this.f.paymentTermsDays),
      paymentMethod: t(this.f.paymentMethod),
      supplierReference: t(this.f.supplierReference),
      notes: t(this.f.notes),
      lines: this.f.lines.map(orderLinePayload),
    };
    const saved = await this.action.run(() =>
      o
        ? this.api.put<Order>(`procurement/orders/${o.id}`, { ...body, expectedVersion: o.version })
        : this.api.post<Order>('procurement/orders', body),
    );
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.toasts.show(o ? 'Ordem guardada.' : 'Rascunho criado.');
    await this.router.navigate(['/compras/ordens', saved.id], { replaceUrl: !o });
  }

  protected cancel() {
    const o = this.order();
    void this.router.navigate(o ? ['/compras/ordens', o.id] : ['/compras/ordens']);
  }
}
