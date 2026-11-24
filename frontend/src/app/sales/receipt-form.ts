import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import {
  METHOD,
  minusAmount,
  type OpenItems,
  PURPOSE,
  type Receipt,
  type ReceiptOptions,
  sumAmounts,
} from './receipt-model';

/**
 * Registar um recebimento: valor, meio, conta e referência, e a afectação às facturas emitidas do cliente (o resto
 * fica como adiantamento), ou o pagamento de uma factura-recibo em rascunho. Fica pendente até a tesouraria
 * confirmar — só então conta.
 */
@Component({
  selector: 'app-receipt-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete],
  template: `
    <app-entity-form-page
      title="Registar recebimento"
      subtitle="Fica por confirmar: só depois da confirmação da tesouraria afecta as facturas."
      formId="receipt-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      saveLabel="Registar"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Recebimento">
        <app-field label="Entidade" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            name="le"
            data-testid="rf-le"
            [(ngModel)]="f.legalEntityId"
            (ngModelChange)="refresh()"
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
            data-testid="rf-customer"
            [inputId]="cf.controlId"
            [describedBy]="cf.describedBy()"
            [search]="searchCustomers"
            [(ngModel)]="f.customerId"
            (ngModelChange)="refresh()"
          />
        </app-field>
        <app-field label="Tipo" [required]="true" [error]="action.field('purpose')">
          <select
            appControl
            class="input"
            name="purpose"
            data-testid="rf-purpose"
            [(ngModel)]="f.purpose"
          >
            @for (p of purposes; track p[0]) {
              <option [value]="p[0]">{{ p[1] }}</option>
            }
          </select>
        </app-field>
        @if (f.purpose === 'INVOICE_RECEIPT') {
          <app-field
            label="Factura-recibo em rascunho"
            [required]="true"
            [error]="action.field('invoiceId')"
          >
            <select
              appControl
              class="input"
              name="fr"
              data-testid="rf-fr"
              [(ngModel)]="f.invoiceId"
              (ngModelChange)="frChosen()"
            >
              <option value="">—</option>
              @for (d of items()?.invoiceReceiptDrafts ?? []; track d.id) {
                <option [value]="d.id">
                  {{ d.invoiceDate }} · {{ money(d.payable, d.currency) }}
                </option>
              }
            </select>
          </app-field>
        }
        <app-field label="Valor" [required]="true" [error]="action.field('amount')">
          <input
            appControl
            class="input w-40"
            inputmode="decimal"
            name="amount"
            data-testid="rf-amount"
            [disabled]="f.purpose === 'INVOICE_RECEIPT'"
            [(ngModel)]="f.amount"
          />
        </app-field>
        <app-field
          label="Data do recebimento"
          [required]="true"
          [error]="action.field('receivedDate')"
        >
          <input appControl class="input" type="date" name="date" [(ngModel)]="f.receivedDate" />
        </app-field>
        <app-field label="Meio" [required]="true" [error]="action.field('method')">
          <select
            appControl
            class="input"
            name="method"
            data-testid="rf-method"
            [(ngModel)]="f.method"
          >
            @for (m of methods; track m[0]) {
              <option [value]="m[0]">{{ m[1] }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Conta bancária"
          [required]="f.method === 'TRANSFER'"
          [error]="action.field('bankAccountId')"
        >
          <select
            appControl
            class="input"
            name="bank"
            data-testid="rf-bank"
            [(ngModel)]="f.bankAccountId"
          >
            <option value="">—</option>
            @for (b of banks(); track b.id) {
              <option [value]="b.id">{{ b.label }} ({{ b.currency }})</option>
            }
          </select>
        </app-field>
        <app-field
          label="Referência"
          [required]="['TRANSFER', 'CARD', 'CHEQUE'].includes(f.method)"
          [error]="action.field('reference')"
        >
          <input
            appControl
            class="input"
            name="ref"
            data-testid="rf-ref"
            [(ngModel)]="f.reference"
          />
        </app-field>
      </app-form-section>

      @if (f.purpose === 'RECEIPT') {
        <section class="card space-y-3" aria-labelledby="rf-alloc">
          <h2 id="rf-alloc" class="font-semibold">Afectação às facturas</h2>
          @if (action.field('allocations'); as e) {
            <p class="field-error">{{ e }}</p>
          }
          @for (i of items()?.invoices ?? []; track i.id; let n = $index) {
            <app-field
              [label]="
                i.number + ' · vence ' + i.dueDate + ' · por receber ' + money(i.open, i.currency)
              "
              [error]="allocError(i.id)"
            >
              <div class="flex flex-wrap items-center gap-2">
                <input
                  appControl
                  class="input w-40"
                  inputmode="decimal"
                  [name]="'a' + n"
                  [attr.data-testid]="'rf-alloc-' + i.number"
                  [(ngModel)]="alloc[i.id]"
                />
                <button type="button" class="link text-sm" (click)="alloc[i.id] = i.open">
                  Tudo
                </button>
              </div>
            </app-field>
          } @empty {
            <p class="text-sm text-muted">
              Sem facturas por receber deste cliente nesta entidade: o valor fica como adiantamento.
            </p>
          }
          <p class="text-sm" data-testid="rf-advance">
            Afectado: {{ money(allocated()) }} · Fica como adiantamento: {{ money(advance()) }}
          </p>
        </section>
      }
    </app-entity-form-page>
  `,
})
export class ReceiptFormPage implements HasUnsavedChanges {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  protected readonly opts = signal<ReceiptOptions | null>(null);
  protected readonly items = signal<OpenItems | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly money = money;
  protected readonly methods = Object.entries(METHOD);
  protected readonly purposes = Object.entries(PURPOSE);
  private readonly le = signal('');
  protected readonly banks = computed(() =>
    (this.opts()?.bankAccounts ?? []).filter((b) => b.legalEntityId === this.le()),
  );
  private readonly key = `ui-${crypto.randomUUID()}`;
  protected f = {
    legalEntityId: '',
    customerId: '',
    purpose: 'RECEIPT' as 'RECEIPT' | 'INVOICE_RECEIPT',
    invoiceId: '',
    amount: '',
    receivedDate: new Date().toISOString().slice(0, 10),
    method: 'TRANSFER',
    bankAccountId: '',
    reference: '',
  };
  protected alloc: Record<string, string> = {};
  private initial = snapshot(this.f);
  protected allocated() {
    return sumAmounts(Object.values(this.alloc));
  }
  protected advance() {
    return minusAmount(this.f.amount || '0', this.allocated());
  }

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string }[]>(
        'sales/receipts/search/customers',
        { q },
      )
    ).map((c) => ({
      id: c.id,
      label: `${c.code} — ${c.name}`,
    }));

  constructor() {
    warnOnUnload(this);
    void this.load();
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const o = await this.api.get<ReceiptOptions>('sales/receipts/options');
      this.opts.set(o);
      if (o.legalEntities.length === 1) this.f.legalEntityId = o.legalEntities[0].id;
      const q = this.route.snapshot.queryParamMap;
      if (q.get('purpose') === 'INVOICE_RECEIPT') this.f.purpose = 'INVOICE_RECEIPT';
      this.le.set(this.f.legalEntityId);
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async refresh() {
    this.le.set(this.f.legalEntityId);
    this.items.set(null);
    this.alloc = {};
    if (!this.f.legalEntityId || !this.f.customerId) return;
    this.items.set(
      await this.api
        .get<OpenItems>(`sales/receipts/open-items/${this.f.legalEntityId}/${this.f.customerId}`)
        .catch(() => null),
    );
  }

  protected frChosen() {
    const d = this.items()?.invoiceReceiptDrafts.find((x) => x.id === this.f.invoiceId);
    this.f.amount = d ? d.payable : '';
  }

  protected allocError(invoiceId: string) {
    const list = this.items()?.invoices ?? [];
    const n = Object.keys(this.alloc)
      .filter((k) => this.alloc[k]?.trim())
      .indexOf(invoiceId);
    return n >= 0 && list.length ? this.action.field(`allocations.${n}.amount`) : null;
  }

  protected async save() {
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    const f = this.f;
    const r = await this.action.run(() =>
      this.api.post<Receipt>('sales/receipts', {
        requestKey: this.key,
        legalEntityId: f.legalEntityId,
        customerId: f.customerId,
        purpose: f.purpose,
        invoiceId: f.purpose === 'INVOICE_RECEIPT' ? f.invoiceId : null,
        amount: f.amount.trim().replace(',', '.'),
        receivedDate: f.receivedDate,
        method: f.method,
        bankAccountId: nz(f.bankAccountId),
        reference: nz(f.reference),
        allocations:
          f.purpose === 'RECEIPT'
            ? Object.entries(this.alloc)
                .filter(([, v]) => v?.trim() && !/^0+([.,]0*)?$/.test(v.trim()))
                .map(([invoiceId, v]) => ({ invoiceId, amount: v.trim().replace(',', '.') }))
            : [],
      }),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show('Recebimento registado: falta a confirmação da tesouraria.');
    await this.router.navigate(['/vendas/recebimentos', r.id], { replaceUrl: true });
  }

  protected cancel() {
    void this.router.navigate(['/vendas/recebimentos']);
  }
}
