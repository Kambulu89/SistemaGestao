import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
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
import { CREDIT_NOTE_STATUS } from './credit-note-model';
import {
  DIVERGENCE,
  type DivergenceCode,
  type Invoice,
  INVOICE_EVENT,
  INVOICE_STATUS,
  invoiceTone,
} from './invoice-model';

type ReasonKind = 'approve' | 'reject' | 'refuse' | 'cancel';

/**
 * Factura de fornecedor (9.8): estado, conferência a três por linha (encomendado, recebido, já facturado, preço e
 * imposto da ordem, divergências), total declarado contra a soma, excepções e quem as decidiu, validar, autorizar ou
 * recusar a excepção (outra pessoa, com motivo), devolver ao fornecedor, anular, anexos, cronologia e auditoria.
 */
@Component({
  selector: 'app-invoice-detail',
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
      [title]="'Factura ' + (x()?.invoiceNumber ?? '')"
      [subtitle]="
        x()
          ? x()!.supplier.code +
            ' — ' +
            x()!.supplier.name +
            (x()!.number ? ' · ' + x()!.number : '')
          : ''
      "
      formId="invoice-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as v) {
        <section class="card space-y-3" aria-label="Estado" data-testid="id-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(v.status)" data-testid="id-status">{{
              label(v.status)
            }}</span>
            <span class="text-sm text-muted">
              Ordem
              <a class="link" [routerLink]="['/compras/ordens', v.order.id]">{{
                v.order.number
              }}</a>
              · {{ date(v.invoiceDate) }} · vence {{ date(v.dueDate) }}
            </span>
          </div>
          <p class="text-sm" data-testid="id-total">
            Total {{ money(v.totalAmount, v.currency) }} (declarado
            {{ money(v.declaredTotal, null) }})
            @if (v.totalFunctional && v.exchangeRate !== '1.0000000000') {
              · {{ money(v.totalFunctional, null) }} em moeda funcional (câmbio
              {{ q(v.exchangeRate) }})
            }
          </p>
          @if (v.divergences.length) {
            <div class="rounded border border-border p-2" data-testid="id-divergences">
              <p class="mb-1 text-sm font-medium">Divergências da conferência</p>
              <ul class="space-y-1 text-sm">
                @for (d of v.divergences; track $index) {
                  <li>
                    <span class="badge bg-warning-soft text-warning-text">{{
                      divergence(d.code)
                    }}</span>
                    {{ d.message }}
                  </li>
                }
              </ul>
            </div>
          }
          @for (m of messages(v); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (v.can.decideBlockedBy) {
            <p class="text-sm text-warning-text" data-testid="id-blocked">
              Pediu esta validação: a excepção é decidida por outra pessoa.
            </p>
          }
          @if (kind() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (v.can.edit) {
              <a
                class="btn-secondary"
                data-testid="id-edit"
                [routerLink]="['/compras/facturas', v.id, 'editar']"
                >Editar</a
              >
            }
            @if (v.can.validate) {
              <button
                type="button"
                class="btn-primary"
                data-testid="id-validate"
                (click)="validate()"
              >
                Validar (conferir)
              </button>
            }
            @if (v.can.decide) {
              <button
                type="button"
                class="btn-primary"
                data-testid="id-approve"
                (click)="ask('approve')"
              >
                Autorizar excepção
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="id-reject"
                (click)="ask('reject')"
              >
                Recusar excepção
              </button>
            }
            @if (v.can.refuse) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="id-refuse"
                (click)="ask('refuse')"
              >
                Devolver ao fornecedor
              </button>
            }
            @if (v.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="id-cancel"
                (click)="ask('cancel')"
              >
                Anular
              </button>
            }
            @if (v.can.credit) {
              <a
                class="btn-secondary"
                data-testid="id-credit-new"
                routerLink="/compras/notas-credito/nova"
                [queryParams]="{ invoiceId: v.id }"
                >Registar nota de crédito</a
              >
            }
          </div>
        </section>

        <section class="card" aria-labelledby="id-lines-title">
          <h2 id="id-lines-title" class="mb-2 font-semibold">Conferência a três</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="id-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Linha</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Encomendado</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Recebido</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Já facturado</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Facturado</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Preço</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Total</th>
                  <th class="px-2 py-1">Conferência</th>
                </tr>
              </thead>
              <tbody>
                @for (l of v.lines; track l.id) {
                  <tr class="border-t border-border align-top">
                    <td class="px-2 py-1">
                      {{ l.orderLineNo ? l.orderLineNo + ' · ' : 'Encargo · ' }}{{ l.description }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ l.match?.ordered ? q(l.match!.ordered) : '—' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ l.match?.received ? q(l.match!.received) : '—' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ l.match?.invoicedBefore ? q(l.match!.invoicedBefore) : '—' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.quantity) }} {{ l.uom ?? '' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.unitPrice)
                      }}{{ l.discountRate !== '0.000' ? ' −' + q(l.discountRate) + '%' : '' }}
                      <span class="block text-xs text-muted">imposto {{ q(l.taxRate) }}%</span>
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ money(l.totalAmount, null) }}
                    </td>
                    <td class="px-2 py-1" data-testid="id-match">
                      @if (!l.match) {
                        <span class="text-muted">Por conferir</span>
                      } @else if (l.match.codes.length === 0) {
                        <span class="badge bg-success-soft text-success-text">Conforme</span>
                      } @else {
                        @for (c of l.match.codes; track c) {
                          <span class="badge bg-warning-soft text-warning-text">{{
                            divergence(c)
                          }}</span>
                        }
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-right text-sm">
            Líquido {{ money(v.totalNet, null) }} · imposto {{ money(v.totalTax, null) }} · total
            {{ money(v.totalAmount, v.currency) }}
          </p>
        </section>

        @if (v.creditNotes.length) {
          <section class="card" aria-labelledby="id-cn-title" data-testid="id-credits">
            <h2 id="id-cn-title" class="mb-2 font-semibold">Notas de crédito</h2>
            <ul class="space-y-1 text-sm">
              @for (c of v.creditNotes; track c.id) {
                <li>
                  <a class="link" [routerLink]="['/compras/notas-credito', c.id]">{{
                    c.number ?? 'Rascunho'
                  }}</a>
                  · {{ c.creditNoteNumber }} · {{ date(c.creditNoteDate) }} ·
                  {{ money(c.totalAmount, v.currency) }} · {{ creditStatus(c.status) }}
                </li>
              }
            </ul>
            <p class="mt-2 text-sm" data-testid="id-balance">
              Creditado {{ money(v.creditedTotal, v.currency) }} · saldo da factura
              {{ money(v.balance, v.currency) }}
            </p>
          </section>
        }

        @if (v.exceptions.length) {
          <section class="card" aria-labelledby="id-ex-title">
            <h2 id="id-ex-title" class="mb-2 font-semibold">Excepções</h2>
            <ul class="space-y-1 text-sm" data-testid="id-exceptions">
              @for (e of v.exceptions; track $index) {
                <li>
                  <span
                    class="badge"
                    [class]="
                      e.decision === 'APPROVE'
                        ? 'bg-success-soft text-success-text'
                        : 'bg-danger-soft text-danger-text'
                    "
                    >{{ e.decision === 'APPROVE' ? 'Autorizada' : 'Recusada' }}</span
                  >
                  {{ e.decidedBy }} · {{ when(e.at) }} · <em>{{ e.reason }}</em>
                  <span class="text-muted">(pedida por {{ e.requestedBy }})</span>
                </li>
              }
            </ul>
          </section>
        }

        <app-attachments
          subjectType="purchase_invoice"
          [subjectId]="v.id"
          [canWrite]="v.can.edit || v.can.refuse"
        />

        <section class="card" aria-labelledby="id-history-title">
          <h2 id="id-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="id-history">
            @for (h of v.history; track $index) {
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
          entityType="purchase_invoice"
          [entityId]="v.id"
          [refreshKey]="v.version"
        />
      }
    </app-entity-form-page>

    <app-modal [title]="modalTitle()" [open]="kind() !== null" (closed)="kind.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="id-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="kind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="id-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class InvoiceDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Invoice | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly kind = signal<ReasonKind | null>(null);
  protected reason = '';
  protected readonly money = money;
  protected readonly creditStatus = (k: keyof typeof CREDIT_NOTE_STATUS) => CREDIT_NOTE_STATUS[k];
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = invoiceTone;
  protected readonly label = (s: Invoice['status']) => INVOICE_STATUS[s];
  protected readonly divergence = (c: DivergenceCode) => DIVERGENCE[c] ?? c;
  protected readonly event = (k: string) => INVOICE_EVENT[k] ?? k;
  protected readonly modalTitle = computed(
    () =>
      ({
        approve: 'Autorizar a excepção',
        reject: 'Recusar a excepção (volta a rascunho)',
        refuse: 'Devolver a factura ao fornecedor',
        cancel: 'Anular a factura',
      })[this.kind() ?? 'approve'],
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected messages(v: Invoice) {
    const out: string[] = [];
    if (v.validatedAt)
      out.push(`Validada por ${v.validatedBy ?? '—'} em ${formatDateTime(v.validatedAt)}.`);
    else if (v.submittedAt)
      out.push(
        `Conferência pedida por ${v.submittedBy ?? '—'} em ${formatDateTime(v.submittedAt)}.`,
      );
    if (v.rejectReason) out.push(`Devolvida: ${v.rejectReason}`);
    if (v.cancelReason) out.push(`Anulada: ${v.cancelReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<Invoice>(`procurement/invoices/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(v: Invoice) {
    this.x.set(v);
    this.breadcrumbs.setCurrent(v.invoiceNumber);
  }
  protected back() {
    void this.router.navigate(['/compras/facturas']);
  }

  protected async validate() {
    const v = this.x()!;
    const ok = await this.confirmSvc.ask({
      title: 'Validar a factura',
      message:
        'Confere com a ordem e o recebido: se estiver conforme fica validada; se houver divergências, vai para excepção.',
      confirmLabel: 'Validar',
    });
    if (!ok) return;
    const r = await this.act.run(() =>
      this.api.post<Invoice>(`procurement/invoices/${v.id}/validate`, {
        expectedVersion: v.version,
      }),
    );
    if (!r) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.set(r);
    this.toasts.show(
      r.status === 'VALIDATED'
        ? 'Factura validada.'
        : 'Conferência com divergências: excepção pedida.',
    );
  }

  protected ask(k: ReasonKind) {
    this.act.error.set(null);
    this.reason = '';
    this.kind.set(k);
  }

  protected async confirmReason() {
    const v = this.x()!;
    const k = this.kind()!;
    const r = await this.act.run(() =>
      this.api.post<Invoice>(`procurement/invoices/${v.id}/${k}`, {
        expectedVersion: v.version,
        reason: this.reason,
      }),
    );
    if (!r) return;
    this.set(r);
    this.kind.set(null);
    this.toasts.show(
      {
        approve: 'Excepção autorizada: factura validada.',
        reject: 'Excepção recusada: a factura voltou a rascunho.',
        refuse: 'Factura devolvida ao fornecedor.',
        cancel: 'Factura anulada.',
      }[k],
    );
  }
}
