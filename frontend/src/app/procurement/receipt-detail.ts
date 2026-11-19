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
import { type Receipt, RECEIPT_EVENT, RECEIPT_STATUS, receiptTone } from './receipt-model';
import { REMEDY, type Remedy, RETURN_STATUS, type ReturnStatus } from './return-model';

type ReasonKind = 'cancel' | 'reverse';

/**
 * Recepção de compra (9.7): estado, ordem e armazém, conferência por linha (aceite na unidade da ordem e na unidade
 * base, recusada com motivo, lote/validade/séries, custo de entrada), lançamento de stock gerado, confirmação, anulação
 * do rascunho e estorno, anexos, cronologia e auditoria.
 */
@Component({
  selector: 'app-receipt-detail',
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
      [title]="'Recepção ' + (x()?.number ?? '(rascunho)')"
      [subtitle]="x() ? x()!.supplier.code + ' — ' + x()!.supplier.name : ''"
      formId="receipt-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as r) {
        <section class="card space-y-3" aria-label="Estado" data-testid="rd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(r.status)" data-testid="rd-status">{{
              label(r.status)
            }}</span>
            <span class="text-sm text-muted">
              Ordem
              <a class="link" [routerLink]="['/compras/ordens', r.order.id]">{{
                r.order.number
              }}</a>
              · {{ date(r.receiptDate) }}
              @if (r.deliveryNote) {
                · guia {{ r.deliveryNote }}
              }
              ·
              {{
                r.warehouse
                  ? r.warehouse.code + ' — ' + r.warehouse.name
                  : 'sem armazém (só aceitação)'
              }}
            </span>
          </div>
          @for (m of messages(r); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (r.postingId) {
            <p class="text-sm" data-testid="rd-posting">
              Entrada no inventário registada (um lançamento de stock).
            </p>
          }
          @if (kind() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" data-testid="rd-error" />
          }
          <div class="flex flex-wrap gap-2">
            @if (r.can.edit) {
              <a
                class="btn-secondary"
                data-testid="rd-edit"
                [routerLink]="['/compras/recepcoes', r.id, 'editar']"
                >Editar</a
              >
            }
            @if (r.can.confirm) {
              <button
                type="button"
                class="btn-primary"
                data-testid="rd-confirm"
                (click)="confirm()"
              >
                Confirmar recepção
              </button>
            }
            @if (r.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-cancel"
                (click)="ask('cancel')"
              >
                Anular
              </button>
            }
            @if (r.can.reverse) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-reverse"
                (click)="ask('reverse')"
              >
                Estornar
              </button>
            }
            @if (r.can.return) {
              <a
                class="btn-secondary"
                data-testid="rd-return"
                routerLink="/compras/devolucoes/nova"
                [queryParams]="{ receiptId: r.id }"
                >Registar não conformidade</a
              >
            }
          </div>
          @if (r.returns.length) {
            <div data-testid="rd-returns">
              <h3 class="text-sm font-medium">Devoluções</h3>
              <ul class="text-sm">
                @for (d of r.returns; track d.id) {
                  <li>
                    <a class="link" [routerLink]="['/compras/devolucoes', d.id]">{{
                      d.number ?? 'Rascunho'
                    }}</a>
                    · {{ date(d.returnDate) }} · {{ returnStatus(d.status) }} ·
                    {{ remedy(d.remedy) }}
                  </li>
                }
              </ul>
            </div>
          }
        </section>

        <section class="card" aria-labelledby="rd-lines-title">
          <h2 id="rd-lines-title" class="mb-2 font-semibold">Conferência</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="rd-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Linha</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Aceite</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Recusada</th>
                  <th class="px-2 py-1">Lote / validade / séries</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Custo unitário</th>
                </tr>
              </thead>
              <tbody>
                @for (l of r.lines; track l.id) {
                  <tr class="border-t border-border align-top">
                    <td class="px-2 py-1">
                      {{ l.lineNo }} · {{ l.product ? l.product.sku + ' — ' : ''
                      }}{{ l.description }}
                      @if (!l.stocked) {
                        <span class="block text-xs text-muted">Sem stock (aceitação)</span>
                      }
                      @if (l.location) {
                        <span class="block text-xs text-muted">{{ l.location.path }}</span>
                      }
                    </td>
                    <td
                      class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                      data-testid="rd-qty"
                    >
                      {{ q(l.quantity) }} {{ l.uom ?? '' }}
                      @if (l.baseQuantity && l.uom !== l.baseUom) {
                        <span class="block text-xs text-muted"
                          >= {{ q(l.baseQuantity) }} {{ l.baseUom }}</span
                        >
                      }
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.rejectedQuantity) }}
                      @if (l.rejectReason) {
                        <span class="block text-xs text-muted">{{ l.rejectReason }}</span>
                      }
                    </td>
                    <td class="px-2 py-1">
                      {{ l.lotCode ?? '—' }}{{ l.expiryDate ? ' · ' + date(l.expiryDate) : '' }}
                      @if (l.serials.length) {
                        <span class="block text-xs text-muted">{{ l.serials.join(', ') }}</span>
                      }
                    </td>
                    <td
                      class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                      data-testid="rd-cost"
                    >
                      {{ l.unitCost === null ? '—' : money(l.unitCost, null) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-xs text-muted">
            Custo de entrada por unidade base, em moeda funcional, sem impostos.
          </p>
        </section>

        <app-attachments
          subjectType="purchase_receipt"
          [subjectId]="r.id"
          [canWrite]="r.can.edit || r.can.reverse"
        />

        <section class="card" aria-labelledby="rd-history-title">
          <h2 id="rd-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="rd-history">
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
          entityType="purchase_receipt"
          [entityId]="r.id"
          [refreshKey]="r.version"
        />
      }
    </app-entity-form-page>

    <app-modal
      [title]="kind() === 'reverse' ? 'Estornar a recepção' : 'Anular o rascunho'"
      [open]="kind() !== null"
      (closed)="kind.set(null)"
    >
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      @if (kind() === 'reverse') {
        <p class="mb-3 text-sm text-muted">
          O lançamento de stock é estornado e as quantidades voltam a estar em falta na ordem.
        </p>
      }
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="rd-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="kind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rd-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class ReceiptDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Receipt | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly kind = signal<ReasonKind | null>(null);
  protected reason = '';
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = receiptTone;
  protected readonly label = (s: Receipt['status']) => RECEIPT_STATUS[s];
  protected readonly event = (k: string) => RECEIPT_EVENT[k] ?? k;
  protected readonly returnStatus = (k: string) => RETURN_STATUS[k as ReturnStatus] ?? k;
  protected readonly remedy = (k: string) => REMEDY[k as Remedy] ?? k;

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected messages(r: Receipt) {
    const out: string[] = [];
    if (r.confirmedAt)
      out.push(`Confirmada por ${r.confirmedBy ?? '—'} em ${formatDateTime(r.confirmedAt)}.`);
    if (r.reversedAt)
      out.push(
        `Estornada por ${r.reversedBy ?? '—'} em ${formatDateTime(r.reversedAt)}: ${r.reversalReason}`,
      );
    if (r.cancelReason) out.push(`Anulada: ${r.cancelReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<Receipt>(`procurement/receipts/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(r: Receipt) {
    this.x.set(r);
    this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/compras/recepcoes']);
  }

  protected async confirm() {
    const r = this.x()!;
    const ok = await this.confirmSvc.ask({
      title: 'Confirmar a recepção',
      message: r.warehouse
        ? `Recebe número; os bens entram no armazém ${r.warehouse.code} num único lançamento e a ordem ${r.order.number} fica actualizada.`
        : `Recebe número e as linhas ficam aceites na ordem ${r.order.number} (sem stock).`,
      confirmLabel: 'Confirmar',
    });
    if (!ok) return;
    const res = await this.act.run(() =>
      this.api.post<Receipt>(`procurement/receipts/${r.id}/confirm`, {
        expectedVersion: r.version,
      }),
    );
    if (!res) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.set(res);
    this.toasts.show('Recepção confirmada.');
  }

  protected ask(k: ReasonKind) {
    this.act.error.set(null);
    this.reason = '';
    this.kind.set(k);
  }

  protected async confirmReason() {
    const r = this.x()!;
    const k = this.kind()!;
    const res = await this.act.run(() =>
      this.api.post<Receipt>(`procurement/receipts/${r.id}/${k}`, {
        expectedVersion: r.version,
        reason: this.reason,
      }),
    );
    if (!res) return;
    this.set(res);
    this.kind.set(null);
    this.toasts.show(k === 'reverse' ? 'Recepção estornada.' : 'Rascunho anulado.');
  }
}
