import { Component, effect, inject, input, signal, untracked } from '@angular/core';
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
import type { ReceiptRow } from './receipt-model';
import {
  overLeft,
  type PurchaseReturn,
  REMEDY,
  type Remedy,
  RETURN_REASON,
  RETURN_SOURCE,
  type ReturnableReceipt,
  type ReturnLineForm,
  type ReturnReason,
  returnForm,
  returnPayload,
  STOCK_BUCKET,
  withReturn,
} from './return-model';

/**
 * Não conformidade / devolução em rascunho: a recepção de origem, o motivo e a descrição, a solução pedida e, por
 * linha, o que volta ao fornecedor (do aceite, que sai do stock, ou do recusado na conferência). As evidências
 * juntam-se na ficha; a confirmação (saída do inventário) também.
 */
@Component({
  selector: 'app-return-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, ErrorAlert],
  template: `
    <app-entity-form-page
      [title]="ret() ? 'Editar devolução' : 'Nova devolução a fornecedor'"
      subtitle="Não conformidade de uma recepção; nada sai do inventário até confirmar."
      formId="return-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="ret() ? 'Guardar' : 'Registar rascunho'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section
        title="Não conformidade"
        description="De que recepção, porquê e o que se pede."
      >
        <app-field label="Recepção" [required]="true" [error]="action.field('receiptId')">
          <select
            appControl
            class="input"
            name="receipt"
            data-testid="dvf-receipt"
            [disabled]="!!ret()"
            [(ngModel)]="receiptIdValue"
            (ngModelChange)="pickReceipt($event)"
          >
            <option value="">Escolher…</option>
            @for (r of receipts(); track r.id) {
              <option [value]="r.id">
                {{ r.number }} — {{ r.order.number }} · {{ r.supplier.name }}
              </option>
            }
          </select>
        </app-field>
        <app-field label="Data" [error]="action.field('returnDate')">
          <input appControl class="input w-44" type="date" name="date" [(ngModel)]="f.returnDate" />
        </app-field>
        <app-field label="Motivo" [required]="true" [error]="action.field('reasonCode')">
          <select
            appControl
            class="input"
            name="reason"
            data-testid="dvf-reason"
            [(ngModel)]="f.reasonCode"
          >
            <option value="">Escolher…</option>
            @for (r of reasons; track r[0]) {
              <option [value]="r[0]">{{ r[1] }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Solução pedida"
          [required]="true"
          hint="Substituição: a ordem volta a esperar a quantidade. Crédito: deixa de a esperar e o facturado fica por creditar."
          [error]="action.field('remedy')"
        >
          <select
            appControl
            class="input"
            name="remedy"
            data-testid="dvf-remedy"
            [(ngModel)]="f.remedy"
          >
            @for (r of remedies; track r[0]) {
              <option [value]="r[0]">{{ r[1] }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Descrição da não conformidade"
          [required]="true"
          class="sm:col-span-2"
          [error]="action.field('description')"
        >
          <textarea
            appControl
            class="input min-h-20"
            name="description"
            data-testid="dvf-description"
            [(ngModel)]="f.description"
          ></textarea>
        </app-field>
        <app-field label="Guia de transporte / referência" [error]="action.field('carrierRef')">
          <input
            appControl
            class="input"
            name="carrier"
            data-testid="dvf-carrier"
            [(ngModel)]="f.carrierRef"
          />
        </app-field>
        @if (receipt() && !receipt()!.returnable) {
          <p class="text-sm text-danger-text sm:col-span-2">
            Esta recepção não está confirmada: não há nada a devolver.
          </p>
        }
        @if (receipt()?.order?.closed && f.remedy === 'REPLACEMENT') {
          <p class="text-sm text-warning-text sm:col-span-2" data-testid="dvf-closed">
            A ordem está fechada: não espera substituição. Escolha crédito.
          </p>
        }
      </app-form-section>

      @if (receipt()) {
        <app-form-section
          title="O que volta ao fornecedor"
          description="Do aceite (sai do stock) ou do recusado na conferência (só fica registado)."
        >
          <div class="space-y-3 sm:col-span-2">
            @for (l of f.lines; track l.receiptLineId + l.source; let i = $index) {
              <fieldset class="rounded border border-border p-3" [attr.data-testid]="'dvl-' + i">
                <legend class="px-1 text-sm font-medium">
                  {{ l.label }}
                  <span class="text-muted"
                    >· {{ source(l) }} · disponível {{ q(l.left) }} {{ l.uom ?? ''
                    }}{{ l.lotCode ? ' · lote ' + l.lotCode : '' }}</span
                  >
                </legend>
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <app-field label="A devolver" [error]="fieldOf(l, 'quantity')">
                    <input
                      appControl
                      class="input"
                      inputmode="decimal"
                      [name]="'q' + i"
                      data-testid="dvl-qty"
                      [(ngModel)]="l.quantity"
                    />
                  </app-field>
                  @if (l.stocked) {
                    <app-field label="Sai do stock" [error]="fieldOf(l, 'bucket')">
                      <select
                        appControl
                        class="input"
                        [name]="'b' + i"
                        data-testid="dvl-bucket"
                        [(ngModel)]="l.bucket"
                      >
                        @for (b of buckets; track b[0]) {
                          <option [value]="b[0]">{{ b[1] }}</option>
                        }
                      </select>
                    </app-field>
                    @if (receipt()!.locations.length) {
                      <app-field label="Localização" [error]="fieldOf(l, 'locationId')">
                        <select
                          appControl
                          class="input"
                          [name]="'loc' + i"
                          [(ngModel)]="l.locationId"
                        >
                          <option value="">—</option>
                          @for (x of receipt()!.locations; track x.id) {
                            <option [value]="x.id">{{ x.path }}</option>
                          }
                        </select>
                      </app-field>
                    }
                  }
                  <app-field label="Nota" [error]="fieldOf(l, 'notes')">
                    <input appControl class="input" [name]="'n' + i" [(ngModel)]="l.notes" />
                  </app-field>
                  @if (l.serialsTracked) {
                    <app-field
                      label="Números de série devolvidos"
                      [hint]="'Recebidas: ' + l.receivedSerials.join(', ')"
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
                @if (over(l)) {
                  <p class="mt-2 text-sm text-danger-text">Acima do disponível nesta linha.</p>
                }
              </fieldset>
            } @empty {
              <p class="text-sm text-muted">Nada por devolver nesta recepção.</p>
            }
            @if (action.field('lines'); as err) {
              <p class="text-sm text-danger-text">{{ err }}</p>
            }
          </div>
        </app-form-section>
      }
      <app-error-alert [error]="receiptError()" />
    </app-entity-form-page>
  `,
})
export class ReturnForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  readonly receiptId = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly ret = signal<PurchaseReturn | null>(null);
  protected readonly receipt = signal<ReturnableReceipt | null>(null);
  protected readonly receipts = signal<ReceiptRow[]>([]);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly receiptError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly q = qty;
  protected readonly over = overLeft;
  protected readonly reasons = Object.entries(RETURN_REASON) as [ReturnReason, string][];
  protected readonly remedies = Object.entries(REMEDY) as [Remedy, string][];
  protected readonly buckets = Object.entries(STOCK_BUCKET);
  protected readonly source = (l: ReturnLineForm) => RETURN_SOURCE[l.source];
  protected receiptIdValue = '';
  protected f = this.empty();
  private initial = snapshot(this.f);

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      this.receiptId();
      untracked(() => void this.load());
    });
  }

  private empty() {
    return {
      returnDate: new Date().toISOString().slice(0, 10),
      reasonCode: '' as ReturnReason | '',
      description: '',
      remedy: 'CREDIT' as Remedy,
      carrierRef: '',
      lines: [] as ReturnLineForm[],
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  /** Erro do servidor para a linha (o índice é o da lista enviada). */
  protected fieldOf(l: ReturnLineForm, field: string) {
    const sent = returnPayload(this.f.lines);
    const i = sent.findIndex((x) => x.receiptLineId === l.receiptLineId && x.source === l.source);
    return i < 0 ? null : this.action.field(`lines.${i}.${field}`);
  }

  protected async pickReceipt(id: string) {
    this.receiptError.set(null);
    this.receipt.set(null);
    this.f.lines = [];
    if (!id) return;
    try {
      const r = await this.api.get<ReturnableReceipt>(`procurement/returns/receipts/${id}`);
      this.receipt.set(r);
      this.f.lines = returnForm(r);
    } catch (e) {
      this.receiptError.set(ApiError.from(e));
    }
  }

  protected async load() {
    this.loadError.set(null);
    this.loaded.set(false);
    try {
      const id = this.id();
      if (id && id !== 'nova') {
        const r = await this.api.get<PurchaseReturn>(`procurement/returns/${id}`);
        this.ret.set(r);
        this.receiptIdValue = r.receipt.id;
        const rc = await this.api.get<ReturnableReceipt>(
          `procurement/returns/receipts/${r.receipt.id}`,
          { exceptReturnId: r.id },
        );
        this.receipt.set(rc);
        this.receipts.set([
          {
            id: rc.id,
            number: rc.number,
            status: 'CONFIRMED',
            order: { id: rc.order.id, number: rc.order.number },
            supplier: rc.supplier,
            warehouse: null,
            receiptDate: rc.receiptDate,
            deliveryNote: null,
          },
        ]);
        this.f = {
          returnDate: r.returnDate,
          reasonCode: r.reasonCode,
          description: r.description,
          remedy: r.remedy,
          carrierRef: r.carrierRef ?? '',
          lines: withReturn(returnForm(rc), r.lines),
        };
        this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
      } else {
        const page = await this.api
          .get<ReceiptRow[]>('procurement/receipts', { status: 'CONFIRMED', limit: 200 })
          .catch(() => [] as ReceiptRow[]);
        this.receipts.set(page);
        this.f = this.empty();
        this.receiptIdValue = this.receiptId() ?? '';
        if (this.receiptIdValue) await this.pickReceipt(this.receiptIdValue);
        const picked = this.receipt();
        if (picked && !page.some((x) => x.id === picked.id))
          this.receipts.set([
            {
              id: picked.id,
              number: picked.number,
              status: 'CONFIRMED',
              order: { id: picked.order.id, number: picked.order.number },
              supplier: picked.supplier,
              warehouse: null,
              receiptDate: picked.receiptDate,
              deliveryNote: null,
            },
            ...page,
          ]);
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const r = this.ret();
    const body = {
      receiptId: this.receiptIdValue,
      returnDate: this.f.returnDate,
      reasonCode: this.f.reasonCode,
      description: this.f.description,
      remedy: this.f.remedy,
      carrierRef: this.f.carrierRef.trim() || null,
      lines: returnPayload(this.f.lines),
    };
    const saved = await this.action.run(() =>
      r
        ? this.api.put<PurchaseReturn>(`procurement/returns/${r.id}`, {
            ...body,
            expectedVersion: r.version,
          })
        : this.api.post<PurchaseReturn>('procurement/returns', body),
    );
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.toasts.show(
      r ? 'Devolução guardada.' : 'Devolução registada em rascunho. Junte as evidências.',
    );
    await this.router.navigate(['/compras/devolucoes', saved.id], { replaceUrl: !r });
  }

  protected cancel() {
    const r = this.ret();
    void this.router.navigate(r ? ['/compras/devolucoes', r.id] : ['/compras/devolucoes']);
  }
}
