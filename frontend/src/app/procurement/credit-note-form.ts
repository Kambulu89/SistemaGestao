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
import { money } from '../inventory/valuation-model';
import { qty } from '../inventory/stock-model';
import { declaredDifference } from './invoice-model';
import { plain } from './rfq-model';
import {
  type CreditableInvoice,
  type CreditLineForm,
  type CreditNote,
  creditForm,
  creditPayload,
  creditTotal,
} from './credit-note-model';

/**
 * Nota de crédito do fornecedor em rascunho, sobre uma factura validada: número e data do fornecedor, motivo, total
 * declarado e, por linha da factura, a quantidade devolvida (ao preço da factura; ligada à devolução escolhida) e/ou
 * um ajuste de valor. A validação faz-se na ficha.
 */
@Component({
  selector: 'app-credit-note-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, ErrorAlert],
  template: `
    <app-entity-form-page
      [title]="note() ? 'Editar nota de crédito' : 'Nova nota de crédito'"
      [subtitle]="
        inv()
          ? 'Factura ' +
            (inv()!.number ?? '') +
            ' (' +
            inv()!.invoiceNumber +
            ') · ' +
            inv()!.supplier.name
          : ''
      "
      formId="credit-note-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="note() ? 'Guardar' : 'Registar rascunho'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      @if (inv(); as i) {
        <app-form-section
          title="Documento do fornecedor"
          description="Como vem na nota de crédito."
        >
          <app-field
            label="Número da nota"
            [required]="true"
            [error]="action.field('creditNoteNumber')"
          >
            <input
              appControl
              class="input"
              name="number"
              data-testid="ncf-number"
              [(ngModel)]="f.creditNoteNumber"
            />
          </app-field>
          <app-field label="Data" [error]="action.field('creditNoteDate')">
            <input
              appControl
              class="input w-44"
              type="date"
              name="date"
              [(ngModel)]="f.creditNoteDate"
            />
          </app-field>
          <app-field
            label="Devolução"
            hint="Liga a quantidade ao crédito pendente da devolução."
            [error]="action.field('returnId')"
          >
            <select
              appControl
              class="input"
              name="return"
              data-testid="ncf-return"
              [(ngModel)]="f.returnId"
              (ngModelChange)="pickReturn($event)"
            >
              <option value="">Nenhuma</option>
              @for (r of returns(); track r.id) {
                <option [value]="r.id">{{ r.number }}</option>
              }
            </select>
          </app-field>
          <app-field
            label="Total declarado ({{ i.currency }})"
            [required]="true"
            [error]="action.field('declaredTotal')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              name="declared"
              data-testid="ncf-declared"
              [(ngModel)]="f.declaredTotal"
            />
          </app-field>
          <app-field
            label="Motivo"
            [required]="true"
            class="sm:col-span-2"
            [error]="action.field('reason')"
          >
            <input
              appControl
              class="input"
              name="reason"
              data-testid="ncf-reason"
              [(ngModel)]="f.reason"
            />
          </app-field>
        </app-form-section>

        <app-form-section
          title="O que se credita"
          description="Quantidade devolvida ao preço da factura e/ou ajuste de valor (líquido), por linha."
        >
          <div class="overflow-x-auto sm:col-span-2">
            <table class="w-full text-sm" data-testid="ncf-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Linha da factura</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Por creditar</th>
                  <th class="px-2 py-1">Quantidade</th>
                  <th class="px-2 py-1">Ajuste de valor</th>
                </tr>
              </thead>
              <tbody>
                @for (l of f.lines; track l.invoiceLineId; let k = $index) {
                  <tr class="border-t border-border align-top" [attr.data-testid]="'ncl-' + k">
                    <td class="px-2 py-1">{{ l.label }}</td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ l.quantityAllowed ? q(l.quantityLeft) + ' ' + (l.uom ?? '') + ' · ' : ''
                      }}{{ money(l.netLeft, null) }}
                    </td>
                    <td class="px-2 py-1">
                      @if (l.quantityAllowed) {
                        <input
                          class="input w-28"
                          inputmode="decimal"
                          [name]="'q' + k"
                          data-testid="ncl-qty"
                          [attr.aria-label]="'Quantidade a creditar, linha ' + l.label"
                          [(ngModel)]="l.quantity"
                        />
                      } @else {
                        <span class="text-muted">—</span>
                      }
                      @if (fieldOf(l, 'QUANTITY', 'quantity'); as err) {
                        <span class="block text-xs text-danger-text">{{ err }}</span>
                      }
                    </td>
                    <td class="px-2 py-1">
                      <input
                        class="input w-32"
                        inputmode="decimal"
                        [name]="'a' + k"
                        data-testid="ncl-amount"
                        [attr.aria-label]="'Ajuste de valor, linha ' + l.label"
                        [(ngModel)]="l.amount"
                      />
                      @if (fieldOf(l, 'PRICE', 'netAmount'); as err) {
                        <span class="block text-xs text-danger-text">{{ err }}</span>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="4" class="px-2 py-2 text-muted">
                      Esta factura já está toda creditada.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            @if (action.field('lines'); as err) {
              <p class="text-sm text-danger-text">{{ err }}</p>
            }
            <p class="mt-2 text-right text-sm" data-testid="ncf-total">
              Calculado {{ total() === null ? '—' : money(total()!, i.currency) }}
              @if (difference(); as d) {
                · diferença para o declarado {{ money(d, null) }}
              }
            </p>
          </div>
        </app-form-section>
      }
      <app-error-alert [error]="invError()" />
    </app-entity-form-page>
  `,
})
export class CreditNoteForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  readonly invoiceId = input<string | null>(null);
  readonly returnId = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly note = signal<CreditNote | null>(null);
  protected readonly inv = signal<CreditableInvoice | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly invError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly money = money;
  protected readonly q = qty;
  protected f = this.empty();
  private initial = snapshot(this.f);

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      this.invoiceId();
      this.returnId();
      untracked(() => void this.load());
    });
  }

  private empty() {
    return {
      creditNoteNumber: '',
      creditNoteDate: new Date().toISOString().slice(0, 10),
      returnId: '',
      declaredTotal: '',
      reason: '',
      lines: [] as CreditLineForm[],
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  /** Devoluções da ordem com crédito pendente. */
  protected returns() {
    const seen = new Map<string, { id: string; number: string }>();
    for (const p of this.inv()?.pendingReturns ?? [])
      if (!seen.has(p.returnId)) seen.set(p.returnId, { id: p.returnId, number: p.returnNumber });
    const n = this.note();
    if (n?.return && !seen.has(n.return.id)) seen.set(n.return.id, n.return);
    return [...seen.values()];
  }

  protected total() {
    const i = this.inv();
    return i ? creditTotal(this.f.lines, i) : null;
  }
  protected difference() {
    const d = declaredDifference(this.f.declaredTotal, this.total());
    return d === null || /^-?0\.00$/.test(d) ? null : d;
  }

  /** Erro do servidor para a linha e o tipo (o índice é o da lista enviada). */
  protected fieldOf(l: CreditLineForm, kind: 'QUANTITY' | 'PRICE', field: string) {
    const i = this.inv();
    if (!i) return null;
    const sent = creditPayload(this.f.lines, i, this.f.returnId || null);
    const k = sent.findIndex((x) => x.invoiceLineId === l.invoiceLineId && x.kind === kind);
    if (k < 0) return null;
    return (
      this.action.field(`lines.${k}.${field}`) ??
      this.action.field(`lines.${k}.returnLineId`) ??
      this.action.field(`lines.${k}.kind`)
    );
  }

  /** Ao escolher a devolução, a quantidade pendente preenche as linhas vazias. */
  protected pickReturn(id: string) {
    const i = this.inv();
    if (!i) return;
    const filled = creditForm(i, id || null);
    this.f.lines = this.f.lines.map((l) => {
      const x = filled.find((y) => y.invoiceLineId === l.invoiceLineId);
      return x && !l.quantity.trim() ? { ...l, quantity: x.quantity } : l;
    });
  }

  protected async load() {
    this.loadError.set(null);
    this.invError.set(null);
    this.loaded.set(false);
    try {
      const id = this.id();
      if (id && id !== 'nova') {
        const n = await this.api.get<CreditNote>(`procurement/credit-notes/${id}`);
        this.note.set(n);
        const i = await this.api.get<CreditableInvoice>(
          `procurement/credit-notes/invoices/${n.invoice.id}`,
          { exceptNoteId: n.id },
        );
        this.inv.set(i);
        const base = creditForm(i, null);
        this.f = {
          creditNoteNumber: n.creditNoteNumber,
          creditNoteDate: n.creditNoteDate,
          returnId: n.return?.id ?? '',
          declaredTotal: plain(n.declaredTotal),
          reason: n.reason,
          lines: base.map((l) => {
            const qx = n.lines.find(
              (x) => x.invoiceLineId === l.invoiceLineId && x.kind === 'QUANTITY',
            );
            const px = n.lines.find(
              (x) => x.invoiceLineId === l.invoiceLineId && x.kind === 'PRICE',
            );
            return {
              ...l,
              quantity: qx ? plain(qx.quantity) : '',
              amount: px ? plain(px.netAmount) : '',
            };
          }),
        };
        this.breadcrumbs.setCurrent(n.number ?? 'Rascunho');
      } else {
        const invoiceId = this.invoiceId();
        this.f = this.empty();
        if (!invoiceId) {
          this.invError.set(
            new ApiError(
              400,
              'NO_INVOICE',
              'Registe a nota de crédito a partir de uma factura validada (ou da devolução).',
            ),
          );
        } else {
          const i = await this.api.get<CreditableInvoice>(
            `procurement/credit-notes/invoices/${invoiceId}`,
          );
          this.inv.set(i);
          const rid = this.returnId() ?? '';
          this.f.returnId = i.pendingReturns.some((p) => p.returnId === rid) ? rid : '';
          this.f.lines = creditForm(i, this.f.returnId || null);
          if (!i.creditable)
            this.invError.set(
              new ApiError(409, 'NOT_CREDITABLE', 'Só se credita uma factura validada.'),
            );
        }
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const n = this.note();
    const i = this.inv();
    if (!i) return;
    const body = {
      invoiceId: i.id,
      returnId: this.f.returnId || null,
      creditNoteNumber: this.f.creditNoteNumber,
      creditNoteDate: this.f.creditNoteDate,
      reason: this.f.reason,
      declaredTotal: this.f.declaredTotal.trim().replace(',', '.'),
      lines: creditPayload(this.f.lines, i, this.f.returnId || null),
    };
    const saved = await this.action.run(() =>
      n
        ? this.api.put<CreditNote>(`procurement/credit-notes/${n.id}`, {
            ...body,
            expectedVersion: n.version,
          })
        : this.api.post<CreditNote>('procurement/credit-notes', body),
    );
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.toasts.show(n ? 'Nota de crédito guardada.' : 'Nota de crédito registada em rascunho.');
    await this.router.navigate(['/compras/notas-credito', saved.id], { replaceUrl: !n });
  }

  protected cancel() {
    const n = this.note();
    const i = this.inv();
    void this.router.navigate(
      n
        ? ['/compras/notas-credito', n.id]
        : i
          ? ['/compras/facturas', i.id]
          : ['/compras/notas-credito'],
    );
  }
}
