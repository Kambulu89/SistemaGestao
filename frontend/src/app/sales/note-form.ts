import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
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
import { ratePct } from './fiscal-model';
import { price, qty } from './pricing-model';
import {
  amountOrNull,
  type Eligible,
  type Note,
  NOTE_KIND,
  NOTE_REASON,
  NOTE_REASONS,
} from './note-model';

interface LineForm {
  invoiceLineId: string;
  mode: 'QUANTITY' | 'VALUE';
  quantity: string;
  amount: string;
}

/**
 * Preparar uma nota de crédito ou débito sobre uma factura emitida: motivo, data, devolução física ligada (crédito) e,
 * por linha da factura, a quantidade ou o valor a corrigir dentro do que resta. Os impostos são os da linha original.
 */
@Component({
  selector: 'app-note-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete],
  template: `
    <app-entity-form-page
      [title]="
        isNew() ? 'Nova ' + kindLabel().toLowerCase() : 'Editar ' + kindLabel().toLowerCase()
      "
      subtitle="Corrige uma factura emitida sem a alterar. Fica em rascunho até ser emitida."
      formId="note-form"
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
      <app-form-section title="Documento">
        @if (isNew()) {
          <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
            <select
              appControl
              class="input"
              name="kind"
              data-testid="nf-kind"
              [(ngModel)]="f.kind"
              (ngModelChange)="kindChanged()"
            >
              <option value="CREDIT">Nota de crédito</option>
              <option value="DEBIT">Nota de débito</option>
            </select>
          </app-field>
          @if (!fixedInvoice) {
            <app-field
              #inf
              label="Factura original"
              [required]="true"
              [error]="action.field('invoiceId')"
            >
              <app-autocomplete
                name="invoice"
                data-testid="nf-invoice"
                [inputId]="inf.controlId"
                [describedBy]="inf.describedBy()"
                [search]="searchInvoices"
                [initialLabel]="el()?.invoice?.number ?? null"
                [(ngModel)]="f.invoiceId"
                (ngModelChange)="loadEligible()"
              />
            </app-field>
          } @else {
            <p class="text-sm" data-testid="nf-invoice-fixed">
              Factura original: <strong>{{ el()?.invoice?.number }}</strong>
            </p>
          }
        } @else {
          <p class="text-sm">
            Factura original: <strong>{{ el()?.invoice?.number }}</strong>
          </p>
        }
        <app-field label="Motivo" [required]="true" [error]="action.field('reasonCode')">
          <select
            appControl
            class="input"
            name="reasonCode"
            data-testid="nf-reason-code"
            [(ngModel)]="f.reasonCode"
          >
            <option value="">—</option>
            @for (r of reasons(); track r) {
              <option [value]="r">{{ reasonLabel(r) }}</option>
            }
          </select>
        </app-field>
        <app-field label="Descrição do motivo" [required]="true" [error]="action.field('reason')">
          <textarea
            appControl
            class="input min-h-16"
            name="reason"
            data-testid="nf-reason"
            [(ngModel)]="f.reason"
          ></textarea>
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('noteDate')">
          <input appControl class="input" type="date" name="date" [(ngModel)]="f.noteDate" />
        </app-field>
        @if (f.kind === 'CREDIT' && (el()?.returns ?? []).length) {
          <app-field
            label="Devolução física ligada"
            hint="Opcional: o crédito por quantidade não passa o que voltou nessa devolução."
            [error]="action.field('returnId')"
          >
            <select
              appControl
              class="input"
              name="ret"
              data-testid="nf-return"
              [(ngModel)]="f.returnId"
            >
              <option value="">— Sem devolução (só correcção de valor)</option>
              @for (r of el()!.returns; track r.id) {
                <option [value]="r.id">{{ r.reference }} · {{ r.date }}</option>
              }
            </select>
          </app-field>
        }
      </app-form-section>

      @if (el(); as e) {
        <section class="card space-y-3" aria-labelledby="nf-lines">
          <h2 id="nf-lines" class="font-semibold">Linhas a corrigir</h2>
          <p class="text-sm text-muted">
            {{
              f.kind === 'CREDIT'
                ? 'Credite por quantidade (devolução, quebra) ou por valor (preço, desconto), até ao que resta.'
                : 'O débito é sempre por valor líquido; o imposto é o da linha original.'
            }}
          </p>
          @if (action.field('lines'); as err) {
            <p class="field-error">{{ err }}</p>
          }
          @for (l of e.lines; track l.id; let i = $index) {
            <div
              class="space-y-2 border-b border-border pb-3"
              [attr.data-testid]="'nf-line-' + l.lineNo"
            >
              <p class="text-sm">
                <strong>{{ l.lineNo }}. {{ l.sku }}</strong> — {{ l.description }} ·
                {{ qty(l.quantity) }} {{ l.uom }} × {{ price(l.netUnitPrice) }} =
                {{ money(l.netAmount, e.invoice.currency) }}
                @for (t of l.taxes; track $index) {
                  · {{ t.code }} {{ rate(t.rate) }}
                }
              </p>
              @if (f.kind === 'CREDIT') {
                <p class="text-sm text-muted">
                  Resta creditar: {{ qty(l.remainingQty) }} {{ l.uom }} ·
                  {{ money(l.remainingNet, e.invoice.currency) }}
                </p>
              }
              <div class="flex flex-wrap items-end gap-3">
                @if (f.kind === 'CREDIT') {
                  <app-field label="Correcção" [error]="action.field(linePath(l.id, 'mode'))">
                    <select
                      appControl
                      class="input"
                      [name]="'m' + i"
                      [attr.data-testid]="'nf-mode-' + l.lineNo"
                      [(ngModel)]="lines[l.id].mode"
                    >
                      <option value="QUANTITY">Por quantidade</option>
                      <option value="VALUE">Por valor</option>
                    </select>
                  </app-field>
                }
                @if (f.kind === 'CREDIT' && lines[l.id].mode === 'QUANTITY') {
                  <app-field label="Quantidade" [error]="action.field(linePath(l.id, 'quantity'))">
                    <input
                      appControl
                      class="input w-32"
                      inputmode="decimal"
                      [name]="'q' + i"
                      [attr.data-testid]="'nf-qty-' + l.lineNo"
                      [(ngModel)]="lines[l.id].quantity"
                    />
                  </app-field>
                } @else {
                  <app-field label="Valor líquido" [error]="action.field(linePath(l.id, 'amount'))">
                    <input
                      appControl
                      class="input w-36"
                      inputmode="decimal"
                      [name]="'a' + i"
                      [attr.data-testid]="'nf-amount-' + l.lineNo"
                      [(ngModel)]="lines[l.id].amount"
                    />
                  </app-field>
                }
              </div>
            </div>
          }
          <p class="text-sm text-muted">
            Em dívida na factura: {{ money(e.invoice.openTotal, e.invoice.currency) }}. Um crédito
            acima disso fica como crédito do cliente (para outra factura ou reembolso).
          </p>
        </section>
      }
    </app-entity-form-page>
  `,
})
export class NoteFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly el = signal<Eligible | null>(null);
  protected readonly note = signal<Note | null>(null);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly money = money;
  protected readonly qty = qty;
  protected readonly price = price;
  protected readonly rate = ratePct;
  protected readonly reasonLabel = (r: string) => NOTE_REASON[r] ?? r;
  protected f = {
    kind: 'CREDIT' as 'CREDIT' | 'DEBIT',
    invoiceId: '',
    reasonCode: '',
    reason: '',
    noteDate: new Date().toISOString().slice(0, 10),
    returnId: '',
  };
  protected lines: Record<string, LineForm> = {};
  /** Ordem dos pedidos enviados (para mostrar o erro de `lines.N` na linha certa). */
  private sent: string[] = [];
  private initial = '';
  /** A factura veio da ficha da factura: não se muda aqui. */
  protected fixedInvoice = false;
  protected readonly kindSig = signal<'CREDIT' | 'DEBIT'>('CREDIT');
  protected readonly reasons = computed(() => NOTE_REASONS[this.kindSig()]);
  protected readonly kindLabel = computed(() => NOTE_KIND[this.kindSig()]);

  protected readonly searchInvoices = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string }[]>(
        'sales/notes/search/invoices',
        { q },
      )
    ).map((x) => ({ id: x.id, label: x.code, hint: x.name }));

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.state() !== this.initial;
  }
  private state() {
    return snapshot({ f: this.f, l: this.lines });
  }

  protected async load() {
    this.loadError.set(null);
    this.loaded.set(false);
    try {
      if (this.isNew()) {
        const q = this.route.snapshot.queryParamMap;
        if (q.get('kind') === 'DEBIT') this.f.kind = 'DEBIT';
        this.kindSig.set(this.f.kind);
        this.f.invoiceId = q.get('invoiceId') ?? '';
        this.fixedInvoice = !!this.f.invoiceId;
        if (this.f.invoiceId) await this.loadEligible();
      } else {
        const n = await this.api.get<Note>(`sales/notes/${this.id()}`);
        this.note.set(n);
        this.f = {
          kind: n.kind,
          invoiceId: n.invoice.id,
          reasonCode: n.reasonCode,
          reason: n.reason,
          noteDate: n.noteDate,
          returnId: n.returnDoc?.id ?? '',
        };
        this.kindSig.set(n.kind);
        await this.loadEligible();
        for (const l of n.lines)
          this.lines[l.invoiceLineId] = {
            invoiceLineId: l.invoiceLineId,
            mode: l.mode,
            quantity: l.quantity ? qty(l.quantity).replace(',', '.') : '',
            amount: l.mode === 'VALUE' ? l.netAmount : '',
          };
      }
      this.initial = this.state();
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected kindChanged() {
    this.kindSig.set(this.f.kind);
    if (!NOTE_REASONS[this.f.kind].includes(this.f.reasonCode)) this.f.reasonCode = '';
    if (this.f.kind === 'DEBIT') {
      this.f.returnId = '';
      for (const l of Object.values(this.lines)) l.mode = 'VALUE';
    }
  }

  protected async loadEligible() {
    this.el.set(null);
    this.lines = {};
    if (!this.f.invoiceId) return;
    const e = await this.api.get<Eligible>(`sales/notes/eligible/${this.f.invoiceId}`);
    for (const l of e.lines)
      this.lines[l.id] = {
        invoiceLineId: l.id,
        mode: this.f.kind === 'CREDIT' ? 'QUANTITY' : 'VALUE',
        quantity: '',
        amount: '',
      };
    this.el.set(e);
  }

  protected linePath(lineId: string, field: string) {
    const n = this.sent.indexOf(lineId);
    return n >= 0 ? `lines.${n}.${field}` : `__none.${field}`;
  }

  private payloadLines() {
    const out: Record<string, unknown>[] = [];
    this.sent = [];
    for (const l of this.el()?.lines ?? []) {
      const x = this.lines[l.id];
      const mode = this.f.kind === 'DEBIT' ? 'VALUE' : x.mode;
      const v = amountOrNull(mode === 'QUANTITY' ? x.quantity : x.amount);
      if (!v) continue;
      this.sent.push(l.id);
      out.push(
        mode === 'QUANTITY'
          ? { invoiceLineId: l.id, mode, quantity: v }
          : { invoiceLineId: l.id, mode, amount: v },
      );
    }
    return out;
  }

  protected async save() {
    const f = this.f;
    const lines = this.payloadLines();
    const body = {
      reasonCode: f.reasonCode,
      reason: f.reason,
      noteDate: f.noteDate,
      returnId: f.kind === 'CREDIT' && f.returnId ? f.returnId : null,
      lines,
    };
    const r = await this.action.run(() =>
      this.isNew()
        ? this.api.post<Note>('sales/notes', { ...body, kind: f.kind, invoiceId: f.invoiceId })
        : this.api.patch<Note>(`sales/notes/${this.id()}`, {
            ...body,
            expectedVersion: this.note()!.version,
          }),
    );
    if (!r) return;
    this.initial = this.state();
    this.toasts.show(this.isNew() ? 'Rascunho criado: falta emitir.' : 'Rascunho guardado.');
    await this.router.navigate(['/vendas/notas', r.id], { replaceUrl: true });
  }

  protected cancel() {
    if (this.note()) void this.router.navigate(['/vendas/notas', this.note()!.id]);
    else if (this.f.invoiceId) void this.router.navigate(['/vendas/facturas', this.f.invoiceId]);
    else void this.router.navigate(['/vendas/notas']);
  }
}
