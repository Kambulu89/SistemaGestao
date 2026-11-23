import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { qty } from '../inventory/stock-model';
import {
  CREDIT_KIND,
  CREDIT_NOTE_EVENT,
  CREDIT_NOTE_STATUS,
  type CreditNote,
  creditNoteTone,
} from './credit-note-model';

/**
 * Nota de crédito de fornecedor (9.9): estado, factura (e devolução) de origem, linhas (quantidade devolvida ao preço
 * da factura ou ajuste de valor), totais na moeda da factura e na funcional (câmbio da factura), validar, anular o
 * rascunho, anexos, cronologia e auditoria.
 */
@Component({
  selector: 'app-credit-note-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    AuditHistory,
    Attachments,
  ],
  template: `
    <app-entity-form-page
      [title]="'Nota de crédito ' + (x()?.creditNoteNumber ?? '')"
      [subtitle]="
        x()
          ? x()!.supplier.code +
            ' — ' +
            x()!.supplier.name +
            (x()!.number ? ' · ' + x()!.number : '')
          : ''
      "
      formId="credit-note-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as n) {
        <section class="card space-y-3" aria-label="Estado" data-testid="nc-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(n.status)" data-testid="nc-status">{{
              status(n.status)
            }}</span>
            <span class="text-sm text-muted">
              Factura
              <a class="link" [routerLink]="['/compras/facturas', n.invoice.id]">{{
                n.invoice.number
              }}</a>
              ({{ n.invoice.invoiceNumber }})
              @if (n.return) {
                · devolução
                <a class="link" [routerLink]="['/compras/devolucoes', n.return.id]">{{
                  n.return.number
                }}</a>
              }
              · {{ date(n.creditNoteDate) }}
            </span>
          </div>
          <p class="text-sm">{{ n.reason }}</p>
          <p class="text-sm" data-testid="nc-totals">
            Total {{ money(n.totalAmount, n.currency) }} (declarado
            {{ money(n.declaredTotal, null) }})
            @if (n.totalFunctional && n.exchangeRate !== '1.0000000000') {
              · {{ money(n.totalFunctional, null) }} na moeda funcional ao câmbio da factura
            }
          </p>
          @for (m of messages(n); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (!cancelOpen() && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" data-testid="nc-error" />
          }
          <div class="flex flex-wrap gap-2">
            @if (n.can.edit) {
              <a
                class="btn-secondary"
                data-testid="nc-edit"
                [routerLink]="['/compras/notas-credito', n.id, 'editar']"
                >Editar</a
              >
            }
            @if (n.can.validate) {
              <button
                type="button"
                class="btn-primary"
                data-testid="nc-validate"
                (click)="validate()"
              >
                Validar
              </button>
            }
            @if (n.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="nc-cancel"
                (click)="cancelOpen.set(true)"
              >
                Anular
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="nc-lines-title">
          <h2 id="nc-lines-title" class="mb-2 font-semibold">Linhas</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="nc-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Linha da factura</th>
                  <th class="px-2 py-1">Tipo</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Líquido</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Imposto</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                @for (l of n.lines; track l.id) {
                  <tr class="border-t border-border align-top">
                    <td class="px-2 py-1">
                      {{ l.invoiceLineNo }} · {{ l.description }}
                      @if (l.returnNumber) {
                        <span class="block text-xs text-muted">Devolução {{ l.returnNumber }}</span>
                      }
                    </td>
                    <td class="px-2 py-1">{{ kind(l.kind) }}</td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ l.kind === 'QUANTITY' ? q(l.quantity) + ' ' + (l.uom ?? '') : '—' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ money(l.netAmount, null) }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ money(l.taxAmount, null) }}
                      <span class="block text-xs text-muted">{{ q(l.taxRate) }}%</span>
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ money(l.totalAmount, null) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-right text-sm">
            Líquido {{ money(n.totalNet, null) }} · imposto {{ money(n.totalTax, null) }} · total
            {{ money(n.totalAmount, n.currency) }}
          </p>
        </section>

        <app-attachments
          subjectType="purchase_credit_note"
          [subjectId]="n.id"
          [canWrite]="n.can.edit"
        />

        <section class="card" aria-labelledby="nc-history-title">
          <h2 id="nc-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="nc-history">
            @for (h of n.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ event(h.kind) }}
                @if (h.by) {
                  · {{ h.by }}
                }
                @if (h.reason) {
                  · <em>{{ h.reason }}</em>
                }
              </li>
            }
          </ul>
        </section>

        <app-audit-history
          entityType="purchase_credit_note"
          [entityId]="n.id"
          [refreshKey]="n.version"
        />
      }
    </app-entity-form-page>

    <app-modal title="Anular o rascunho" [open]="cancelOpen()" (closed)="cancelOpen.set(false)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="nc-reason-text"
          [(ngModel)]="reasonText"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="cancelOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="nc-reason-ok"
          [disabled]="act.busy()"
          (click)="cancelDraft()"
        >
          Anular
        </button>
      </div>
    </app-modal>
  `,
})
export class CreditNoteDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<CreditNote | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly cancelOpen = signal(false);
  protected reasonText = '';
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = creditNoteTone;
  protected readonly status = (s: CreditNote['status']) => CREDIT_NOTE_STATUS[s];
  protected readonly kind = (k: 'QUANTITY' | 'PRICE') => CREDIT_KIND[k];
  protected readonly event = (k: string) => CREDIT_NOTE_EVENT[k] ?? k;

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected messages(n: CreditNote) {
    const out: string[] = [];
    if (n.validatedAt)
      out.push(`Validada por ${n.validatedBy ?? '—'} em ${formatDateTime(n.validatedAt)}.`);
    if (n.cancelReason) out.push(`Anulada: ${n.cancelReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<CreditNote>(`procurement/credit-notes/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(n: CreditNote) {
    this.x.set(n);
    this.breadcrumbs.setCurrent(n.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/compras/notas-credito']);
  }

  protected async validate() {
    const n = this.x()!;
    const ok = await this.confirmSvc.ask({
      title: 'Validar a nota de crédito',
      message: `Recebe número e abate ${money(n.totalAmount, n.currency)} à factura ${n.invoice.number}; as quantidades devolvidas deixam de contar como facturadas na ordem ${n.order.number}.`,
      confirmLabel: 'Validar',
    });
    if (!ok) return;
    const res = await this.act.run(() =>
      this.api.post<CreditNote>(`procurement/credit-notes/${n.id}/validate`, {
        expectedVersion: n.version,
      }),
    );
    if (!res) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.set(res);
    this.toasts.show('Nota de crédito validada.');
  }

  protected async cancelDraft() {
    const n = this.x()!;
    const res = await this.act.run(() =>
      this.api.post<CreditNote>(`procurement/credit-notes/${n.id}/cancel`, {
        expectedVersion: n.version,
        reason: this.reasonText,
      }),
    );
    if (!res) return;
    this.set(res);
    this.cancelOpen.set(false);
    this.toasts.show('Rascunho anulado.');
  }
}
