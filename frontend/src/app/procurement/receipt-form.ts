import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { qty } from '../inventory/stock-model';
import { plain } from './rfq-model';
import {
  type ExpectedDelivery,
  type Receipt,
  type ReceiptLineForm,
  receiptForm,
  receiptPayload,
  type ReceivableOrder,
} from './receipt-model';

/**
 * Recepção em rascunho: a ordem emitida, a guia do fornecedor e, por linha em falta, o que chegou (aceite) e o que se
 * recusa (com motivo), com lote, validade, séries e localização nos bens armazenáveis. A confirmação faz-se na ficha.
 */
@Component({
  selector: 'app-receipt-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, ErrorAlert],
  template: `
    <app-entity-form-page
      [title]="receipt() ? 'Editar recepção' : 'Nova recepção'"
      subtitle="Conferência do que chegou; nada entra no inventário até confirmar."
      formId="receipt-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="receipt() ? 'Guardar' : 'Registar rascunho'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Entrega" description="De que ordem e com que guia.">
        <app-field label="Ordem de compra" [required]="true" [error]="action.field('orderId')">
          <select
            appControl
            class="input"
            name="order"
            data-testid="rf-order"
            [disabled]="!!receipt()"
            [(ngModel)]="orderIdValue"
            (ngModelChange)="pickOrder($event)"
          >
            <option value="">Escolher…</option>
            @for (o of orders(); track o.id) {
              <option [value]="o.id">{{ o.number }} — {{ o.supplier }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data da recepção" [error]="action.field('receiptDate')">
          <input
            appControl
            class="input w-44"
            type="date"
            name="date"
            [(ngModel)]="f.receiptDate"
          />
        </app-field>
        <app-field label="Guia do fornecedor" [error]="action.field('deliveryNote')">
          <input
            appControl
            class="input"
            name="note"
            data-testid="rf-note"
            [(ngModel)]="f.deliveryNote"
          />
        </app-field>
        <app-field label="Notas" [error]="action.field('notes')">
          <input appControl class="input" name="notes" [(ngModel)]="f.notes" />
        </app-field>
        @if (order() && !order()!.receivable) {
          <p class="text-sm text-danger-text sm:col-span-2" data-testid="rf-not-receivable">
            Esta ordem não aceita recepções (não emitida na revisão em vigor, fechada ou anulada).
          </p>
        }
      </app-form-section>

      @if (order()) {
        <app-form-section
          title="Conferência"
          description="Aceite entra (ou fica aceite); recusada fica registada com motivo."
        >
          <div class="space-y-3 sm:col-span-2">
            @for (l of f.lines; track l.orderLineId; let i = $index) {
              <fieldset
                class="rounded border border-border p-3"
                [attr.data-testid]="'rl-' + l.lineNo"
              >
                <legend class="px-1 text-sm font-medium">
                  {{ l.lineNo }} · {{ l.description }}
                  <span class="text-muted"
                    >· em falta {{ q(l.open) }} {{ l.uom ?? ''
                    }}{{ l.stocked ? '' : ' · sem stock' }}</span
                  >
                </legend>
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <app-field label="Recebida (aceite)" [error]="fieldOf(l, 'quantity')">
                    <input
                      appControl
                      class="input"
                      inputmode="decimal"
                      [name]="'q' + i"
                      data-testid="rl-qty"
                      [(ngModel)]="l.quantity"
                    />
                  </app-field>
                  <app-field label="Recusada" [error]="fieldOf(l, 'rejectedQuantity')">
                    <input
                      appControl
                      class="input"
                      inputmode="decimal"
                      [name]="'r' + i"
                      data-testid="rl-rejected"
                      [(ngModel)]="l.rejectedQuantity"
                    />
                  </app-field>
                  <app-field label="Motivo da recusa" [error]="fieldOf(l, 'rejectReason')">
                    <input
                      appControl
                      class="input"
                      [name]="'rr' + i"
                      data-testid="rl-reason"
                      [(ngModel)]="l.rejectReason"
                    />
                  </app-field>
                  @if (l.stocked && order()!.locations.length) {
                    <app-field label="Localização" [error]="fieldOf(l, 'locationId')">
                      <select
                        appControl
                        class="input"
                        [name]="'loc' + i"
                        [(ngModel)]="l.locationId"
                      >
                        <option value="">—</option>
                        @for (x of order()!.locations; track x.id) {
                          <option [value]="x.id">{{ x.path }}</option>
                        }
                      </select>
                    </app-field>
                  }
                  @if (l.tracking.lots) {
                    <app-field label="Lote" [error]="fieldOf(l, 'lotCode')">
                      <input
                        appControl
                        class="input"
                        [name]="'lot' + i"
                        data-testid="rl-lot"
                        [(ngModel)]="l.lotCode"
                      />
                    </app-field>
                  }
                  @if (l.tracking.expiry) {
                    <app-field label="Validade" [error]="fieldOf(l, 'expiryDate')">
                      <input
                        appControl
                        class="input"
                        type="date"
                        [name]="'exp' + i"
                        data-testid="rl-expiry"
                        [(ngModel)]="l.expiryDate"
                      />
                    </app-field>
                  }
                  @if (l.tracking.serials) {
                    <app-field
                      label="Números de série"
                      hint="Separados por vírgulas ou linhas."
                      class="sm:col-span-2"
                      [error]="fieldOf(l, 'serials')"
                    >
                      <textarea
                        appControl
                        class="input min-h-16"
                        [name]="'ser' + i"
                        [(ngModel)]="l.serials"
                      ></textarea>
                    </app-field>
                  }
                </div>
              </fieldset>
            } @empty {
              <p class="text-sm text-muted">Nada em falta nesta ordem.</p>
            }
            @if (action.field('lines'); as err) {
              <p class="text-sm text-danger-text">{{ err }}</p>
            }
          </div>
        </app-form-section>
      }
      <app-error-alert [error]="orderError()" />
    </app-entity-form-page>
  `,
})
export class ReceiptForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  readonly orderId = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly receipt = signal<Receipt | null>(null);
  protected readonly order = signal<ReceivableOrder | null>(null);
  protected readonly expected = signal<ExpectedDelivery[]>([]);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly orderError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly q = qty;
  protected orderIdValue = '';
  protected f = this.empty();
  private initial = snapshot(this.f);
  /** Ordens com algo por receber (das entregas previstas), mais a escolhida. */
  protected readonly orders = computed(() => {
    const seen = new Map<string, { id: string; number: string; supplier: string }>();
    for (const e of this.expected())
      if (!seen.has(e.order.id))
        seen.set(e.order.id, { id: e.order.id, number: e.order.number, supplier: e.supplier.name });
    const o = this.order();
    if (o && !seen.has(o.id))
      seen.set(o.id, { id: o.id, number: o.number, supplier: o.supplier.name });
    return [...seen.values()];
  });

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
      receiptDate: new Date().toISOString().slice(0, 10),
      deliveryNote: '',
      notes: '',
      lines: [] as ReceiptLineForm[],
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  /** Erro do servidor para a linha (o índice é o da lista enviada). */
  protected fieldOf(l: ReceiptLineForm, field: string) {
    const sent = receiptPayload(this.f.lines);
    const i = sent.findIndex((x) => x.orderLineId === l.orderLineId);
    return i < 0 ? null : this.action.field(`lines.${i}.${field}`);
  }

  protected async pickOrder(id: string) {
    this.orderError.set(null);
    this.order.set(null);
    this.f.lines = [];
    if (!id) return;
    try {
      const o = await this.api.get<ReceivableOrder>(`procurement/receipts/orders/${id}`);
      this.order.set(o);
      this.f.lines = receiptForm(o);
    } catch (e) {
      this.orderError.set(ApiError.from(e));
    }
  }

  protected async load() {
    this.loadError.set(null);
    this.loaded.set(false);
    try {
      this.expected.set(
        await this.api.get<ExpectedDelivery[]>('procurement/receipts/expected').catch(() => []),
      );
      const id = this.id();
      if (id && id !== 'nova') {
        const r = await this.api.get<Receipt>(`procurement/receipts/${id}`);
        this.receipt.set(r);
        this.orderIdValue = r.order.id;
        const o = await this.api.get<ReceivableOrder>(`procurement/receipts/orders/${r.order.id}`);
        this.order.set(o);
        const base = receiptForm(o);
        this.f = {
          receiptDate: r.receiptDate,
          deliveryNote: r.deliveryNote ?? '',
          notes: r.notes ?? '',
          lines: base.map((l) => {
            const x = r.lines.find((y) => y.orderLineId === l.orderLineId);
            return x
              ? {
                  ...l,
                  quantity: plain(x.quantity),
                  rejectedQuantity:
                    x.rejectedQuantity === '0.000000' ? '' : plain(x.rejectedQuantity),
                  rejectReason: x.rejectReason ?? '',
                  locationId: x.location?.id ?? '',
                  lotCode: x.lotCode ?? '',
                  expiryDate: x.expiryDate ?? '',
                  serials: x.serials.join(', '),
                }
              : { ...l, quantity: '' };
          }),
        };
        this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
      } else {
        this.f = this.empty();
        this.orderIdValue = this.orderId() ?? '';
        if (this.orderIdValue) await this.pickOrder(this.orderIdValue);
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const r = this.receipt();
    const body = {
      orderId: this.orderIdValue,
      receiptDate: this.f.receiptDate,
      deliveryNote: this.f.deliveryNote.trim() || null,
      notes: this.f.notes.trim() || null,
      lines: receiptPayload(this.f.lines),
    };
    const saved = await this.action.run(() =>
      r
        ? this.api.put<Receipt>(`procurement/receipts/${r.id}`, {
            ...body,
            expectedVersion: r.version,
          })
        : this.api.post<Receipt>('procurement/receipts', body),
    );
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.toasts.show(r ? 'Recepção guardada.' : 'Recepção registada em rascunho.');
    await this.router.navigate(['/compras/recepcoes', saved.id], { replaceUrl: !r });
  }

  protected cancel() {
    const r = this.receipt();
    void this.router.navigate(r ? ['/compras/recepcoes', r.id] : ['/compras/recepcoes']);
  }
}
