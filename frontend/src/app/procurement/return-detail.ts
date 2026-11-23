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
  CREDIT_STATUS,
  creditTone,
  type PurchaseReturn,
  REMEDY,
  RETURN_EVENT,
  RETURN_REASON,
  RETURN_SOURCE,
  RETURN_STATUS,
  returnTone,
  STOCK_BUCKET,
} from './return-model';
import { CREDIT_NOTE_STATUS, type CreditNoteStatus } from './credit-note-model';

/**
 * Devolução a fornecedor / não conformidade (9.9): estado e crédito, recepção e ordem de origem, motivo e solução,
 * linhas (aceite que sai do stock ou recusado), evidências (obrigatórias para confirmar; só em rascunho), confirmação
 * com saída do inventário, anulação do rascunho, crédito pendente e notas de crédito, cronologia e auditoria.
 */
@Component({
  selector: 'app-return-detail',
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
      [title]="'Devolução ' + (x()?.number ?? '(rascunho)')"
      [subtitle]="x() ? x()!.supplier.code + ' — ' + x()!.supplier.name : ''"
      formId="return-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as r) {
        <section class="card space-y-3" aria-label="Estado" data-testid="dv-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(r.status)" data-testid="dv-status">{{
              status(r.status)
            }}</span>
            @if (r.status === 'CONFIRMED') {
              <span class="badge" [class]="ctone(r.creditStatus)" data-testid="dv-credit">{{
                credit(r.creditStatus)
              }}</span>
            }
            <span class="text-sm text-muted">
              Recepção
              <a class="link" [routerLink]="['/compras/recepcoes', r.receipt.id]">{{
                r.receipt.number
              }}</a>
              · ordem
              <a class="link" [routerLink]="['/compras/ordens', r.order.id]">{{
                r.order.number
              }}</a>
              · {{ date(r.returnDate) }}
              @if (r.carrierRef) {
                · guia {{ r.carrierRef }}
              }
            </span>
          </div>
          <dl class="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-muted">Motivo</dt>
              <dd data-testid="dv-reason">{{ reason(r.reasonCode) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Solução pedida</dt>
              <dd data-testid="dv-remedy">{{ remedy(r.remedy) }}</dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-muted">Descrição</dt>
              <dd class="whitespace-pre-line">{{ r.description }}</dd>
            </div>
          </dl>
          @for (m of messages(r); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (r.postingId) {
            <p class="text-sm" data-testid="dv-posting">
              Saída do inventário registada (um lançamento de stock, ao custo da recepção).
            </p>
          }
          @if (r.status === 'DRAFT') {
            <p
              class="text-sm"
              [class.text-warning-text]="r.evidenceCount === 0"
              [class.text-muted]="r.evidenceCount > 0"
              data-testid="dv-evidence"
            >
              {{
                r.evidenceCount === 0
                  ? 'Sem evidências: junte pelo menos uma (fotografia, relatório de inspecção, guia) para confirmar.'
                  : r.evidenceCount + ' evidência(s) junta(s).'
              }}
            </p>
          }
          @if (!cancelOpen() && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" data-testid="dv-error" />
          }
          <div class="flex flex-wrap gap-2">
            @if (r.can.edit) {
              <a
                class="btn-secondary"
                data-testid="dv-edit"
                [routerLink]="['/compras/devolucoes', r.id, 'editar']"
                >Editar</a
              >
            }
            @if (r.can.confirm) {
              <button
                type="button"
                class="btn-primary"
                data-testid="dv-confirm"
                [disabled]="r.evidenceCount === 0"
                (click)="confirm()"
              >
                Confirmar devolução
              </button>
            }
            @if (r.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="dv-cancel"
                (click)="cancelOpen.set(true)"
              >
                Anular
              </button>
            }
            @if (r.can.credit) {
              @for (i of r.invoices; track i.id) {
                <a
                  class="btn-secondary"
                  data-testid="dv-credit-new"
                  routerLink="/compras/notas-credito/nova"
                  [queryParams]="{ invoiceId: i.id, returnId: r.id }"
                  >Nota de crédito da factura {{ i.number }}</a
                >
              }
            }
          </div>
        </section>

        <section class="card" aria-labelledby="dv-lines-title">
          <h2 id="dv-lines-title" class="mb-2 font-semibold">O que volta ao fornecedor</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="dv-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Linha</th>
                  <th class="px-2 py-1">Origem</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                  <th class="px-2 py-1">Stock / lote / séries</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Por creditar</th>
                </tr>
              </thead>
              <tbody>
                @for (l of r.lines; track l.id) {
                  <tr class="border-t border-border align-top">
                    <td class="px-2 py-1">
                      {{ l.orderLineNo }} · {{ l.product ? l.product.sku + ' — ' : ''
                      }}{{ l.description }}
                      @if (l.notes) {
                        <span class="block text-xs text-muted">{{ l.notes }}</span>
                      }
                    </td>
                    <td class="px-2 py-1">{{ source(l.source) }}</td>
                    <td
                      class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                      data-testid="dv-qty"
                    >
                      {{ q(l.quantity) }} {{ l.uom ?? '' }}
                      @if (l.baseQuantity && l.uom !== l.baseUom) {
                        <span class="block text-xs text-muted"
                          >= {{ q(l.baseQuantity) }} {{ l.baseUom }}</span
                        >
                      }
                    </td>
                    <td class="px-2 py-1">
                      @if (l.stocked) {
                        {{ bucket(l.bucket) }}{{ l.location ? ' · ' + l.location.path : ''
                        }}{{ l.lotCode ? ' · lote ' + l.lotCode : '' }}
                        @if (l.serials.length) {
                          <span class="block text-xs text-muted">{{ l.serials.join(', ') }}</span>
                        }
                      } @else {
                        <span class="text-muted">Sem stock</span>
                      }
                    </td>
                    <td
                      class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                      data-testid="dv-credit-qty"
                    >
                      @if (r.status === 'CONFIRMED') {
                        {{ q(l.creditedQuantity) }} / {{ q(l.creditQuantity) }}
                      } @else {
                        —
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-xs text-muted">
            Por creditar: o que já estava facturado e o fornecedor tem de creditar (creditado / a
            creditar).
          </p>
        </section>

        @if (r.creditNotes.length) {
          <section class="card" aria-labelledby="dv-cn-title" data-testid="dv-credit-notes">
            <h2 id="dv-cn-title" class="mb-2 font-semibold">Notas de crédito</h2>
            <ul class="space-y-1 text-sm">
              @for (c of r.creditNotes; track c.id) {
                <li>
                  <a class="link" [routerLink]="['/compras/notas-credito', c.id]">{{
                    c.number ?? 'Rascunho'
                  }}</a>
                  · {{ c.creditNoteNumber }} · {{ date(c.creditNoteDate) }} ·
                  {{ money(c.totalAmount, c.currency) }} · {{ noteStatus(c.status) }}
                </li>
              }
            </ul>
          </section>
        }

        <div data-testid="dv-attachments">
          <app-attachments
            subjectType="purchase_return"
            [subjectId]="r.id"
            [canWrite]="r.can.edit"
            (changed)="load()"
          />
        </div>

        <section class="card" aria-labelledby="dv-history-title">
          <h2 id="dv-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="dv-history">
            @for (h of r.history; track $index) {
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
          entityType="purchase_return"
          [entityId]="r.id"
          [refreshKey]="r.version"
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
          data-testid="dv-reason-text"
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
          data-testid="dv-reason-ok"
          [disabled]="act.busy()"
          (click)="cancelDraft()"
        >
          Anular
        </button>
      </div>
    </app-modal>
  `,
})
export class ReturnDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<PurchaseReturn | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly cancelOpen = signal(false);
  protected reasonText = '';
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = returnTone;
  protected readonly ctone = creditTone;
  protected readonly status = (s: PurchaseReturn['status']) => RETURN_STATUS[s];
  protected readonly credit = (s: PurchaseReturn['creditStatus']) => CREDIT_STATUS[s];
  protected readonly reason = (s: PurchaseReturn['reasonCode']) => RETURN_REASON[s] ?? s;
  protected readonly remedy = (s: PurchaseReturn['remedy']) => REMEDY[s];
  protected readonly source = (s: 'ACCEPTED' | 'REFUSED') => RETURN_SOURCE[s];
  protected readonly bucket = (s: string | null) =>
    s ? (STOCK_BUCKET[s as keyof typeof STOCK_BUCKET] ?? s) : '—';
  protected readonly noteStatus = (s: string) => CREDIT_NOTE_STATUS[s as CreditNoteStatus] ?? s;
  protected readonly event = (k: string) => RETURN_EVENT[k] ?? k;

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected messages(r: PurchaseReturn) {
    const out: string[] = [];
    if (r.confirmedAt)
      out.push(`Confirmada por ${r.confirmedBy ?? '—'} em ${formatDateTime(r.confirmedAt)}.`);
    if (r.cancelReason) out.push(`Anulada: ${r.cancelReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<PurchaseReturn>(`procurement/returns/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(r: PurchaseReturn) {
    this.x.set(r);
    this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/compras/devolucoes']);
  }

  protected async confirm() {
    const r = this.x()!;
    const stocked = r.lines.some((l) => l.stocked);
    const ok = await this.confirmSvc.ask({
      title: 'Confirmar a devolução',
      message:
        (stocked
          ? `Recebe número e o que estava em stock sai do armazém ${r.warehouse?.code ?? ''} num único lançamento. `
          : 'Recebe número (nada sai do stock). ') +
        (r.remedy === 'CREDIT'
          ? `A ordem ${r.order.number} deixa de esperar estas quantidades; o que já estava facturado fica por creditar.`
          : `A ordem ${r.order.number} volta a esperar a substituição.`),
      confirmLabel: 'Confirmar',
    });
    if (!ok) return;
    const res = await this.act.run(() =>
      this.api.post<PurchaseReturn>(`procurement/returns/${r.id}/confirm`, {
        expectedVersion: r.version,
      }),
    );
    if (!res) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.set(res);
    this.toasts.show('Devolução confirmada.');
  }

  protected async cancelDraft() {
    const r = this.x()!;
    const res = await this.act.run(() =>
      this.api.post<PurchaseReturn>(`procurement/returns/${r.id}/cancel`, {
        expectedVersion: r.version,
        reason: this.reasonText,
      }),
    );
    if (!res) return;
    this.set(res);
    this.cancelOpen.set(false);
    this.toasts.show('Rascunho anulado.');
  }
}
